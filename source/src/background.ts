import {
  CONFIG_KEY,
  DEFAULTS,
  OLD_ID,
  configFrom,
  normalizeLang,
  publicConfig,
  requireValue,
  sha256,
  type Config,
  type CacheInput,
  type Trace,
} from "./types";
import { newTrace, childTrace, validTrace, sanitizeTrace } from "./trace";
import { storage, record, recordBatch } from "./storage-client";
import { fetchRelease } from "./releases";
import {
  translateRouted,
  localModels,
  invalidateLocalStatusCache,
} from "./local-provider";
import {
  setActiveTabs,
  cancelQueuedForTab,
  type SchedulePriority,
} from "./network";
import { readUsageStore, clearUsageStore } from "./usage";
import {
  syncDictionaryToManager,
  clearSyncedDictionaryInManager,
} from "./sync-client";

const ready = chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
});

const own = (s: chrome.runtime.MessageSender) =>
  s.id === chrome.runtime.id && !!s.url?.startsWith(chrome.runtime.getURL(""));

const origin = (s: chrome.runtime.MessageSender) => {
  try {
    const u = new URL(s.url || s.tab?.url || "");
    if (/^https?:$/.test(u.protocol)) return u.origin;
    if (u.protocol === "file:") return "file://";
    if (u.protocol === "chrome-extension:") return u.origin;
    return "";
  } catch {
    return "";
  }
};

// Track active foreground tabs per browser window for priority scheduling (Q-00).
const windowActiveTab = new Map<number, number>();
async function refreshActiveTabs() {
  try {
    const tabs = await chrome.tabs.query({ active: true });
    windowActiveTab.clear();
    for (const tab of tabs) {
      if (tab.windowId !== undefined && tab.id !== undefined) {
        windowActiveTab.set(tab.windowId, tab.id);
      }
    }
    setActiveTabs(windowActiveTab.values());
  } catch {
    // ignore startup query race
  }
}
void refreshActiveTabs();

function isTabActive(tabId: number): boolean {
  if (!windowActiveTab.size) return true;
  for (const activeId of windowActiveTab.values()) {
    if (activeId === tabId) return true;
  }
  return false;
}

export interface SiteRule {
  mode?: "auto" | "never" | "default";
  display?: "chinese" | "bilingual";
  routing?: "local-first" | "local-only" | "cloud-only";
  model?: string;
  sourceLang?: string;
  targetLang?: string;
  skipSelector?: string;
  articleOnly?: boolean;
}

function normalizeSiteRules(
  rawSites: unknown,
  rawRules: unknown,
): Record<string, SiteRule> {
  const merged: Record<string, SiteRule> = {};
  if (rawSites && typeof rawSites === "object") {
    for (const [k, v] of Object.entries(rawSites as Record<string, unknown>)) {
      if (v === true) merged[k] = { mode: "auto" };
    }
  }
  if (rawRules && typeof rawRules === "object") {
    for (const [k, v] of Object.entries(rawRules as Record<string, any>)) {
      if (v && typeof v === "object") {
        merged[k] = { ...merged[k], ...v };
      }
    }
  }
  return merged;
}

async function config() {
  await ready;
  return configFrom(
    (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {},
    DEFAULTS,
  );
}

async function effectiveConfigForDomain(
  base: Config,
  domain: string,
): Promise<{
  config: Config;
  rule?: SiteRule;
}> {
  const d = await chrome.storage.local.get(["sites", "site.rules"]);
  const rules = normalizeSiteRules(d.sites, d["site.rules"]);
  const rule = rules[domain];
  if (!rule) return { config: base };
  return {
    config: {
      ...base,
      ...(rule.display ? { mode: rule.display } : {}),
      ...(rule.routing ? { routing: rule.routing } : {}),
      ...(rule.model?.trim() ? { model: rule.model.trim() } : {}),
      ...(rule.targetLang
        ? { targetLang: normalizeLang(rule.targetLang) }
        : {}),
    },
    rule,
  };
}

async function context(m: any, s: chrome.runtime.MessageSender) {
  const dom = origin(s);
  requireValue((dom && s.tab?.id !== undefined) || own(s), "WEB_PAGE_REQUIRED");
  requireValue(validTrace(m.trace), "INVALID_TRACE");
  requireValue(
    Array.isArray(m.sources) &&
      m.sources.length > 0 &&
      m.sources.length <= 16 &&
      m.sources.every(
        (v: unknown) =>
          typeof v === "string" && v.length > 0 && v.length <= 24000,
      ) &&
      m.sources.join("").length <= 26000,
    "BATCH_LIMIT",
  );
  const baseConfig = await config();
  const domain = m.domain || dom || "https://qingyi.local";
  const { config: c, rule } = await effectiveConfigForDomain(
    baseConfig,
    domain,
  );
  const sourceLang = normalizeLang(
    rule?.sourceLang ||
      (/^[a-z_-]{1,20}$/i.test(m.sourceLang || "") ? m.sourceLang : "auto"),
  );
  const targetLang = normalizeLang(m.targetLang || c.targetLang || "zh-CN");
  return {
    c: { ...c, targetLang },
    inputs: (m.sources as string[]).map(
      (source): CacheInput => ({
        source,
        domain,
        scope: "",
        sourceLang,
        targetLang,
      }),
    ),
    t: m.trace as Trace,
  };
}

type Shared = {
  owner: Trace;
  promise: Promise<{
    translation: string;
    channel: "local" | "cloud" | "cache";
  }>;
  resolve: (v: {
    translation: string;
    channel: "local" | "cloud" | "cache";
  }) => void;
  reject: (e: Error) => void;
  consumers: Set<string>;
  controller: AbortController;
};

const inflight = new Map<string, Shared>();
const activeUiOps = new Map<string, AbortController>();

// Dictionary + revision + legacy lookup without dead duplicate model-table query (Q-T22, Q-T23).
async function lookup(inputs: CacheInput[], c: Config, t: Trace) {
  const result = await storage("lookup", [inputs, true], t);
  const missing = inputs
    .map((input, i) =>
      !result.translations[i] && !input.source.includes("__QY") ? i : -1,
    )
    .filter((i) => i >= 0);
  if (!missing.length) return result;

  // Read migrated legacy v2 caches in all routing modes (Q-T23).
  const data = await chrome.storage.local.get("migration.legacy");
  const buckets = data["migration.legacy"] || {};
  const key =
    "cache:" +
    (await sha256(
      JSON.stringify([inputs[0].domain, c.apiUrl, c.model, "prompt.v2"]),
    ));
  const bucket = buckets[key];
  if (!bucket || bucket.origin !== inputs[0].domain) return result;
  const legacy = await storage(
    "lookupModels",
    [
      missing.map((i) => ({
        ...inputs[i],
        scope: bucket.scope,
        sourceLang: "auto",
      })),
    ],
    t,
  );
  missing.forEach((index, n) => {
    if (legacy.translations[n]) {
      result.translations[index] = legacy.translations[n];
      result.sources[index] = "legacy-model";
      result.hits++;
    }
  });
  return result;
}

const jobs = new Map<
  string,
  {
    tab: number;
    frame: number;
    session: string;
    controller: AbortController;
    shared: Shared[];
    trace: Trace;
  }
>();

function cancel(tab: number, session?: string, reason = "page-or-user-cancel") {
  if (!session) cancelQueuedForTab(tab);
  for (const [id, job] of jobs)
    if (job.tab === tab && (!session || job.session === session)) {
      job.controller.abort();
      for (const item of job.shared) {
        item.consumers.delete(id);
        if (
          ![...inflight.values()].some(
            (v) => v.controller === item.controller && v.consumers.size,
          )
        )
          item.controller.abort();
      }
      record(job.trace, "operation.cancel", {
        outcome: "cancelled",
        reason,
      });
    }
}

async function translate(m: any, s: chrome.runtime.MessageSender) {
  const { c, inputs, t } = await context(m, s);
  const tabId = s.tab?.id ?? 0;
  const requestedPrio: SchedulePriority =
    m.priority === 0 || m.priority === 1 || m.priority === 2 || m.priority === 3
      ? m.priority
      : 2;
  const effectivePrio: SchedulePriority =
    requestedPrio === 0 ? 0 : tabId && !isTabActive(tabId) ? 3 : requestedPrio;

  record(t, "batch.translate.start", {
    outcome: "started",
    items: inputs.length,
  });

  // Skip dictionary lookup when content.ts already ran LOOKUP for this batch (Q-T22).
  const cached = m.skipLookup
    ? {
        translations: new Array(inputs.length).fill(null),
        sources: new Array(inputs.length).fill("miss"),
        hits: 0,
      }
    : await lookup(inputs, c, t);
  const values: (string | null)[] = [...cached.translations];
  const channels: ("local" | "cloud" | "cache")[] = values.map(() => "cache");
  const itemErrors: (string | undefined)[] = new Array(inputs.length);
  const missing = inputs
    .map((_, i) => (values[i] === null ? i : -1))
    .filter((i) => i >= 0);
  if (!missing.length) {
    record(childTrace(t), "batch.complete", {
      outcome: "success",
      items: inputs.length,
      hits: cached.hits,
    });
    return {
      translations: values,
      channels,
      hits: cached.hits,
      requests: 0,
      trace: t,
    };
  }

  const id = crypto.randomUUID(),
    controller = new AbortController(),
    job = {
      tab: tabId,
      frame: s.frameId || 0,
      session: t.sessionId || "",
      controller,
      shared: [] as Shared[],
      trace: t,
    };
  jobs.set(id, job);
  if (own(s) && typeof m.opId === "string") activeUiOps.set(m.opId, controller);
  const fresh: { key: string; index: number; shared: Shared }[] = [];
  let requests = 0;
  let providerHits = 0;
  let cacheWarning = false;

  const promises = await Promise.all(
    missing.map(async (index) => {
      const input = inputs[index],
        key = await sha256(
          JSON.stringify([
            input,
            c.routing,
            c.apiUrl,
            c.model,
            c.localUrl,
            c.localModel,
            c.serviceType || "chat",
          ]),
        );
      let item = inflight.get(key);
      if (!item) {
        let resolve!: (v: {
            translation: string;
            channel: "local" | "cloud" | "cache";
          }) => void,
          reject!: (e: Error) => void;
        const promise = new Promise<{
          translation: string;
          channel: "local" | "cloud" | "cache";
        }>((r, j) => {
          resolve = r;
          reject = j;
        });
        promise.catch(() => {});
        item = {
          owner: t,
          promise,
          resolve,
          reject,
          consumers: new Set(),
          controller: new AbortController(),
        };
        inflight.set(key, item);
        fresh.push({ key, index, shared: item });
      } else {
        record(childTrace(t), "queue.coalesced", {
          outcome: "success",
          items: 1,
          resourceId: item.owner.traceId,
          source: "producer-trace",
        });
      }
      item.consumers.add(id);
      job.shared.push(item);
      return { index, promise: item.promise };
    }),
  );

  if (controller.signal.aborted) {
    for (const item of job.shared) item.consumers.delete(id);
    for (const item of fresh) {
      item.shared.reject(Error("CANCELLED"));
      inflight.delete(item.key);
    }
    jobs.delete(id);
    throw Error("CANCELLED");
  }

  if (fresh.length) {
    const groupController = new AbortController();
    for (const entry of fresh) {
      entry.shared.controller = groupController;
    }
    if (tabId) {
      void chrome.tabs
        .sendMessage(
          tabId,
          { type: "PROGRESS", traceId: t.traceId, state: "queue" },
          { frameId: s.frameId || 0 },
        )
        .catch(() => {});
    }
    void (async () => {
      const routed = await translateRouted(
        c,
        fresh.map((v) => inputs[v.index]),
        t,
        groupController.signal,
        (phase = "request") => {
          if (phase === "request") requests++;
          if (tabId) {
            void chrome.tabs
              .sendMessage(
                tabId,
                {
                  type: "PROGRESS",
                  traceId: t.traceId,
                  batchId: t.batchId,
                  requests,
                  state: phase,
                },
                { frameId: s.frameId || 0 },
              )
              .catch(() => {});
          }
        },
        {
          priority: effectivePrio,
          tabId: tabId || undefined,
          allowPartial: true,
          persistImmediately: false,
        },
      );
      if (routed.entries.length) {
        const buffered = await storage("enqueue", [routed.entries], t).catch(
          () => {
            cacheWarning = true;
            record(childTrace(t), "cache.buffer", {
              outcome: "failed",
              reason: "CACHE_WRITE_PAUSED",
            });
          },
        );
        if (buffered?.writeError) cacheWarning = true;
      }
      providerHits += routed.hits;
      fresh.forEach((v, i) => {
        const translated = routed.translations[i];
        if (translated !== null && translated !== undefined) {
          v.shared.resolve({
            translation: translated,
            channel: routed.channels[i] || "cloud",
          });
        } else {
          v.shared.reject(
            new Error(routed.errors?.[i] || "TRANSLATION_FAILED"),
          );
        }
      });
    })()
      .catch((error) => fresh.forEach((v) => v.shared.reject(error)))
      .finally(() => fresh.forEach((v) => inflight.delete(v.key)));
  }

  try {
    const settled = await Promise.race([
      Promise.allSettled(
        promises.map(async (p) => {
          const out = await p.promise;
          values[p.index] = out.translation;
          channels[p.index] = out.channel;
        }),
      ),
      new Promise<never>((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(Error("CANCELLED")),
          { once: true },
        ),
      ),
    ]);
    requireValue(!controller.signal.aborted, "CANCELLED");

    settled.forEach((res, idx) => {
      if (res.status === "rejected") {
        const origIndex = promises[idx].index;
        itemErrors[origIndex] =
          res.reason instanceof Error
            ? res.reason.message
            : String(res.reason || "TRANSLATION_FAILED");
      }
    });

    const anySuccess = values.some((v) => v !== null);
    if (!anySuccess) {
      const firstErr = itemErrors.find(Boolean) || "TRANSLATION_FAILED";
      throw new Error(firstErr);
    }

    const failedCount = values.filter((v) => v === null).length;
    record(childTrace(t), "batch.complete", {
      outcome: failedCount ? "fallback" : "success",
      items: inputs.length,
      hits: cached.hits + providerHits,
      ...(failedCount ? { reason: "PARTIAL_BATCH_SUCCESS" } : {}),
    });
    return {
      translations: values,
      errors: itemErrors,
      channels,
      hits: cached.hits + providerHits,
      requests,
      cacheWarning,
      trace: t,
    };
  } finally {
    jobs.delete(id);
    if (own(s) && typeof m.opId === "string") activeUiOps.delete(m.opId);
    for (const item of job.shared) item.consumers.delete(id);
  }
}

let settingTail = Promise.resolve();
async function registerSite(url: string, mode: "auto" | "never" | "default") {
  const id = "qingyi-" + (await sha256(url)).slice(0, 20);
  await chrome.scripting
    .unregisterContentScripts({ ids: [id, id + "-shadow"] })
    .catch(() => {});
  // "never" sites never get scripts registered or injected (Prompt item 13).
  if (
    mode === "auto" &&
    (await chrome.permissions.contains({ origins: [url + "/*"] }))
  ) {
    await chrome.scripting.registerContentScripts([
      {
        id: id + "-shadow",
        matches: [url + "/*"],
        js: ["shadow-hook.js"],
        allFrames: true,
        runAt: "document_start",
        world: "MAIN",
        persistAcrossSessions: true,
      },
      {
        id,
        matches: [url + "/*"],
        js: ["content.js"],
        allFrames: true,
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  }
}

async function handle(m: any, s: chrome.runtime.MessageSender): Promise<any> {
  await ready;
  requireValue(s.id === chrome.runtime.id, "INVALID_SENDER");
  const trusted = own(s);
  switch (m.type) {
    case "PUBLIC": {
      const base = await config(),
        dom = m.domain || origin(s),
        data = await chrome.storage.local.get([
          "sites",
          "site.rules",
          "ui.progressVisible",
          "ui.theme",
          "ui.position",
          "ui.locale",
          "ui.translationStyle",
        ]);
      const rules = normalizeSiteRules(data.sites, data["site.rules"]);
      const siteRule = rules[dom];
      const { config: c } = await effectiveConfigForDomain(base, dom);
      return {
        ...publicConfig(c),
        revision: await sha256(
          JSON.stringify([
            c.apiUrl,
            c.model,
            c.routing,
            c.localUrl,
            c.localModel,
            c.localBackend,
            c.localAutoStart,
            c.targetLang || "zh-CN",
            c.serviceType || "chat",
          ]),
        ),
        auto: siteRule?.mode === "auto",
        never: siteRule?.mode === "never",
        siteRule: siteRule || null,
        progressVisible: data["ui.progressVisible"] !== false,
        theme: data["ui.theme"] || "system",
        position: data["ui.position"],
        locale: data["ui.locale"] || "",
        translationStyle: data["ui.translationStyle"] || null,
      };
    }
    case "TRACE":
      requireValue(validTrace(m.trace), "INVALID_TRACE");
      record(m.trace, m.event, { ...sanitizeTrace(m.fields || {}) });
      return {};
    case "TRACE_BATCH": {
      if (Array.isArray(m.events) && m.events.length <= 256) {
        const cleaned = m.events
          .filter(
            (item: any) =>
              validTrace(item?.trace) && typeof item?.event === "string",
          )
          .map((item: any) => ({
            trace: item.trace as Trace,
            event: String(item.event).slice(0, 80),
            fields: sanitizeTrace(item.fields || {}),
          }));
        recordBatch(cleaned);
      }
      return {};
    }
    case "LOOKUP": {
      const { inputs, c, t } = await context(m, s);
      return lookup(inputs, c, t);
    }
    case "TRANSLATE":
      return translate(m, s);
    case "SAVE_REVISION": {
      // Allows in-page selection popover & inline revision editor to save user revisions directly (Prompt items 7 & 13).
      const dom = origin(s);
      requireValue(
        (dom && s.tab?.id !== undefined) || trusted,
        "WEB_PAGE_REQUIRED",
      );
      const t = validTrace(m.trace) ? m.trace : newTrace();
      const base = await config();
      const entry = {
        source: String(m.source || ""),
        translation: String(m.translation || ""),
        domain: String(m.domain ?? dom ?? "*"),
        sourceLang: normalizeLang(m.sourceLang || "auto"),
        targetLang: normalizeLang(m.targetLang || base.targetLang || "zh-CN"),
        scope: "",
      };
      const saved = await storage("revision", [entry], t);
      if (base.syncDictionary) {
        void syncDictionaryToManager(base, t).catch(() => {});
      }
      return saved;
    }
    case "CANCEL":
      if (s.tab?.id !== undefined) cancel(s.tab.id, m.session);
      return {};
    case "TAB_VISIBILITY":
      if (s.tab?.id !== undefined && m.hidden) {
        cancelQueuedForTab(s.tab.id);
      }
      return {};
    case "OPEN_SETTINGS": {
      const t = validTrace(m.trace) ? childTrace(m.trace) : newTrace();
      record(t, "settings.open.start", { outcome: "started" });
      try {
        const hash =
          typeof m.section === "string" && m.section ? "#" + m.section : "";
        await chrome.tabs.create({
          url: chrome.runtime.getURL("options.html") + hash,
          ...(s.tab?.windowId !== undefined
            ? { windowId: s.tab.windowId }
            : {}),
          active: true,
        });
        record(t, "settings.open.end", { outcome: "success" });
        return {};
      } catch (e) {
        record(t, "settings.open.end", {
          outcome: "failed",
          reason: "SETTINGS_OPEN_FAILED",
        });
        throw e;
      }
    }
    case "POSITION":
      requireValue(
        Number.isFinite(m.x) &&
          Number.isFinite(m.y) &&
          m.x >= 0 &&
          m.x <= 1 &&
          m.y >= 0 &&
          m.y <= 1,
        "INVALID_POSITION",
      );
      return chrome.storage.local.set({ "ui.position": { x: m.x, y: m.y } });
  }

  requireValue(trusted, "OPTIONS_PAGE_REQUIRED");
  if (m.type === "CANCEL_OP") {
    if (typeof m.opId === "string") {
      activeUiOps.get(m.opId)?.abort();
      activeUiOps.delete(m.opId);
    }
    return { cancelled: true };
  }

  // Avoid polluting trace pagination when reading diagnostics (Q-02).
  if (m.type === "TRACE_READ") {
    const t = validTrace(m.trace) ? m.trace : newTrace();
    return storage(
      "trace.read",
      [
        m.traceId,
        m.batchId,
        m.limit === undefined
          ? undefined
          : Math.max(1, Math.min(200, Number(m.limit) || 200)),
        Math.max(0, Number(m.offset) || 0),
      ],
      t,
    );
  }

  const t = validTrace(m.trace) ? m.trace : newTrace();
  record(t, "operation.start", { outcome: "started", resourceId: m.type });
  const uiController = new AbortController();
  if (typeof m.opId === "string") activeUiOps.set(m.opId, uiController);

  try {
    let result;
    switch (m.type) {
      case "LOCAL_MODELS": {
        requireValue(validTrace(m.trace), "INVALID_TRACE");
        const c = configFrom(m.config || {}, await config());
        result = await localModels(c, m.trace);
        break;
      }
      case "PRIVATE": {
        const stored = await chrome.storage.local.get([
          "sites",
          "site.rules",
          "ui.progressVisible",
          "ui.theme",
          "ui.locale",
          "ui.translationStyle",
          "migration.result",
          "sync.status",
        ]);
        result = {
          ...publicConfig(await config()),
          ...stored,
          siteRules: normalizeSiteRules(stored.sites, stored["site.rules"]),
        };
        break;
      }
      case "SAVE": {
        const run = settingTail
          .catch(() => {})
          .then(async () => {
            const prev = await config();
            const c = configFrom(m.config, prev);
            await chrome.storage.local.set({ [CONFIG_KEY]: c });
            const loaded = await config();
            requireValue(
              JSON.stringify(loaded) === JSON.stringify(c),
              "CONFIG_VERIFY_FAILED",
            );
            invalidateLocalStatusCache();
            const translationKeys: (keyof Config)[] = [
              "apiUrl",
              "apiKey",
              "model",
              "routing",
              "localUrl",
              "localToken",
              "localModel",
              "localBackend",
              "localAutoStart",
              "intervalMs",
              "timeoutMs",
              "concurrency",
              "batch",
              "targetLang",
              "serviceType",
              "deeplUrl",
              "deeplKey",
            ];
            const changedTranslation = translationKeys.some(
              (key) => key in m.config && prev[key] !== loaded[key],
            );
            if (changedTranslation) {
              const affectedTabs = new Set<number>();
              for (const job of jobs.values()) {
                affectedTabs.add(job.tab);
                cancel(job.tab, undefined, "config-updated");
              }
              for (const tabId of affectedTabs) {
                void chrome.tabs
                  .sendMessage(tabId, {
                    type: "CONTROL",
                    command: "config-updated",
                  })
                  .catch(() => {});
              }
            }
            await storage("setBudget", [c.budgetBytes], t);
            return publicConfig(loaded);
          });
        settingTail = run.then(() => {});
        result = await run;
        break;
      }
      case "TEST": {
        const c = configFrom(m.config, await config());
        const batch = childTrace(t, { batchId: crypto.randomUUID() });
        record(batch, "batch.start", { outcome: "started", items: 1 });
        const routed = await translateRouted(
          c,
          [
            {
              source: "Hello.",
              scope: "",
              domain: "https://qingyi.test",
              sourceLang: "en",
              targetLang: c.targetLang || "zh-CN",
            },
          ],
          batch,
          uiController.signal,
          () => {},
        );
        result = {
          connected: true,
          channel: routed.channels[0],
          translation: routed.translations[0],
          localFallbackReason: routed.localFallbackReason,
        };
        break;
      }
      case "PREFERENCES": {
        requireValue(
          ["system", "light", "dark"].includes(m.theme) &&
            typeof m.visible === "boolean",
          "INVALID_PREFERENCES",
        );
        const updates: Record<string, unknown> = {
          "ui.theme": m.theme,
          "ui.progressVisible": m.visible,
        };
        if (typeof m.locale === "string") updates["ui.locale"] = m.locale;
        if (m.translationStyle && typeof m.translationStyle === "object") {
          updates["ui.translationStyle"] = m.translationStyle;
        }
        await chrome.storage.local.set(updates);
        if (typeof m.locale === "string") void menus();
        result = { saved: true };
        break;
      }
      case "DISPLAY":
        await chrome.storage.local.set({ "ui.progressVisible": !!m.visible });
        result = { saved: true };
        break;
      case "SAVE_SITE_RULE": {
        const siteOrigin = String(m.origin || "").trim();
        requireValue(
          siteOrigin.length > 0 && siteOrigin.length <= 200,
          "INVALID_CONFIG",
        );
        const rule: SiteRule = m.rule || {};
        const stored = await chrome.storage.local.get(["sites", "site.rules"]);
        const sites = { ...(stored.sites || {}) };
        const rules = normalizeSiteRules(stored.sites, stored["site.rules"]);
        if (!m.rule || Object.keys(rule).length === 0) {
          delete sites[siteOrigin];
          delete rules[siteOrigin];
          await registerSite(siteOrigin, "default");
        } else {
          rules[siteOrigin] = rule;
          if (rule.mode === "auto") sites[siteOrigin] = true;
          else delete sites[siteOrigin];
          await registerSite(siteOrigin, rule.mode || "default");
        }
        await chrome.storage.local.set({ sites, "site.rules": rules });
        result = { sites, siteRules: rules };
        break;
      }
      case "REMOVE_SITE": {
        const stored = await chrome.storage.local.get(["sites", "site.rules"]),
          sites = { ...stored.sites },
          rules = normalizeSiteRules(stored.sites, stored["site.rules"]);
        delete sites[m.origin];
        delete rules[m.origin];
        await chrome.storage.local.set({ sites, "site.rules": rules });
        await registerSite(m.origin, "default");
        result = { sites, siteRules: rules };
        break;
      }
      case "USAGE_READ":
        result = await readUsageStore();
        break;
      case "USAGE_CLEAR":
        await clearUsageStore();
        result = { cleared: true };
        break;
      case "DATABASE": {
        const allowed = new Set([
          "status",
          "setBudget",
          "startPack",
          "appendPack",
          "activatePack",
          "abortPack",
          "rollback",
          "revision",
          "revisionHistory",
          "readRevision",
          "exportSyncData",
          "configurePack",
          "clearModels",
          "purgeInvalidModels",
          "deletePack",
          "clearRevisions",
          "collect",
          "flush",
          "maintenanceStop",
        ]);
        requireValue(allowed.has(m.operation), "INVALID_OPERATION");
        result = await storage(m.operation, m.args || [], t);
        if (
          [
            "revision",
            "activatePack",
            "configurePack",
            "deletePack",
            "rollback",
            "clearRevisions",
          ].includes(m.operation)
        ) {
          const cur = await config();
          if (cur.syncDictionary) {
            void syncDictionaryToManager(cur, t).catch(() => {});
          }
        }
        break;
      }
      case "SYNC_NOW": {
        const c = await config();
        result = await syncDictionaryToManager(c, t, uiController.signal);
        break;
      }
      case "SYNC_CLEAR": {
        const c = await config();
        await clearSyncedDictionaryInManager(c, t, uiController.signal);
        result = { cleared: true };
        break;
      }
      case "TRACE_CLEAR":
        result = await storage("trace.clear", [], t);
        break;
      case "RELEASE":
        result = await fetchRelease(
          m.repo === undefined ? (await config()).releaseRepo : m.repo,
          chrome.runtime.getManifest().version,
          t,
          { record },
        );
        break;
      case "MIGRATE":
        result = await migrate(m.code, t);
        break;
      default:
        throw Error("UNKNOWN_OPERATION");
    }
    record(t, "operation.end", { outcome: "success", resourceId: m.type });
    return result;
  } catch (e) {
    record(t, "operation.end", {
      outcome: uiController.signal.aborted ? "cancelled" : "failed",
      resourceId: m.type,
      reason:
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "OPERATION_FAILED",
    });
    throw e;
  } finally {
    if (typeof m.opId === "string") activeUiOps.delete(m.opId);
  }
}

chrome.runtime.onMessage.addListener((m, s, respond) => {
  if (m?.target) return;
  void handle(m, s).then(
    (data) => respond({ ok: true, data }),
    (e) => respond({ ok: false, error: e.message || "FAILED" }),
  );
  return true;
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const previousTabId = windowActiveTab.get(windowId);
  windowActiveTab.set(windowId, tabId);
  setActiveTabs(windowActiveTab.values());
  if (previousTabId !== undefined && previousTabId !== tabId) {
    cancelQueuedForTab(previousTabId);
    void chrome.tabs
      .sendMessage(previousTabId, {
        type: "CONTROL",
        command: "tab-deactivated",
      })
      .catch(() => {});
  }
  void chrome.tabs
    .sendMessage(tabId, { type: "CONTROL", command: "tab-activated" })
    .catch(() => {});
});

chrome.windows?.onFocusChanged?.addListener(() => {
  void refreshActiveTabs();
});

chrome.tabs.onRemoved.addListener((id) => {
  for (const [winId, activeId] of windowActiveTab) {
    if (activeId === id) windowActiveTab.delete(winId);
  }
  setActiveTabs(windowActiveTab.values());
  cancel(id);
});

chrome.webNavigation?.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) cancel(tabId);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
  void chrome.tabs
    .sendMessage(tabId, { type: "CONTROL", command: "route" }, { frameId })
    .catch(() => {});
});

chrome.commands.onCommand.addListener((command) => {
  void chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(async ([tab]) => {
      if (!tab?.id) return;
      if (command === "translate-page") {
        await activate(tab.id, "translate", (await config()).mode);
      } else if (command === "toggle-mode") {
        await activate(tab.id, "toggle-mode");
      } else if (command === "restore-original") {
        await activate(tab.id, "original");
      } else if (command === "translate-selection") {
        await activate(tab.id, "translate-selection");
      }
    })
    .catch(() => {});
});

async function activate(tab: number, command: string, mode?: string) {
  const trace = newTrace();
  record(trace, "control.start", { outcome: "started", resourceId: command });
  try {
    const tabInfo = await chrome.tabs.get(tab).catch(() => undefined);
    if (tabInfo?.url?.startsWith("file:")) {
      const allowed = await chrome.extension
        ?.isAllowedFileSchemeAccess?.()
        .catch(() => false);
      if (!allowed) {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("options.html#reading-file-access"),
          active: true,
        });
        throw new Error("FILE_ACCESS_REQUIRED");
      }
    }
    if (tabInfo?.url && /^https?:/.test(tabInfo.url)) {
      const dom = new URL(tabInfo.url).origin;
      const d = await chrome.storage.local.get(["sites", "site.rules"]);
      const rules = normalizeSiteRules(d.sites, d["site.rules"]);
      if (rules[dom]?.mode === "never" && command === "translate") {
        return;
      }
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab, frameIds: [0] },
      files: ["shadow-hook.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab, frameIds: [0] },
      files: ["content.js"],
    });
    await chrome.scripting
      .executeScript({
        target: { tabId: tab, allFrames: true },
        files: ["content.js"],
      })
      .catch(() => {});
    const response = await chrome.tabs.sendMessage(
      tab,
      { type: "CONTROL", command, mode, trace },
      { frameId: 0 },
    );
    const frames = await chrome.webNavigation
      .getAllFrames({ tabId: tab })
      .catch(() => []);
    for (const frame of frames || [])
      if (frame.frameId)
        void chrome.tabs
          .sendMessage(
            tab,
            { type: "CONTROL", command, mode, trace },
            { frameId: frame.frameId },
          )
          .catch(() => {});
    record(trace, "control.end", {
      outcome: response?.ok ? "success" : "failed",
      resourceId: command,
    });
    requireValue(response?.ok, "PAGE_CONTROL_FAILED");
  } catch (e) {
    record(trace, "control.end", {
      outcome: "failed",
      resourceId: command,
      reason:
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "PAGE_CONTROL_FAILED",
    });
    throw e;
  }
}

async function menus() {
  const version = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get("ui.locale");
  const en = String(
    stored["ui.locale"] || chrome.i18n?.getUILanguage?.() || "",
  ).startsWith("en");

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "qy",
    title: en ? `Qingyi ${version}` : `轻译 ${version}`,
    contexts: ["page", "selection", "link"],
  });
  // Selection translation first when text is selected (Prompt items 4 & 7)
  chrome.contextMenus.create({
    id: "translate-selection",
    parentId: "qy",
    title: en ? "Translate selected text" : "翻译选中文字",
    contexts: ["selection"],
  });
  for (const [id, zhTitle, enTitle] of [
    ["chinese", "译文模式", "Translated view"],
    ["bilingual", "双语对照", "Bilingual view"],
    ["original", "恢复原文", "Restore original"],
    ["pause", "暂停翻译", "Pause translation"],
  ] as const) {
    chrome.contextMenus.create({
      id,
      parentId: "qy",
      title: en ? enTitle : zhTitle,
      contexts: ["page", "selection", "link"],
    });
  }
  chrome.contextMenus.create({
    id: "sep-tools",
    parentId: "qy",
    type: "separator",
    contexts: ["page", "selection", "link"],
  });
  for (const [id, zhTitle, enTitle] of [
    ["area-select", "框选区域翻译", "Translate selected area"],
    ["edit-translation", "修正此译文", "Edit this translation"],
    ["progress", "显示本页进度", "Show page progress"],
  ] as const) {
    chrome.contextMenus.create({
      id,
      parentId: "qy",
      title: en ? enTitle : zhTitle,
      contexts: ["page", "selection", "link"],
    });
  }
  chrome.contextMenus.create({
    id: "sep-site",
    parentId: "qy",
    type: "separator",
    contexts: ["page", "selection", "link"],
  });
  chrome.contextMenus.create({
    id: "auto",
    parentId: "qy",
    title: en ? "Auto-translate this site" : "此网站自动翻译",
    contexts: ["page", "selection", "link"],
  });
  chrome.contextMenus.create({
    id: "site-menu",
    parentId: "qy",
    title: en ? "This site…" : "本站规则…",
    contexts: ["page", "selection", "link"],
  });
  for (const [id, zhTitle, enTitle] of [
    ["site-never", "永不翻译此网站", "Never translate this site"],
    ["site-article", "切换“只翻译正文”", "Toggle 'Main article only'"],
    ["site-reset", "清除本站特殊规则", "Clear site rule"],
  ] as const) {
    chrome.contextMenus.create({
      id,
      parentId: "site-menu",
      title: en ? enTitle : zhTitle,
      contexts: ["page", "selection", "link"],
    });
  }
  chrome.contextMenus.create({
    id: "open-pdf",
    parentId: "qy",
    title: en ? "Open PDF in Qingyi" : "用轻译打开 PDF",
    contexts: ["link", "page"],
  });
  chrome.contextMenus.create({
    id: "settings",
    parentId: "qy",
    title: en ? "Settings" : "设置",
    contexts: ["page", "selection", "link"],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void menus();
});

chrome.runtime.onStartup.addListener(() => {
  void menus();
  void refreshActiveTabs();
  void chrome.storage.local.get(["sites", "site.rules"]).then((d) => {
    const rules = normalizeSiteRules(d.sites, d["site.rules"]);
    return Promise.all(
      Object.entries(rules).map(([o, r]) =>
        registerSite(o, r.mode || "default"),
      ),
    );
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    const action = String(info.menuItemId);
    if (action === "settings") {
      return handle({ type: "OPEN_SETTINGS" }, { id: chrome.runtime.id, tab });
    }
    if (action === "open-pdf") {
      const targetUrl = info.linkUrl || info.pageUrl || tab?.url || "";
      if (targetUrl) {
        await chrome.tabs.create({
          url:
            chrome.runtime.getURL("pdf.html") +
            "?file=" +
            encodeURIComponent(targetUrl),
          active: true,
        });
      }
      return;
    }
    requireValue(tab?.id !== undefined, "WEB_PAGE_REQUIRED");
    const tabUrl = tab!.url || info.pageUrl || "";
    if (tabUrl.startsWith("file:")) {
      const allowed = await chrome.extension
        ?.isAllowedFileSchemeAccess?.()
        .catch(() => false);
      if (!allowed) {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("options.html#reading"),
          active: true,
        });
        return;
      }
    } else {
      requireValue(/^https?:/.test(tabUrl), "WEB_PAGE_REQUIRED");
    }

    if (
      action === "auto" ||
      action === "site-never" ||
      action === "site-article" ||
      action === "site-reset"
    ) {
      requireValue(/^https?:/.test(tabUrl), "WEB_PAGE_REQUIRED");
      const o = new URL(tabUrl).origin;
      const d = await chrome.storage.local.get(["sites", "site.rules"]);
      const sites = { ...(d.sites || {}) };
      const rules = normalizeSiteRules(d.sites, d["site.rules"]);
      if (action === "auto") {
        requireValue(
          await chrome.permissions.request({ origins: [o + "/*"] }),
          "SITE_PERMISSION_REQUIRED",
        );
        sites[o] = true;
        rules[o] = { ...rules[o], mode: "auto" };
        await chrome.storage.local.set({ sites, "site.rules": rules });
        await registerSite(o, "auto");
        return activate(tab!.id!, "translate", (await config()).mode);
      }
      if (action === "site-never") {
        delete sites[o];
        rules[o] = { ...rules[o], mode: "never" };
        await chrome.storage.local.set({ sites, "site.rules": rules });
        await registerSite(o, "never");
        return activate(tab!.id!, "original").catch(() => {});
      }
      if (action === "site-article") {
        const nextArticle = !rules[o]?.articleOnly;
        rules[o] = { ...rules[o], articleOnly: nextArticle };
        await chrome.storage.local.set({ sites, "site.rules": rules });
        return activate(tab!.id!, "translate", (await config()).mode);
      }
      if (action === "site-reset") {
        delete sites[o];
        delete rules[o];
        await chrome.storage.local.set({ sites, "site.rules": rules });
        await registerSite(o, "default");
        return;
      }
    }

    return activate(
      tab!.id!,
      ["chinese", "bilingual"].includes(action) ? "translate" : action,
      action,
    );
  })().catch(async (err) => {
    // Provide visible feedback when context menu or page injection fails (Q-06).
    const code = err instanceof Error ? err.message : "PAGE_CONTROL_FAILED";
    if (tab?.id !== undefined) {
      try {
        await chrome.tabs.sendMessage(
          tab.id,
          { type: "CONTROL", command: "notify-error", code },
          { frameId: 0 },
        );
        return;
      } catch {
        // Page does not allow content scripts (e.g. chrome:// or Web Store): open settings with status hash
      }
    }
    if (
      code === "WEB_PAGE_REQUIRED" ||
      code === "SITE_PERMISSION_REQUIRED" ||
      code === "PAGE_CONTROL_FAILED"
    ) {
      await chrome.tabs
        .create({
          url:
            chrome.runtime.getURL("options.html") +
            `#service?notice=${encodeURIComponent(code)}`,
          active: true,
        })
        .catch(() => {});
    }
  });
});

async function migrate(code: string, t: Trace) {
  requireValue(/^\d{6}$/.test(code), "MIGRATION_CODE_REQUIRED");
  const response = await chrome.runtime.sendMessage(OLD_ID, {
    type: "QINGYI_MIGRATE",
    code,
  });
  requireValue(response?.ok, "MIGRATION_REFUSED");
  const data = response.data;
  const c = configFrom(
    { ...data.config, clearKey: !data.config?.apiKey },
    DEFAULTS,
  );
  await chrome.storage.local.set({
    [CONFIG_KEY]: c,
    sites: data.sites || {},
    "ui.progressVisible": data.progressVisible !== false,
    "ui.position": data.position,
    "migration.result": {
      time: Date.now(),
      migratedAt: Date.now(),
      hasKey: !!c.apiKey,
      oldId: OLD_ID,
      cacheBuckets: data.caches?.length || 0,
    },
  });
  const legacy: Record<string, { origin: string; scope: string }> = {};
  for (const bucket of data.caches || []) {
    const domain = bucket.origin || "legacy-isolated:" + bucket.key,
      scope = await sha256(
        JSON.stringify([c.apiUrl, c.model, "prompt.v2", bucket.key]),
      );
    if (
      bucket.origin &&
      bucket.key ===
        "cache:" +
          (await sha256(
            JSON.stringify([bucket.origin, c.apiUrl, c.model, "prompt.v2"]),
          ))
    )
      legacy[bucket.key] = { origin: bucket.origin, scope };
    for (let i = 0; i < bucket.entries.length; i += 500)
      await storage(
        "enqueue",
        [
          bucket.entries
            .slice(i, i + 500)
            .map(([source, translation]: string[]) => ({
              source,
              translation,
              domain,
              scope,
              sourceLang: "auto",
              targetLang: "zh-CN",
            })),
        ],
        t,
      );
  }
  await storage("flush", [], t);
  await chrome.storage.local.set({ "migration.legacy": legacy });
  requireValue(
    (await config()).apiKey === c.apiKey,
    "MIGRATION_KEY_VERIFY_FAILED",
  );
  await chrome.runtime.sendMessage(OLD_ID, { type: "QINGYI_MIGRATED", code });
  return { hasKey: !!c.apiKey, cacheBuckets: data.caches?.length || 0 };
}

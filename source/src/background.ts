import {
  CONFIG_KEY,
  DEFAULTS,
  OLD_ID,
  configFrom,
  publicConfig,
  requireValue,
  sha256,
  type Config,
  type CacheInput,
  type Trace,
} from "./types";
import { newTrace, childTrace, validTrace, sanitizeTrace } from "./trace";
import { storage, record } from "./storage-client";
import { fetchRelease } from "./releases";
import { translateRouted, localModels } from "./local-provider";
const ready = chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
});
const own = (s: chrome.runtime.MessageSender) =>
  s.id === chrome.runtime.id && !!s.url?.startsWith(chrome.runtime.getURL(""));
const origin = (s: chrome.runtime.MessageSender) => {
  try {
    const u = new URL(s.url || s.tab?.url || "");
    return /^https?:$/.test(u.protocol) ? u.origin : "";
  } catch {
    return "";
  }
};
async function config() {
  await ready;
  return configFrom(
    (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {},
    DEFAULTS,
  );
}
async function context(m: any, s: chrome.runtime.MessageSender) {
  requireValue(origin(s) && s.tab?.id !== undefined, "WEB_PAGE_REQUIRED");
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
  const c = await config(),
    domain = origin(s),
    scope = await sha256(
      JSON.stringify([
        "dictionary-first",
        c.routing,
        c.localUrl,
        c.localModel,
        c.localBackend,
        c.localAutoStart,
        c.apiUrl,
        c.model,
      ]),
    );
  return {
    c,
    inputs: (m.sources as string[]).map(
      (source): CacheInput => ({
        source,
        domain,
        scope,
        sourceLang: /^[a-z-]{1,20}$/i.test(m.sourceLang || "")
          ? m.sourceLang
          : "auto",
        targetLang: "zh-CN",
      }),
    ),
    t: m.trace as Trace,
  };
}
type Shared = {
  owner: Trace;
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  consumers: Set<string>;
  controller: AbortController;
};
const inflight = new Map<string, Shared>();
async function lookup(inputs: CacheInput[], c: Config, t: Trace) {
  const result = await storage("lookup", [inputs], t);
  const missing = inputs
    .map((input, i) =>
      !result.translations[i] && !input.source.includes("__QY") ? i : -1,
    )
    .filter((i) => i >= 0);
  if (!missing.length) return result;
  if (c.routing !== "cloud-only") return result;
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
function cancel(tab: number, session?: string) {
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
        reason: "page-or-user-cancel",
      });
    }
}
async function translate(m: any, s: chrome.runtime.MessageSender) {
  const { c, inputs, t } = await context(m, s);
  record(t, "batch.translate.start", {
    outcome: "started",
    items: inputs.length,
  });
  const cached = await lookup(inputs, c, t);
  const values: (string | null)[] = cached.translations;
  const missing = inputs
    .map((_, i) => (values[i] === null ? i : -1))
    .filter((i) => i >= 0);
  if (!missing.length)
    return { translations: values, hits: cached.hits, requests: 0, trace: t };
  const id = crypto.randomUUID(),
    controller = new AbortController(),
    job = {
      tab: s.tab!.id!,
      frame: s.frameId || 0,
      session: t.sessionId || "",
      controller,
      shared: [] as Shared[],
      trace: t,
    };
  jobs.set(id, job);
  const fresh: { key: string; index: number; shared: Shared }[] = [];
  let requests = 0;
  let providerHits = 0;
  let cacheWarning = false;
  const promises = await Promise.all(
    missing.map(async (index) => {
      const input = inputs[index],
        key = await sha256(JSON.stringify(input));
      let item = inflight.get(key);
      if (!item) {
        let resolve!: (v: string) => void, reject!: (e: Error) => void;
        const promise = new Promise<string>((r, j) => {
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
      } else
        record(childTrace(t), "queue.coalesced", {
          outcome: "success",
          items: 1,
          resourceId: item.owner.traceId,
          source: "producer-trace",
        });
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
    void chrome.tabs
      .sendMessage(
        s.tab!.id!,
        { type: "PROGRESS", traceId: t.traceId, state: "queue" },
        { frameId: s.frameId || 0 },
      )
      .catch(() => {});
    void (async () => {
      const routed = await translateRouted(
        c,
        fresh.map((v) => inputs[v.index]),
        t,
        groupController.signal,
        (phase = "request") => {
          if (phase === "request") requests++;
          void chrome.tabs
            .sendMessage(
              s.tab!.id!,
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
        },
      );
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
      providerHits += routed.hits;
      fresh.forEach((v, i) => v.shared.resolve(routed.translations[i]));
    })()
      .catch((error) => fresh.forEach((v) => v.shared.reject(error)))
      .finally(() => fresh.forEach((v) => inflight.delete(v.key)));
  }
  try {
    await Promise.race([
      Promise.all(
        promises.map(async (p) => {
          values[p.index] = await p.promise;
        }),
      ),
      new Promise((_, reject) =>
        controller.signal.addEventListener(
          "abort",
          () => reject(Error("CANCELLED")),
          { once: true },
        ),
      ),
    ]);
    requireValue(!controller.signal.aborted, "CANCELLED");
    record(childTrace(t), "batch.complete", {
      outcome: "success",
      items: inputs.length,
      hits: cached.hits + providerHits,
    });
    return {
      translations: values,
      hits: cached.hits + providerHits,
      requests,
      cacheWarning,
      trace: t,
    };
  } finally {
    jobs.delete(id);
    for (const item of job.shared) item.consumers.delete(id);
  }
}
let settingTail = Promise.resolve();
async function registerSite(url: string, enabled: boolean) {
  const id = "qingyi-" + (await sha256(url)).slice(0, 20);
  await chrome.scripting
    .unregisterContentScripts({ ids: [id, id + "-shadow"] })
    .catch(() => {});
  if (enabled && (await chrome.permissions.contains({ origins: [url + "/*"] })))
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
async function handle(m: any, s: chrome.runtime.MessageSender): Promise<any> {
  await ready;
  requireValue(s.id === chrome.runtime.id, "INVALID_SENDER");
  const trusted = own(s);
  switch (m.type) {
    case "PUBLIC": {
      const c = await config(),
        data = await chrome.storage.local.get([
          "sites",
          "ui.progressVisible",
          "ui.theme",
          "ui.position",
        ]);
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
          ]),
        ),
        auto: !!data.sites?.[origin(s)],
        progressVisible: data["ui.progressVisible"] !== false,
        theme: data["ui.theme"] || "system",
        position: data["ui.position"],
      };
    }
    case "TRACE":
      requireValue(validTrace(m.trace), "INVALID_TRACE");
      record(m.trace, m.event, { ...sanitizeTrace(m.fields || {}) });
      return {};
    case "LOOKUP": {
      const { inputs, c, t } = await context(m, s);
      return lookup(inputs, c, t);
    }
    case "TRANSLATE":
      return translate(m, s);
    case "CANCEL":
      if (s.tab?.id !== undefined) cancel(s.tab.id, m.session);
      return {};
    case "OPEN_SETTINGS": {
      const t = validTrace(m.trace) ? childTrace(m.trace) : newTrace();
      record(t, "settings.open.start", { outcome: "started" });
      try {
        await chrome.tabs.create({
          url: chrome.runtime.getURL("options.html"),
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
  const t = validTrace(m.trace) ? m.trace : newTrace();
  record(t, "operation.start", { outcome: "started", resourceId: m.type });
  try {
    let result;
    switch (m.type) {
      case "LOCAL_MODELS": {
        requireValue(validTrace(m.trace), "INVALID_TRACE");
        const c = configFrom(m.config || {}, await config());
        result = await localModels(c, m.trace);
        break;
      }
      case "PRIVATE":
        result = {
          ...publicConfig(await config()),
          ...(await chrome.storage.local.get([
            "sites",
            "ui.progressVisible",
            "ui.theme",
            "migration.result",
          ])),
        };
        break;
      case "SAVE": {
        const run = settingTail
          .catch(() => {})
          .then(async () => {
            const c = configFrom(m.config, await config());
            await chrome.storage.local.set({ [CONFIG_KEY]: c });
            const loaded = await config();
            requireValue(
              JSON.stringify(loaded) === JSON.stringify(c),
              "CONFIG_VERIFY_FAILED",
            );
            const affectsTranslation = [
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
            ].some((key) => key in m.config);
            if (affectsTranslation)
              for (const job of jobs.values()) cancel(job.tab);
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
        result = await translateRouted(
          c,
          [
            {
              source: "Hello.",
              scope: "",
              domain: "https://qingyi.test",
              sourceLang: "auto",
              targetLang: "zh-CN",
            },
          ],
          batch,
          new AbortController().signal,
          () => {},
        ).then(() => ({ connected: true }));
        break;
      }
      case "PREFERENCES": {
        requireValue(
          ["system", "light", "dark"].includes(m.theme) &&
            typeof m.visible === "boolean",
          "INVALID_PREFERENCES",
        );
        await chrome.storage.local.set({
          "ui.theme": m.theme,
          "ui.progressVisible": m.visible,
        });
        result = { saved: true };
        break;
      }
      case "DISPLAY":
        await chrome.storage.local.set({ "ui.progressVisible": !!m.visible });
        result = { saved: true };
        break;
      case "REMOVE_SITE": {
        const data = await chrome.storage.local.get("sites"),
          sites = { ...data.sites };
        delete sites[m.origin];
        await chrome.storage.local.set({ sites });
        await registerSite(m.origin, false);
        result = { sites };
        break;
      }
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
          "configurePack",
          "clearModels",
          "deletePack",
          "clearRevisions",
          "collect",
          "flush",
          "maintenanceStop",
        ]);
        requireValue(allowed.has(m.operation), "INVALID_OPERATION");
        result = await storage(m.operation, m.args || [], t);
        break;
      }
      case "TRACE_READ":
        result = await storage(
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
        ).then(async (r) => {
          if (m.traceId || m.batchId) {
            r.events = r.events.filter(
              (e: any) =>
                (!m.traceId || e.traceId === m.traceId) &&
                (!m.batchId || e.batchId === m.batchId),
            );
          }
          return r;
        });
        break;
      case "TRACE_CLEAR":
        result = await storage("trace.clear", [], t);
        break;
      case "RELEASE":
        result = await fetchRelease(
          m.repo,
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
      outcome: "failed",
      resourceId: m.type,
      reason:
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "OPERATION_FAILED",
    });
    throw e;
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
chrome.tabs.onRemoved.addListener((id) => cancel(id));
chrome.webNavigation?.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) cancel(tabId);
});
chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId }) => {
  void chrome.tabs
    .sendMessage(tabId, { type: "CONTROL", command: "route" }, { frameId })
    .catch(() => {});
});
chrome.commands.onCommand.addListener((command) => {
  if (command === "translate-page")
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (tab?.id) await activate(tab.id, "translate", (await config()).mode);
      })
      .catch(() => {});
});
async function activate(tab: number, command: string, mode?: string) {
  const trace = newTrace();
  record(trace, "control.start", { outcome: "started", resourceId: command });
  try {
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
      reason: "PAGE_CONTROL_FAILED",
    });
    throw e;
  }
}
async function menus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "qy",
    title: "轻译 3.0",
    contexts: ["page", "selection", "link"],
  });
  for (const [id, title] of [
    ["chinese", "翻译为中文"],
    ["bilingual", "双语对照"],
    ["original", "恢复原文"],
    ["pause", "暂停翻译"],
    ["progress", "显示本页进度"],
    ["auto", "此网站自动翻译"],
    ["settings", "设置"],
  ])
    chrome.contextMenus.create({
      id,
      parentId: "qy",
      title,
      contexts: ["page", "selection", "link"],
    });
}
chrome.runtime.onInstalled.addListener(() => {
  void menus();
});
chrome.runtime.onStartup.addListener(() => {
  void menus();
  void chrome.storage.local
    .get("sites")
    .then((d) =>
      Promise.all(Object.keys(d.sites || {}).map((o) => registerSite(o, true))),
    );
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    if (info.menuItemId === "settings")
      return handle({ type: "OPEN_SETTINGS" }, { id: chrome.runtime.id, tab });
    requireValue(
      tab?.id !== undefined && !!tab.url?.match(/^https?:/),
      "WEB_PAGE_REQUIRED",
    );
    const action = String(info.menuItemId);
    if (action === "auto") {
      const o = new URL(tab.url!).origin;
      requireValue(
        await chrome.permissions.request({ origins: [o + "/*"] }),
        "SITE_PERMISSION_REQUIRED",
      );
      const d = await chrome.storage.local.get("sites");
      await chrome.storage.local.set({ sites: { ...d.sites, [o]: true } });
      await registerSite(o, true);
      return activate(tab.id!, "translate", (await config()).mode);
    }
    return activate(
      tab.id!,
      ["chinese", "bilingual"].includes(action) ? "translate" : action,
      action,
    );
  })().catch(() => {});
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
  return {
    keyVerified: true,
    hasKey: !!c.apiKey,
    sites: Object.keys(data.sites || {}).length,
    cacheBuckets: data.caches?.length || 0,
  };
}

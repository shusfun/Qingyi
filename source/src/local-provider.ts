import { childTrace, traceparent } from "./trace";
import { storage, record } from "./storage-client";
import {
  schedule,
  sleep,
  translateBatchDetailed,
  type SchedulePriority,
} from "./network";
import { translationPolicy, singleTextModel } from "./model-profile";
import {
  sha256,
  requireValue,
  type Config,
  type Trace,
  type CacheInput,
  type CacheEntry,
} from "./types";
import { resolveDeeplEndpoint } from "./deepl";

export async function providerScope(c: Config, local = false, revision = "") {
  const target = c.targetLang && c.targetLang !== "zh-CN" ? [c.targetLang] : [];
  if (!local && c.serviceType === "deepl") {
    const digest = await sha256(
      JSON.stringify(["deepl-v1", resolveDeeplEndpoint(c), ...target]),
    );
    return "deepl:" + digest;
  }
  const digest = await sha256(
    JSON.stringify([
      c.apiUrl,
      c.model,
      translationPolicy(c.modelProfile || c.model),
      ...(local ? [revision, "local-no-thinking-v1"] : []),
      ...target,
    ]),
  );
  return local ? "local:" + digest : digest;
}

type LocalStatusResult = {
  config: Config;
  revision: string;
  running: boolean;
  state: string;
  stage?: string;
  estimatedMs?: number;
};

const sessionStatusCache = new Map<
  string,
  { value: LocalStatusResult; expiresAt: number }
>();
const inflightStatus = new Map<string, Promise<LocalStatusResult>>();

export function invalidateLocalStatusCache() {
  sessionStatusCache.clear();
}

async function fetchLocalStatusOnce(
  c: Config,
  trace: Trace,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<LocalStatusResult> {
  const t = childTrace(trace),
    started = performance.now();
  record(t, "local.status.start", { outcome: "started" });
  try {
    const response = await fetch(
      c.localUrl + "/api/v1/status?model=" + encodeURIComponent(c.localModel),
      {
        headers: {
          Authorization: "Bearer " + c.localToken,
          traceparent: traceparent(t),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        redirect: "error",
        credentials: "omit",
      },
    );
    requireValue(response.ok, "LOCAL_HTTP_" + response.status);
    const data = await response.json();
    const deployment = Array.isArray(data.deployments)
      ? data.deployments.find((d: any) => d.id === c.localModel)
      : undefined;
    requireValue(
      deployment || data.settings?.model === c.localModel,
      "LOCAL_MODEL_MISMATCH",
    );
    const depState: string =
      deployment?.status?.state || data.status?.state || "stopped";
    if (depState === "cooldown") {
      throw new Error("LOCAL_RUNTIME_COOLDOWN");
    }
    requireValue(
      c.localBackend === "auto" || data.selected_backend === c.localBackend,
      "LOCAL_BACKEND_MISMATCH",
    );
    requireValue(
      typeof data.model_revision === "string" && !!data.model_revision,
      "LOCAL_MODEL_NOT_INSTALLED",
    );
    record(t, "local.status.end", {
      outcome: "success",
      durationMs: performance.now() - started,
    });
    return {
      config: {
        ...c,
        serviceType: "chat",
        apiUrl: c.localUrl + "/v1/chat/completions",
        apiKey: c.localToken,
        model: c.localModel,
        modelProfile:
          deployment?.model_name || deployment?.model || c.localModel,
        intervalMs: 0,
      },
      revision: [
        data.model_revision,
        deployment?.deployment_revision || data.deployment_revision || "",
      ].join(":"),
      running: depState === "running",
      state: depState,
      stage: deployment?.status?.stage || data.status?.stage,
      estimatedMs:
        deployment?.status?.estimated_ms ?? data.status?.estimated_ms,
    };
  } catch (e) {
    record(t, "local.status.end", {
      outcome: signal.aborted ? "cancelled" : "failed",
      durationMs: performance.now() - started,
      reason:
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "LOCAL_UNAVAILABLE",
    });
    throw e;
  }
}

async function localConfig(
  c: Config,
  trace: Trace,
  signal: AbortSignal,
  forceRefresh = false,
): Promise<LocalStatusResult> {
  requireValue(c.localToken, "LOCAL_TOKEN_REQUIRED");
  requireValue(
    await chrome.permissions.contains({
      origins: [new URL(c.localUrl).origin + "/*"],
    }),
    "LOCAL_PERMISSION_REQUIRED",
  );
  const cacheKey = trace.sessionId
    ? `${trace.sessionId}|${c.localUrl}|${c.localModel}|${c.localBackend}`
    : "";
  if (cacheKey && !forceRefresh) {
    const cached = sessionStatusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
  }
  const dedupKey = `${c.localUrl}|${c.localModel}|${c.localBackend}|${trace.sessionId || ""}`;
  if (!forceRefresh) {
    const existing = inflightStatus.get(dedupKey);
    if (existing) return existing;
  }

  const task = (async () => {
    try {
      const res = await fetchLocalStatusOnce(c, trace, signal, 2500);
      if (cacheKey) {
        sessionStatusCache.set(cacheKey, {
          value: res,
          expiresAt: Date.now() + 10000,
        });
      }
      return res;
    } catch (err) {
      // Status timeout is not treated as immediate manager absence (Q-T03): retry with longer timeout.
      if (
        !signal.aborted &&
        err instanceof Error &&
        (err.name === "TimeoutError" || /timed?\s*out/i.test(err.message))
      ) {
        const res = await fetchLocalStatusOnce(c, trace, signal, 8000);
        if (cacheKey) {
          sessionStatusCache.set(cacheKey, {
            value: res,
            expiresAt: Date.now() + 10000,
          });
        }
        return res;
      }
      throw err;
    } finally {
      inflightStatus.delete(dedupKey);
    }
  })();

  if (!forceRefresh) inflightStatus.set(dedupKey, task);
  return task;
}

// Wait for mistral-gui cold-start readiness without eating single-request timeoutMs (M-R1).
async function waitForLocalReady(
  c: Config,
  trace: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
): Promise<LocalStatusResult> {
  const maxWaitMs = c.localStartupTimeoutMs ?? 300000;
  const deadline = Date.now() + maxWaitMs;
  onAttempt("local-loading");
  while (Date.now() < deadline) {
    await sleep(800, signal);
    onAttempt("local-loading");
    const status = await localConfig(c, trace, signal, true);
    if (status.running) {
      return status;
    }
    if (status.state === "failed" || status.state === "stopped") {
      throw new Error("LOCAL_TRANSLATION_FAILED");
    }
  }
  throw new Error("LOCAL_STARTUP_TIMEOUT");
}

export async function localModels(c: Config, trace: Trace) {
  requireValue(c.localToken, "LOCAL_TOKEN_REQUIRED");
  requireValue(
    await chrome.permissions.contains({
      origins: [new URL(c.localUrl).origin + "/*"],
    }),
    "LOCAL_PERMISSION_REQUIRED",
  );
  const t = childTrace(trace),
    started = performance.now();
  record(t, "local.catalog.start", { outcome: "started" });
  try {
    const response = await fetch(c.localUrl + "/api/v1/models", {
      headers: {
        Authorization: "Bearer " + c.localToken,
        traceparent: traceparent(t),
      },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
      credentials: "omit",
    });
    requireValue(response.ok, "LOCAL_HTTP_" + response.status);
    const data = await response.json();
    const entries = Array.isArray(data.deployments)
      ? data.deployments.map((d: any) => ({
          id: d.id,
          model: d.model,
          backend: d.backend,
          state: d.status?.state,
          revision: d.model_revision,
        }))
      : (data.models || [])
          .filter((m: any) => m.kind === "model")
          .map((m: any) => ({
            id: m.id,
            model: m.name || m.id,
            backend: "auto",
            state: "installed",
            revision: m.version,
          }));
    requireValue(
      entries.every(
        (d: any) => typeof d.id === "string" && typeof d.model === "string",
      ),
      "LOCAL_INVALID_CATALOG",
    );
    record(t, "local.catalog.end", {
      outcome: "success",
      durationMs: performance.now() - started,
    });
    return entries;
  } catch (e) {
    record(t, "local.catalog.end", {
      outcome: "failed",
      durationMs: performance.now() - started,
      reason: "LOCAL_UNAVAILABLE",
    });
    throw e;
  }
}

export interface RoutedOptions {
  priority?: SchedulePriority;
  tabId?: number;
  allowPartial?: boolean;
  persistImmediately?: boolean;
}

export interface RoutedTranslationResult {
  translations: (string | null)[];
  errors?: (string | undefined)[];
  channels: ("local" | "cloud" | "cache")[];
  entries: CacheEntry[];
  hits: number;
  localFallbackReason?: string;
}

// Called only after dictionary/revision lookup. Each result is cached under its actual provider.
export async function translateRouted(
  c: Config,
  inputs: CacheInput[],
  trace: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
  options: RoutedOptions = {},
): Promise<RoutedTranslationResult> {
  const values: (string | null)[] = new Array(inputs.length).fill(null);
  const errors: (string | undefined)[] = new Array(inputs.length);
  const channels: ("local" | "cloud" | "cache")[] = new Array(
    inputs.length,
  ).fill("cloud");
  const entries: CacheEntry[] = [];
  let hits = 0;
  let local: LocalStatusResult | undefined;
  let localFallbackReason: string | undefined;

  const persistEntry = (entry: CacheEntry) => {
    entries.push(entry);
    if (options.persistImmediately) {
      void storage("enqueue", [[entry]], trace).catch(() => {});
    }
  };

  if (c.routing !== "cloud-only") {
    try {
      local = await localConfig(c, trace, signal);
    } catch (e) {
      if (signal.aborted) throw Error("CANCELLED");
      if (c.routing === "local-only") throw e;
      localFallbackReason =
        e instanceof Error && e.message ? e.message : "LOCAL_UNAVAILABLE";
      record(childTrace(trace), "provider.fallback", {
        outcome: "fallback",
        reason: localFallbackReason,
        source: "cloud",
      });
    }
  }

  const cloudScope = await providerScope(c);
  let localScope = local
    ? await providerScope(local.config, true, local.revision)
    : "";

  const makeChunkCache = (scope: string, template: CacheInput) => ({
    get: async (part: string): Promise<string | null> => {
      try {
        const res = await storage(
          "lookupModels",
          [[{ ...template, source: part, scope }]],
          trace,
        );
        return res?.translations?.[0] || null;
      } catch {
        return null;
      }
    },
    set: async (part: string, translation: string): Promise<void> => {
      try {
        await storage(
          "enqueue",
          [[{ ...template, source: part, scope, translation }]],
          trace,
        );
      } catch {
        // non-fatal
      }
    },
  });

  if (!local && (c.serviceType === "deepl" || !singleTextModel(c.model))) {
    const scoped = inputs.map((input) => ({ ...input, scope: cloudScope }));
    const cached = await storage("lookupModels", [scoped], trace);
    const missing = scoped
      .map((_, i) => i)
      .filter((i) => !cached.translations[i]);
    hits += inputs.length - missing.length;
    for (let i = 0; i < inputs.length; i++) {
      if (cached.translations[i]) {
        values[i] = cached.translations[i];
        channels[i] = "cache";
      }
    }
    if (missing.length) {
      const detailed = await schedule(
        c,
        trace,
        signal,
        () =>
          translateBatchDetailed(
            c,
            missing.map((i) => inputs[i].source),
            trace,
            signal,
            onAttempt,
            {
              onSegmentTranslated: (subIdx, val) => {
                const origIdx = missing[subIdx];
                persistEntry({ ...scoped[origIdx], translation: val });
              },
            },
          ),
        { priority: options.priority, tabId: options.tabId },
      );
      missing.forEach((origIdx, subIdx) => {
        const val = detailed.translations[subIdx];
        if (val !== null) {
          values[origIdx] = val;
          channels[origIdx] = "cloud";
        } else {
          errors[origIdx] = detailed.errors[subIdx] || "INVALID_TRANSLATION";
        }
      });
      if (!options.allowPartial) {
        const firstErrIdx = missing.find((i) => values[i] === null);
        if (firstErrIdx !== undefined) {
          throw new Error(errors[firstErrIdx] || "INVALID_TRANSLATION");
        }
      }
    }
    return {
      translations: values,
      errors,
      channels,
      entries,
      hits,
      localFallbackReason,
    };
  }

  // Single-text or local-first translation schedules each paragraph independently.
  await Promise.all(
    inputs.map(async (input, index) => {
      const runProvider = async (
        provider: Config,
        scope: string,
        isLocalProvider: boolean,
      ): Promise<{ value: string; fromCache: boolean }> => {
        const entry = { ...input, scope };
        const cached = await storage("lookupModels", [[entry]], trace);
        if (cached.translations[0]) {
          hits++;
          return { value: cached.translations[0] as string, fromCache: true };
        }
        if (isLocalProvider && local) {
          requireValue(
            provider.localAutoStart ||
              local.running ||
              local.state === "loading",
            "LOCAL_RUNTIME_STOPPED",
          );
          if (local.state === "loading") {
            local = await waitForLocalReady(c, trace, signal, onAttempt);
            localScope = await providerScope(
              local.config,
              true,
              local.revision,
            );
            provider = local.config;
          }
        }

        const executeOnce = () =>
          schedule(
            provider,
            trace,
            signal,
            () =>
              translateBatchDetailed(
                provider,
                [input.source],
                trace,
                signal,
                onAttempt,
                {
                  chunkCache: singleTextModel(
                    provider.modelProfile || provider.model,
                  )
                    ? makeChunkCache(scope, input)
                    : undefined,
                  extraHeaders: isLocalProvider
                    ? { "X-Mistral-Async-Ready": "1" }
                    : undefined,
                },
              ),
            { priority: options.priority, tabId: options.tabId },
          );

        let detailed: Awaited<ReturnType<typeof executeOnce>>;
        try {
          detailed = await executeOnce();
          if (
            isLocalProvider &&
            detailed.translations[0] === null &&
            detailed.errors[0] === "LOCAL_RUNTIME_LOADING"
          ) {
            throw new Error("LOCAL_RUNTIME_LOADING");
          }
        } catch (err) {
          if (
            isLocalProvider &&
            err instanceof Error &&
            err.message === "LOCAL_RUNTIME_LOADING"
          ) {
            local = await waitForLocalReady(c, trace, signal, onAttempt);
            localScope = await providerScope(
              local.config,
              true,
              local.revision,
            );
            scope = localScope;
            provider = local.config;
            detailed = await executeOnce();
          } else {
            throw err;
          }
        }

        const val = detailed.translations[0];
        if (val === null) {
          throw new Error(detailed.errors[0] || "INVALID_TRANSLATION");
        }
        persistEntry({ ...input, scope, translation: val });
        return { value: val, fromCache: false };
      };

      if (local) {
        try {
          const out = await runProvider(local.config, localScope, true);
          values[index] = out.value;
          channels[index] = out.fromCache ? "cache" : "local";
          return;
        } catch (e) {
          if (signal.aborted) throw Error("CANCELLED");
          if (c.routing === "local-only") {
            if (options.allowPartial) {
              errors[index] =
                e instanceof Error ? e.message : "LOCAL_TRANSLATION_FAILED";
              return;
            }
            throw e;
          }
          const reason =
            e instanceof Error && e.message
              ? e.message
              : "LOCAL_TRANSLATION_FAILED";
          localFallbackReason ||= reason;
          record(childTrace(trace), "provider.fallback", {
            outcome: "fallback",
            reason,
            source: "cloud",
          });
        }
      }

      try {
        const out = await runProvider(c, cloudScope, false);
        values[index] = out.value;
        channels[index] = out.fromCache ? "cache" : "cloud";
      } catch (e) {
        if (signal.aborted) throw Error("CANCELLED");
        if (options.allowPartial) {
          errors[index] = e instanceof Error ? e.message : "TRANSLATION_FAILED";
          return;
        }
        throw e;
      }
    }),
  );

  return {
    translations: values,
    errors,
    channels,
    entries,
    hits,
    localFallbackReason,
  };
}

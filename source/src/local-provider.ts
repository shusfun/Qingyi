import { childTrace, traceparent } from "./trace";
import { storage, record } from "./storage-client";
import { schedule, translateBatch } from "./network";
import { translationPolicy, singleTextModel } from "./model-profile";
import {
  sha256,
  requireValue,
  type Config,
  type Trace,
  type CacheInput,
  type CacheEntry,
} from "./types";

export async function providerScope(c: Config, local = false, revision = "") {
  const digest = await sha256(
    JSON.stringify([
      c.apiUrl,
      c.model,
      translationPolicy(c.model),
      ...(local ? [revision] : []),
    ]),
  );
  return local ? "local:" + digest : digest;
}

async function localConfig(c: Config, trace: Trace, signal: AbortSignal) {
  requireValue(c.localToken, "LOCAL_TOKEN_REQUIRED");
  requireValue(
    await chrome.permissions.contains({
      origins: [new URL(c.localUrl).origin + "/*"],
    }),
    "LOCAL_PERMISSION_REQUIRED",
  );
  const t = childTrace(trace),
    started = performance.now();
  record(t, "local.status.start", { outcome: "started" });
  try {
    const response = await fetch(c.localUrl + "/api/v1/status", {
      headers: {
        Authorization: "Bearer " + c.localToken,
        traceparent: traceparent(t),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
      redirect: "error",
      credentials: "omit",
    });
    requireValue(response.ok, "LOCAL_HTTP_" + response.status);
    const data = await response.json();
    requireValue(data.settings?.model === c.localModel, "LOCAL_MODEL_MISMATCH");
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
        apiUrl: c.localUrl + "/v1/chat/completions",
        apiKey: c.localToken,
        model: c.localModel,
        intervalMs: 0,
      },
      revision: data.model_revision as string,
      running: data.status?.state === "running",
    };
  } catch (e) {
    record(t, "local.status.end", {
      outcome: signal.aborted ? "cancelled" : "failed",
      durationMs: performance.now() - started,
      reason: "LOCAL_UNAVAILABLE",
    });
    throw e;
  }
}

// Called only after dictionary/revision lookup. Each result is cached under its actual provider.
export async function translateRouted(
  c: Config,
  inputs: CacheInput[],
  trace: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
) {
  const values: string[] = new Array(inputs.length);
  const entries: CacheEntry[] = [];
  let hits = 0;
  let local: Awaited<ReturnType<typeof localConfig>> | undefined;
  if (c.routing !== "cloud-only") {
    try {
      local = await localConfig(c, trace, signal);
    } catch (e) {
      if (signal.aborted) throw Error("CANCELLED");
      if (c.routing === "local-only") throw e;
      record(childTrace(trace), "provider.fallback", {
        outcome: "fallback",
        reason: "LOCAL_UNAVAILABLE",
        source: "cloud",
      });
    }
  }
  const cloudScope = await providerScope(c);
  const localScope = local
    ? await providerScope(local.config, true, local.revision)
    : "";
  if (!local && !singleTextModel(c.model)) {
    const scoped = inputs.map((input) => ({ ...input, scope: cloudScope }));
    const cached = await storage("lookupModels", [scoped], trace);
    const missing = scoped
      .map((_, i) => i)
      .filter((i) => !cached.translations[i]);
    hits += inputs.length - missing.length;
    for (let i = 0; i < inputs.length; i++) values[i] = cached.translations[i];
    if (missing.length) {
      const result = await schedule(c, trace, signal, () =>
        translateBatch(
          c,
          missing.map((i) => inputs[i].source),
          trace,
          signal,
          onAttempt,
        ),
      );
      missing.forEach((i, n) => {
        values[i] = result[n];
        entries.push({ ...scoped[i], translation: result[n] });
      });
    }
    return { translations: values, entries, hits };
  }
  // Single-text translation schedules each paragraph independently; a slow paragraph
  // no longer holds the rest of an enclosing content-script batch.
  await Promise.all(
    inputs.map(async (input, index) => {
      const run = async (provider: Config, scope: string) => {
        const entry = { ...input, scope };
        const cached = await storage("lookupModels", [[entry]], trace);
        if (cached.translations[0]) {
          hits++;
          return cached.translations[0] as string;
        }
        if (provider === local?.config)
          requireValue(
            provider.localAutoStart || local.running,
            "LOCAL_RUNTIME_STOPPED",
          );
        const result = await schedule(provider, trace, signal, () =>
          translateBatch(provider, [input.source], trace, signal, onAttempt),
        );
        entries.push({ ...entry, translation: result[0] });
        return result[0];
      };
      if (local) {
        try {
          values[index] = await run(local.config, localScope);
          return;
        } catch (e) {
          if (signal.aborted) throw Error("CANCELLED");
          if (c.routing === "local-only") throw e;
          record(childTrace(trace), "provider.fallback", {
            outcome: "fallback",
            reason: "LOCAL_TRANSLATION_FAILED",
            source: "cloud",
          });
        }
      }
      values[index] = await run(c, cloudScope);
    }),
  );
  return { translations: values, entries, hits };
}

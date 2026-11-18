import { childTrace, traceparent } from "./trace";
import { record } from "./storage-client";
import {
  parseBatch,
  validTranslation,
  requireValue,
  type Config,
  type Trace,
} from "./types";
import { providerResult, type TokenUsage } from "./provider-response";
import {
  singleTextModel,
  translationPrompt,
  SPLIT_LIMIT,
} from "./model-profile";
import { splitSegments } from "./segments";
import {
  checkDailyCloudQuota,
  reserveCloudQuota,
  recordUsageAttempt,
} from "./usage";
import { translateDeeplBatch } from "./deepl";

export type SchedulePriority = 0 | 1 | 2 | 3;

export interface ScheduleOptions {
  priority?: SchedulePriority;
  tabId?: number;
}

type WaitingItem = {
  run: () => void;
  reject: (err: Error) => void;
  signal: AbortSignal;
  concurrency: number;
  basePriority: SchedulePriority;
  tabId?: number;
  seq: number;
};

type Pool = {
  running: number;
  nextAt: number;
  rateTail: Promise<void>;
  waiting: WaitingItem[];
};

const pools = new Map<string, Pool>();
const activeTabIds = new Set<number>();
let nextQueueSeq = 1;

function effectivePriority(item: WaitingItem): number {
  if (item.basePriority === 0) return 0;
  if (
    item.tabId !== undefined &&
    activeTabIds.size > 0 &&
    !activeTabIds.has(item.tabId)
  ) {
    return 3;
  }
  return item.basePriority;
}

function pickNextWaitingIndex(waiting: WaitingItem[]): number {
  let bestIdx = -1;
  let bestPrio = 99;
  let bestSeq = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < waiting.length; i++) {
    const item = waiting[i];
    if (item.signal.aborted) continue;
    const prio = effectivePriority(item);
    if (prio < bestPrio || (prio === bestPrio && item.seq < bestSeq)) {
      bestIdx = i;
      bestPrio = prio;
      bestSeq = item.seq;
    }
  }
  return bestIdx;
}

export function setActiveTabs(tabs: Iterable<number>) {
  activeTabIds.clear();
  for (const id of tabs) activeTabIds.add(id);
}

export function getActiveTabs(): ReadonlySet<number> {
  return activeTabIds;
}

export function cancelQueuedForTab(tabId: number) {
  for (const p of pools.values()) {
    for (let i = p.waiting.length - 1; i >= 0; i--) {
      if (p.waiting[i].tabId === tabId) {
        const [removed] = p.waiting.splice(i, 1);
        removed.reject(new Error("CANCELLED"));
      }
    }
  }
}

function pool(c: Config) {
  const url =
    c.serviceType === "deepl" &&
    c.apiUrl !== c.localUrl + "/v1/chat/completions"
      ? c.deeplUrl || "https://api.deepl.com"
      : c.apiUrl;
  const key = new URL(url).origin;
  let value = pools.get(key);
  if (!value) {
    value = { running: 0, nextAt: 0, rateTail: Promise.resolve(), waiting: [] };
    pools.set(key, value);
  }
  return value;
}

export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("CANCELLED"));
    };
    if (signal.aborted) return reject(new Error("CANCELLED"));
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function schedule<T>(
  c: Config,
  t: Trace,
  signal: AbortSignal,
  run: () => Promise<T>,
  options: ScheduleOptions = {},
): Promise<T> {
  const queued = performance.now(),
    span = childTrace(t),
    p = pool(c),
    basePriority: SchedulePriority = options.priority ?? 2;
  record(span, "queue.start", { outcome: "started" });
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      if (signal.aborted) {
        reject(new Error("CANCELLED"));
        return;
      }
      p.running++;
      resolve();
    };
    if (p.running < c.concurrency) start();
    else {
      const abort = () => {
        const i = p.waiting.indexOf(item);
        if (i >= 0) {
          p.waiting.splice(i, 1);
          reject(new Error("CANCELLED"));
        }
      };
      const item: WaitingItem = {
        run: () => {
          signal.removeEventListener("abort", abort);
          start();
        },
        reject: (err: Error) => {
          signal.removeEventListener("abort", abort);
          reject(err);
        },
        signal,
        concurrency: c.concurrency,
        basePriority,
        tabId: options.tabId,
        seq: nextQueueSeq++,
      };
      p.waiting.push(item);
      signal.addEventListener("abort", abort, { once: true });
    }
  }).catch((e) => {
    record(span, "queue.end", {
      outcome: "cancelled",
      reason: "CANCELLED",
      queueMs: performance.now() - queued,
    });
    throw e;
  });
  record(span, "queue.end", {
    outcome: "success",
    queueMs: performance.now() - queued,
  });
  try {
    return await run();
  } finally {
    p.running--;
    while (p.waiting.length) {
      // Remove any already-aborted entries first
      for (let i = p.waiting.length - 1; i >= 0; i--) {
        if (p.waiting[i].signal.aborted) p.waiting.splice(i, 1);
      }
      const nextIdx = pickNextWaitingIndex(p.waiting);
      if (nextIdx < 0) break;
      if (p.running >= p.waiting[nextIdx].concurrency) break;
      const [item] = p.waiting.splice(nextIdx, 1);
      item.run();
    }
  }
}

async function rate(c: Config, signal: AbortSignal, t: Trace) {
  const p = pool(c);
  if (c.intervalMs === 0 && p.nextAt <= Date.now()) return;
  const originKey = "nextAt:" + new URL(c.apiUrl).origin;
  const span = childTrace(t),
    started = performance.now();
  record(span, "queue.rate.start", { outcome: "started" });
  const previous = p.rateTail;
  let release!: () => void;
  p.rateTail = new Promise<void>((r) => {
    release = r;
  });
  await previous;
  try {
    const persisted =
      typeof chrome !== "undefined" && chrome.storage?.session
        ? Number((await chrome.storage.session.get(originKey))[originKey]) || 0
        : 0;
    await sleep(Math.max(p.nextAt, persisted) - Date.now(), signal);
    if (c.intervalMs > 0) {
      p.nextAt = Date.now() + c.intervalMs;
      if (typeof chrome !== "undefined" && chrome.storage?.session) {
        await chrome.storage.session.set({ [originKey]: p.nextAt });
      }
    }
    record(span, "queue.rate.end", {
      outcome: "success",
      queueMs: performance.now() - started,
    });
  } catch (e) {
    record(span, "queue.rate.end", {
      outcome: signal.aborted ? "cancelled" : "failed",
      queueMs: performance.now() - started,
    });
    throw e;
  } finally {
    release();
  }
}

export interface RequestDetailedResult {
  text: string;
  usage?: TokenUsage;
}

export async function request(
  c: Config,
  sources: string[],
  trace: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
  extraHeaders?: Record<string, string>,
): Promise<string> {
  const isLocal = c.apiUrl === c.localUrl + "/v1/chat/completions";
  requireValue(c.apiKey, isLocal ? "LOCAL_TOKEN_REQUIRED" : "KEY_REQUIRED");
  requireValue(
    await chrome.permissions.contains({
      origins: [new URL(c.apiUrl).origin + "/*"],
    }),
    isLocal ? "LOCAL_PERMISSION_REQUIRED" : "API_PERMISSION_REQUIRED",
  );
  if (!isLocal) {
    await checkDailyCloudQuota(c);
  }
  const p = pool(c);
  const chars = sources.join("").length;

  for (let attempt = 0; attempt < 3; attempt++) {
    await rate(c, signal, trace);
    const releaseQuota = isLocal ? () => {} : await reserveCloudQuota(c);
    const t = childTrace(trace),
      requestId = crypto.randomUUID(),
      start = performance.now(),
      controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let timeout = false;
    let firstContentReceived = false;
    const timer = setTimeout(() => {
      timeout = true;
      abort();
    }, c.timeoutMs ?? 60000);
    let status = 0,
      retryAfter = 0,
      providerRequestId = "",
      localErrorCode = "";
    record(t, "http.attempt.start", {
      outcome: "started",
      requestId,
      attempt,
      items: sources.length,
      chars,
    });
    onAttempt("request");
    try {
      const prompt = translationPrompt(
        c.modelProfile || c.model,
        sources,
        c.targetLang || "zh-CN",
      );
      const response = await fetch(c.apiUrl, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + c.apiKey,
          traceparent: traceparent(t),
          "X-Request-ID": requestId,
          ...(isLocal
            ? {
                "X-Mistral-Auto-Start": c.localAutoStart ? "1" : "0",
                ...extraHeaders,
              }
            : {}),
        },
        body: JSON.stringify({
          model: c.model,
          stream: true,
          temperature: 0.2,
          ...(isLocal ? { enable_thinking: false } : {}),
          max_tokens: Math.min(8192, Math.max(256, chars * 2)),
          messages: [{ role: "user", content: prompt }],
        }),
      });
      status = response.status;
      providerRequestId =
        response.headers.get("x-request-id") ||
        response.headers.get("request-id") ||
        "";
      if (providerRequestId.includes(c.apiKey)) providerRequestId = "redacted";
      providerRequestId = providerRequestId.slice(0, 160);
      const after = response.headers.get("retry-after");
      retryAfter = after
        ? Number.isFinite(Number(after))
          ? Number(after) * 1000
          : Math.max(0, Date.parse(after) - Date.now())
        : 0;

      if (!response.ok) {
        if (isLocal && status === 503) {
          try {
            const errBody = await response.clone().json();
            const code = errBody?.error?.code;
            if (code === "runtime_loading") {
              localErrorCode = "LOCAL_RUNTIME_LOADING";
              throw Object.assign(new Error("LOCAL_RUNTIME_LOADING"), {
                loadingInfo: errBody.error,
              });
            }
            if (code === "runtime_cooldown") {
              localErrorCode = "LOCAL_RUNTIME_COOLDOWN";
              throw Object.assign(new Error("LOCAL_RUNTIME_COOLDOWN"), {
                cooldownInfo: errBody.error,
              });
            }
            if (code === "runtime_stopped") {
              localErrorCode = "LOCAL_RUNTIME_STOPPED";
              throw new Error("LOCAL_RUNTIME_STOPPED");
            }
          } catch (inner) {
            if (
              inner instanceof Error &&
              inner.message.startsWith("LOCAL_RUNTIME_")
            ) {
              throw inner;
            }
          }
        }
        requireValue(false, "HTTP_" + status);
      }

      record(t, "http.headers", {
        outcome: "success",
        status,
        durationMs: performance.now() - start,
        requestId,
        providerRequestId: providerRequestId || "unavailable",
      });
      const parsed = await providerResult(response, () => {
        firstContentReceived = true;
        record(t, "http.first_content", {
          outcome: "success",
          durationMs: performance.now() - start,
          requestId,
        });
      });
      const text = parsed.text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      requireValue(
        text && !text.includes("<think>"),
        "INVALID_PROVIDER_RESPONSE",
      );
      recordUsageAttempt({
        channel: isLocal ? "local" : "cloud",
        modelKey: c.model,
        isRetry: attempt > 0,
        promptTokens: parsed.usage?.promptTokens ?? Math.ceil(chars / 3.5),
        completionTokens:
          parsed.usage?.completionTokens ?? Math.ceil(text.length / 3.5),
        chars,
        estimated: !parsed.usage,
      });
      record(t, "http.attempt.end", {
        outcome: "success",
        status,
        requestId,
        providerRequestId: providerRequestId || "unavailable",
        attempt,
        durationMs: performance.now() - start,
      });
      return text;
    } catch (error) {
      if (localErrorCode) {
        record(t, "http.attempt.end", {
          outcome: "failed",
          status,
          reason: localErrorCode,
          requestId,
          attempt,
          durationMs: performance.now() - start,
        });
        throw error;
      }

      const partialText =
        error && typeof (error as any).partialText === "string"
          ? ((error as any).partialText as string)
          : "";
      const partialUsage = (error as any)?.usage as TokenUsage | undefined;

      const reason = signal.aborted
        ? "CANCELLED"
        : timeout
          ? "TIMEOUT"
          : error instanceof Error &&
              [
                "EMPTY_RESPONSE",
                "STREAM_INTERRUPTED",
                "TRANSLATION_TRUNCATED",
                "INVALID_PROVIDER_RESPONSE",
                "PROVIDER_RESPONSE_TOO_LARGE",
                "DAILY_QUOTA_REACHED",
              ].includes(error.message)
            ? error.message
            : status
              ? "HTTP_" + status
              : "NETWORK_OR_RESPONSE_ERROR";

      {
        // Count billed/processed attempt in usage statistics even when failed or retried (Q-T08).
        recordUsageAttempt({
          channel: isLocal ? "local" : "cloud",
          modelKey: c.model,
          isRetry: attempt > 0,
          promptTokens: partialUsage?.promptTokens ?? Math.ceil(chars / 3.5),
          completionTokens:
            partialUsage?.completionTokens ??
            Math.ceil(partialText.length / 3.5),
          chars,
          estimated: !partialUsage,
        });
      }

      if (status === 429) {
        const cooldown = Math.min(
          60000,
          Math.max(retryAfter, 1000 * 2 ** attempt),
        );
        p.nextAt = Math.max(p.nextAt, Date.now() + cooldown);
      }

      record(t, "http.attempt.end", {
        outcome: signal.aborted ? "cancelled" : "failed",
        status,
        reason,
        requestId,
        providerRequestId: providerRequestId || "unavailable",
        attempt,
        durationMs: performance.now() - start,
        ...(firstContentReceived ? { source: "after-first-content" } : {}),
      });
      if (signal.aborted) throw Error("CANCELLED");

      // Avoid blindly re-billing a request whose stream already emitted content on timeout (Q-T08);
      // if partial batch content arrived before STREAM_INTERRUPTED, propagate partialText to batch salvager (Q-T04).
      if (
        reason === "STREAM_INTERRUPTED" &&
        partialText &&
        sources.length > 1
      ) {
        throw Object.assign(new Error("STREAM_INTERRUPTED"), { partialText });
      }

      const canRetryTimeout = timeout && !firstContentReceived && attempt < 1;
      const canRetryTransient =
        !timeout &&
        attempt < 2 &&
        (!status ||
          [429, 500, 502, 503, 504].includes(status) ||
          (reason === "STREAM_INTERRUPTED" && !partialText));

      if (canRetryTimeout || canRetryTransient) {
        onAttempt("retry");
        record(childTrace(trace), "queue.retry", {
          outcome: "started",
          attempt: attempt + 1,
          reason,
        });
        await sleep(
          Math.min(60000, Math.max(retryAfter, 1000 * 2 ** attempt)),
          signal,
        );
        continue;
      }
      throw Object.assign(new Error(reason), {
        ...(partialText ? { partialText } : {}),
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      releaseQuota();
    }
  }
  throw Error("ATTEMPTS_EXHAUSTED");
}

export interface ChunkCacheAdapter {
  get(part: string): Promise<string | null>;
  set(part: string, translation: string): Promise<void>;
}

export interface TranslateBatchOptions {
  onSegmentTranslated?: (index: number, translation: string) => void;
  chunkCache?: ChunkCacheAdapter;
  extraHeaders?: Record<string, string>;
}

export interface DetailedBatchResult {
  translations: (string | null)[];
  errors: (string | undefined)[];
}

export async function translateBatchDetailed(
  c: Config,
  sources: string[],
  t: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
  options: TranslateBatchOptions = {},
): Promise<DetailedBatchResult> {
  const isLocal = c.apiUrl === c.localUrl + "/v1/chat/completions";
  if (!isLocal && c.serviceType === "deepl") {
    try {
      const translated = await translateDeeplBatch(
        c,
        sources,
        t,
        signal,
        onAttempt,
      );
      translated.forEach((val, idx) => options.onSegmentTranslated?.(idx, val));
      return {
        translations: translated,
        errors: sources.map(() => undefined),
      };
    } catch (e) {
      const code = e instanceof Error ? e.message : "TRANSLATION_FAILED";
      if (code === "CANCELLED") throw e;
      return {
        translations: sources.map(() => null),
        errors: sources.map(() => code),
      };
    }
  }

  // Long single-segment split with optional per-chunk cache reuse (Q-T11).
  const isSingleProfile = singleTextModel(c.modelProfile || c.model);

  const translateTaggedPiecewise = async (
    seg: string,
    parentTrace: Trace,
  ): Promise<string | undefined> => {
    if (!/__QY\d+__/.test(seg)) return undefined;
    const matches = [...seg.matchAll(/__QY\d+__/g)];
    if (!matches.length) return undefined;

    record(childTrace(parentTrace), "batch.fallback", {
      outcome: "fallback",
      reason: "tagged-span-split",
      items: matches.length,
    });

    let out = seg.slice(0, matches[0].index!);
    for (let i = 0; i < matches.length; i++) {
      if (signal.aborted) throw Error("CANCELLED");
      const token = matches[i][0];
      const spanStart = matches[i].index! + token.length;
      const spanEnd =
        i + 1 < matches.length ? matches[i + 1].index! : seg.length;
      const rawSpan = seg.slice(spanStart, spanEnd);
      const core = rawSpan.trim();
      if (
        !core ||
        !/[a-z\u00c0-\u024f\u0370-\u052f\u0600-\u06ff\u3040-\u30ff\uac00-\ud7af\u3400-\u9fff]/i.test(
          core,
        )
      ) {
        out += token + rawSpan;
        continue;
      }
      const leadWs = rawSpan.match(/^\s*/)?.[0] || "";
      const trailWs = rawSpan.match(/\s*$/)?.[0] || "";
      const pieceVal = await request(
        c,
        [core],
        childTrace(parentTrace),
        signal,
        onAttempt,
        options.extraHeaders,
      );
      if (!validTranslation(core, pieceVal)) return undefined;
      out += token + leadWs + pieceVal.trim() + trailWs;
    }
    return validTranslation(seg, out) ? out : undefined;
  };

  if (
    isSingleProfile &&
    sources.length === 1 &&
    sources[0].length > SPLIT_LIMIT
  ) {
    const parts = splitSegments(sources[0], SPLIT_LIMIT);
    if (parts.length > 1) {
      record(childTrace(t), "batch.fallback", {
        outcome: "fallback",
        reason: "long-segment-split",
        items: parts.length,
        chars: sources[0].length,
      });
      const values: string[] = [];
      for (const part of parts) {
        if (signal.aborted) throw Error("CANCELLED");
        const cachedPart = await options.chunkCache?.get(part);
        if (cachedPart && validTranslation(part, cachedPart)) {
          values.push(cachedPart + (part.match(/\s+$/)?.[0] || ""));
          continue;
        }
        const span = childTrace(t);
        record(span, "segment.start", {
          outcome: "started",
          chars: part.length,
        });
        try {
          let value = await request(
            c,
            [part],
            span,
            signal,
            onAttempt,
            options.extraHeaders,
          );
          if (!validTranslation(part, value) && /__QY\d+__/.test(part)) {
            const recovered = await translateTaggedPiecewise(part, span);
            if (recovered !== undefined) value = recovered;
          }
          requireValue(validTranslation(part, value), "INVALID_TRANSLATION");
          await options.chunkCache?.set(part, value);
          values.push(value + (part.match(/\s+$/)?.[0] || ""));
          record(span, "segment.end", { outcome: "success" });
        } catch (e) {
          const reason = e instanceof Error ? e.message : "TRANSLATION_FAILED";
          record(span, "segment.end", {
            outcome: signal.aborted ? "cancelled" : "failed",
            reason,
          });
          if (
            signal.aborted ||
            reason === "CANCELLED" ||
            reason.startsWith("LOCAL_RUNTIME_")
          ) {
            throw e;
          }
          return { translations: [null], errors: [reason] };
        }
      }
      const joined = values.join("").trim();
      if (!validTranslation(sources[0], joined)) {
        return { translations: [null], errors: ["INVALID_TRANSLATION"] };
      }
      options.onSegmentTranslated?.(0, joined);
      return { translations: [joined], errors: [undefined] };
    }
  }

  if (singleTextModel(c.modelProfile || c.model) && sources.length > 1) {
    record(childTrace(t), "batch.fallback", {
      outcome: "fallback",
      reason: "model-single-text",
      items: sources.length,
    });
    const translations: (string | null)[] = new Array(sources.length).fill(
      null,
    );
    const errors: (string | undefined)[] = new Array(sources.length);
    for (let i = 0; i < sources.length; i++) {
      const sub = await translateBatchDetailed(
        c,
        [sources[i]],
        t,
        signal,
        onAttempt,
        {
          ...options,
          onSegmentTranslated: (_, val) =>
            options.onSegmentTranslated?.(i, val),
        },
      );
      translations[i] = sub.translations[0];
      errors[i] = sub.errors[0];
    }
    return { translations, errors };
  }

  const splitBudget = {
    used: 0,
    max: Math.min(8, Math.max(2, sources.length)),
  };

  const runSubBatch = async (
    subSources: string[],
    subIndexes: number[],
  ): Promise<void> => {
    let text = "";
    try {
      text = await request(
        c,
        subSources,
        t,
        signal,
        onAttempt,
        options.extraHeaders,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : "TRANSLATION_FAILED";
      if (
        signal.aborted ||
        reason === "CANCELLED" ||
        reason.startsWith("LOCAL_RUNTIME_")
      ) {
        throw e;
      }
      // If stream broke partway on a batch, salvage already-completed JSON items first (Q-T04).
      const partialText =
        e && typeof (e as any).partialText === "string"
          ? ((e as any).partialText as string)
          : "";
      if (partialText && subSources.length > 1) {
        const salvaged = parseBatch(partialText, subSources);
        const remainingSources: string[] = [];
        const remainingIndexes: number[] = [];
        salvaged.forEach((val, idx) => {
          const origIdx = subIndexes[idx];
          if (val !== undefined) {
            finalTranslations[origIdx] = val;
            options.onSegmentTranslated?.(origIdx, val);
          } else {
            remainingSources.push(subSources[idx]);
            remainingIndexes.push(origIdx);
          }
        });
        if (!remainingSources.length) return;
        if (
          remainingSources.length < subSources.length &&
          splitBudget.used < splitBudget.max
        ) {
          splitBudget.used++;
          await runSubBatch(remainingSources, remainingIndexes);
          return;
        }
      }

      if (
        subSources.length >= 2 &&
        splitBudget.used + 2 <= splitBudget.max &&
        [
          "HTTP_400",
          "HTTP_413",
          "HTTP_422",
          "STREAM_INTERRUPTED",
          "TRANSLATION_TRUNCATED",
          "INVALID_PROVIDER_RESPONSE",
        ].includes(reason)
      ) {
        splitBudget.used += 2;
        record(childTrace(t), "batch.fallback", {
          outcome: "fallback",
          reason: "batch-rejected-or-truncated",
          items: subSources.length,
        });
        const middle = Math.ceil(subSources.length / 2);
        await runSubBatch(
          subSources.slice(0, middle),
          subIndexes.slice(0, middle),
        );
        await runSubBatch(subSources.slice(middle), subIndexes.slice(middle));
        return;
      }

      for (const origIdx of subIndexes) {
        if (finalTranslations[origIdx] === null) {
          finalErrors[origIdx] = reason;
        }
      }
      return;
    }

    let singleResolved: string | undefined;
    if (subSources.length === 1) {
      if (validTranslation(subSources[0], text)) {
        singleResolved = text;
      } else if (isSingleProfile && /__QY\d+__/.test(subSources[0])) {
        try {
          singleResolved = await translateTaggedPiecewise(subSources[0], t);
        } catch (pieceErr) {
          const r =
            pieceErr instanceof Error ? pieceErr.message : "TRANSLATION_FAILED";
          if (
            signal.aborted ||
            r === "CANCELLED" ||
            r.startsWith("LOCAL_RUNTIME_")
          ) {
            throw pieceErr;
          }
        }
      }
    }

    const parsed =
      subSources.length === 1 ? [singleResolved] : parseBatch(text, subSources);

    const missingLocal: number[] = [];
    parsed.forEach((val, idx) => {
      const origIdx = subIndexes[idx];
      if (val !== undefined) {
        finalTranslations[origIdx] = val;
        options.onSegmentTranslated?.(origIdx, val);
      } else {
        missingLocal.push(idx);
      }
    });

    if (!missingLocal.length) return;

    if (subSources.length === 1 || splitBudget.used >= splitBudget.max) {
      for (const idx of missingLocal) {
        finalErrors[subIndexes[idx]] = "INVALID_TRANSLATION";
      }
      return;
    }

    record(childTrace(t), "batch.fallback", {
      outcome: "fallback",
      reason: "invalid-or-partial-batch",
      items: missingLocal.length,
    });
    const chunkSize = Math.max(1, Math.floor(subSources.length / 2));
    for (let i = 0; i < missingLocal.length; i += chunkSize) {
      if (splitBudget.used >= splitBudget.max) {
        for (const rem of missingLocal.slice(i)) {
          finalErrors[subIndexes[rem]] = "INVALID_TRANSLATION";
        }
        break;
      }
      splitBudget.used++;
      const slice = missingLocal.slice(i, i + chunkSize);
      await runSubBatch(
        slice.map((n) => subSources[n]),
        slice.map((n) => subIndexes[n]),
      );
    }
  };

  const finalTranslations: (string | null)[] = new Array(sources.length).fill(
    null,
  );
  const finalErrors: (string | undefined)[] = new Array(sources.length);

  await runSubBatch(
    sources,
    sources.map((_, i) => i),
  );

  return { translations: finalTranslations, errors: finalErrors };
}

export async function translateBatch(
  c: Config,
  sources: string[],
  t: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
): Promise<string[]> {
  const detailed = await translateBatchDetailed(
    c,
    sources,
    t,
    signal,
    onAttempt,
  );
  const failedIdx = detailed.translations.findIndex((v) => v === null);
  if (failedIdx >= 0) {
    throw new Error(detailed.errors[failedIdx] || "INVALID_TRANSLATION");
  }
  return detailed.translations as string[];
}

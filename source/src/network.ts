import { childTrace, traceparent } from "./trace";
import { record } from "./storage-client";
import {
  parseBatch,
  validTranslation,
  requireValue,
  type Config,
  type Trace,
} from "./types";
import { providerText } from "./provider-response";
import { singleTextModel, translationPrompt } from "./model-profile";
import { splitSegments } from "./segments";
type Pool = {
  running: number;
  nextAt: number;
  rateTail: Promise<void>;
  waiting: { run: () => void; signal: AbortSignal; concurrency: number }[];
};
const pools = new Map<string, Pool>();
function pool(c: Config) {
  const key = new URL(c.apiUrl).origin;
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
): Promise<T> {
  const queued = performance.now(),
    span = childTrace(t),
    p = pool(c);
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
      const item = {
        run: () => {
          signal.removeEventListener("abort", abort);
          start();
        },
        signal,
        concurrency: c.concurrency,
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
    while (p.waiting.length && p.running < p.waiting[0].concurrency) {
      const item = p.waiting.shift()!;
      if (!item.signal.aborted) item.run();
    }
  }
}
async function rate(c: Config, signal: AbortSignal, t: Trace) {
  if (c.intervalMs === 0) return;
  const p = pool(c),
    key = "nextAt:" + new URL(c.apiUrl).origin;
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
    const persisted = Number((await chrome.storage.session.get(key))[key]) || 0;
    await sleep(Math.max(p.nextAt, persisted) - Date.now(), signal);
    p.nextAt = Date.now() + c.intervalMs;
    await chrome.storage.session.set({ [key]: p.nextAt });
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
export async function request(
  c: Config,
  sources: string[],
  trace: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
): Promise<string> {
  requireValue(c.apiKey, "KEY_REQUIRED");
  requireValue(
    await chrome.permissions.contains({
      origins: [new URL(c.apiUrl).origin + "/*"],
    }),
    "API_PERMISSION_REQUIRED",
  );
  for (let attempt = 0; attempt < 3; attempt++) {
    await rate(c, signal, trace);
    const t = childTrace(trace),
      requestId = crypto.randomUUID(),
      start = performance.now(),
      controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      abort();
    }, c.timeoutMs ?? 60000);
    let status = 0,
      retryAfter = 0,
      providerRequestId = "";
    record(t, "http.attempt.start", {
      outcome: "started",
      requestId,
      attempt,
      items: sources.length,
      chars: sources.join("").length,
    });
    onAttempt("request");
    try {
      const prompt = translationPrompt(c.model, sources);
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
          ...(c.apiUrl === c.localUrl + "/v1/chat/completions"
            ? { "X-Mistral-Auto-Start": c.localAutoStart ? "1" : "0" }
            : {}),
        },
        body: JSON.stringify({
          model: c.model,
          stream: true,
          temperature: 0.2,
          max_tokens: Math.min(
            8192,
            Math.max(256, sources.join("").length * 2),
          ),
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
          : Date.parse(after) - Date.now()
        : 0;
      requireValue(response.ok, "HTTP_" + status);
      record(t, "http.headers", {
        outcome: "success",
        status,
        durationMs: performance.now() - start,
        requestId,
        providerRequestId: providerRequestId || "unavailable",
      });
      const responseText = await providerText(response, () => {
        record(t, "http.first_content", {
          outcome: "success",
          durationMs: performance.now() - start,
          requestId,
        });
      });
      const text = responseText
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim();
      requireValue(
        text && !text.includes("<think>"),
        "INVALID_PROVIDER_RESPONSE",
      );
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
      const reason = signal.aborted
        ? "CANCELLED"
        : timeout
          ? "TIMEOUT"
          : error instanceof Error &&
              [
                "TRANSLATION_TRUNCATED",
                "INVALID_PROVIDER_RESPONSE",
                "PROVIDER_RESPONSE_TOO_LARGE",
              ].includes(error.message)
            ? error.message
            : status
              ? "HTTP_" + status
              : "NETWORK_OR_RESPONSE_ERROR";
      record(t, "http.attempt.end", {
        outcome: signal.aborted ? "cancelled" : "failed",
        status,
        reason,
        requestId,
        providerRequestId: providerRequestId || "unavailable",
        attempt,
        durationMs: performance.now() - start,
      });
      if (signal.aborted) throw Error("CANCELLED");
      if (
        attempt < 2 &&
        (!timeout || attempt < 1) &&
        (timeout || !status || [429, 500, 502, 503, 504].includes(status))
      ) {
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
      throw Error(reason);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  throw Error("ATTEMPTS_EXHAUSTED");
}
export async function translateBatch(
  c: Config,
  sources: string[],
  t: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
): Promise<string[]> {
  if (
    singleTextModel(c.model) &&
    sources.length === 1 &&
    sources[0].length > 900
  ) {
    const parts = splitSegments(sources[0]);
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
        // Extremely long protected tokens remain intact, so do not recurse.
        const span = childTrace(t);
        record(span, "segment.start", {
          outcome: "started",
          chars: part.length,
        });
        try {
          const value = await request(c, [part], span, signal, onAttempt);
          requireValue(validTranslation(part, value), "INVALID_TRANSLATION");
          values.push(value + (part.match(/\s+$/)?.[0] || ""));
          record(span, "segment.end", { outcome: "success" });
        } catch (e) {
          record(span, "segment.end", {
            outcome: signal.aborted ? "cancelled" : "failed",
            reason: e instanceof Error ? e.message : "TRANSLATION_FAILED",
          });
          throw e;
        }
      }
      const joined = values.join("").trim();
      requireValue(validTranslation(sources[0], joined), "INVALID_TRANSLATION");
      return [joined];
    }
  }
  if (singleTextModel(c.model) && sources.length > 1) {
    record(childTrace(t), "batch.fallback", {
      outcome: "fallback",
      reason: "model-single-text",
      items: sources.length,
    });
    const result: string[] = [];
    for (const source of sources)
      result.push(...(await translateBatch(c, [source], t, signal, onAttempt)));
    return result;
  }
  let text: string;
  try {
    text = await request(c, sources, t, signal, onAttempt);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "";
    if (
      sources.length < 2 ||
      signal.aborted ||
      ![
        "HTTP_400",
        "HTTP_413",
        "HTTP_422",
        "HTTP_200",
        "TRANSLATION_TRUNCATED",
        "INVALID_PROVIDER_RESPONSE",
      ].includes(reason)
    )
      throw e;
    record(childTrace(t), "batch.fallback", {
      outcome: "fallback",
      reason: "batch-rejected-or-truncated",
      items: sources.length,
    });
    const middle = Math.ceil(sources.length / 2);
    return [
      ...(await translateBatch(
        c,
        sources.slice(0, middle),
        t,
        signal,
        onAttempt,
      )),
      ...(await translateBatch(c, sources.slice(middle), t, signal, onAttempt)),
    ];
  }
  const result =
    sources.length === 1
      ? [validTranslation(sources[0], text) ? text : undefined]
      : parseBatch(text, sources);
  const missing = result.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    requireValue(sources.length > 1, "INVALID_TRANSLATION");
    record(childTrace(t), "batch.fallback", {
      outcome: "fallback",
      reason: "invalid-or-partial-batch",
      items: missing.length,
    });
    for (
      let i = 0;
      i < missing.length;
      i += Math.max(1, Math.floor(sources.length / 2))
    ) {
      const indexes = missing.slice(
        i,
        i + Math.max(1, Math.floor(sources.length / 2)),
      );
      const values = await translateBatch(
        c,
        indexes.map((n) => sources[n]),
        t,
        signal,
        onAttempt,
      );
      indexes.forEach((n, j) => {
        result[n] = values[j];
      });
    }
  }
  return result as string[];
}

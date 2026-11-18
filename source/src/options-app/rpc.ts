import { childTrace, newTrace } from "../trace";
import type { Trace } from "../types";

export interface RpcOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function sendRpc<T = any>(
  type: string,
  payload: Record<string, unknown> = {},
  options: RpcOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? (type === "PRIVATE" ? 10000 : 190000);
  const opId = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;

  const onAbort = () => {
    void chrome.runtime
      .sendMessage({ type: "CANCEL_OP", opId })
      .catch(() => undefined);
  };

  if (options.signal?.aborted) {
    throw new Error("CANCELLED");
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const responsePromise = chrome.runtime.sendMessage({
      type,
      opId,
      ...payload,
    });
    const result = await Promise.race([
      responsePromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onAbort();
          reject(new Error("OPERATION_TIMEOUT"));
        }, timeoutMs);
      }),
      ...(options.signal
        ? [
            new Promise<never>((_, reject) => {
              rejectAbort = () => reject(new Error("CANCELLED"));
              options.signal!.addEventListener("abort", rejectAbort, {
                once: true,
              });
            }),
          ]
        : []),
    ]);
    if (!result?.ok) {
      throw new Error(result?.error || "EXTENSION_UNAVAILABLE");
    }
    return result.data as T;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (rejectAbort) options.signal?.removeEventListener("abort", rejectAbort);
  }
}

export function recordTrace(
  trace: Trace,
  event: string,
  fields: Record<string, unknown> = {},
) {
  return chrome.runtime
    .sendMessage({ type: "TRACE", trace, event, fields })
    .catch(() => undefined);
}

export function scopedRpc(trace: Trace) {
  const request = <T = any>(
    type: string,
    payload: Record<string, unknown> = {},
    options: RpcOptions = {},
  ) =>
    sendRpc<T>(
      type,
      {
        ...payload,
        trace:
          type === "TRACE"
            ? payload.trace || trace
            : childTrace((payload.trace as Trace) || trace),
      },
      options,
    );
  return {
    send: request,
    db: <T = any>(
      operation: string,
      args: unknown[] = [],
      parent = trace,
      options: RpcOptions = {},
    ) => request<T>("DATABASE", { operation, args, trace: parent }, options),
  };
}

export async function runTracedUiOp<T>(
  name: string,
  action: (trace: Trace) => Promise<T>,
  trace = newTrace(),
): Promise<T> {
  const start = performance.now();
  void recordTrace(trace, "ui.start", { outcome: "started", resourceId: name });
  try {
    const result = await action(trace);
    await recordTrace(trace, "ui.end", {
      outcome: "success",
      resourceId: name,
      durationMs: performance.now() - start,
    });
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : "";
    await recordTrace(trace, "ui.end", {
      outcome: /CANCELLED$/.test(msg) ? "cancelled" : "failed",
      resourceId: name,
      durationMs: performance.now() - start,
      reason: /^[A-Z0-9_]+$/.test(msg) ? msg : "UI_OPERATION_FAILED",
    });
    throw error;
  }
}

// Requests all required origins in a SINGLE chrome.permissions.request call so user gesture is never lost (Q-V3, Q-23).
export async function grantOriginsOnce(
  rawUrls: string[],
  trace = newTrace(),
): Promise<void> {
  const patterns = new Set<string>();
  for (const raw of rawUrls) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let u: URL;
    try {
      u = new URL(trimmed);
    } catch {
      throw new Error("INVALID_ENDPOINT");
    }
    if (u.hostname === "[::1]") {
      throw new Error("IPV6_LOCALHOST_UNSUPPORTED");
    }
    patterns.add(u.origin + "/*");
  }
  const origins = [...patterns];
  if (!origins.length) return;

  // Call chrome.permissions.request synchronously in the first turn of the user click handler
  // without a preceding async contains() check, so Chromium's transient user activation is never lost.
  void recordTrace(trace, "permission.start", { outcome: "started" });
  const granted = await chrome.permissions.request({ origins });
  void recordTrace(trace, "permission.end", {
    outcome: granted ? "success" : "failed",
    reason: granted ? undefined : "PERMISSION_DENIED",
  });
  if (!granted) {
    throw new Error("PERMISSION_DENIED");
  }
}

export interface ProviderPreset {
  id: string;
  labelZh: string;
  labelEn: string;
  serviceType: "chat" | "deepl";
  url: string;
  model: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "siliconflow-hy",
    labelZh: "SiliconFlow · Hunyuan-MT-7B（推荐）",
    labelEn: "SiliconFlow · Hunyuan-MT-7B",
    serviceType: "chat",
    url: "https://api.siliconflow.cn/v1/chat/completions",
    model: "tencent/Hunyuan-MT-7B",
  },
  {
    id: "openai",
    labelZh: "OpenAI · gpt-4o-mini",
    labelEn: "OpenAI · gpt-4o-mini",
    serviceType: "chat",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
  },
  {
    id: "deepseek",
    labelZh: "DeepSeek · deepseek-chat",
    labelEn: "DeepSeek · deepseek-chat",
    serviceType: "chat",
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
  },
  {
    id: "gemini",
    labelZh: "Google Gemini（OpenAI 兼容接口）",
    labelEn: "Google Gemini (OpenAI-compatible)",
    serviceType: "chat",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-flash",
  },
  {
    id: "openrouter",
    labelZh: "OpenRouter · qwen/qwen-2.5-72b-instruct",
    labelEn: "OpenRouter · qwen/qwen-2.5-72b-instruct",
    serviceType: "chat",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "qwen/qwen-2.5-72b-instruct",
  },
  {
    id: "deepl-pro",
    labelZh: "DeepL API Pro",
    labelEn: "DeepL API Pro",
    serviceType: "deepl",
    url: "https://api.deepl.com/v2/translate",
    model: "deepl",
  },
  {
    id: "deepl-free",
    labelZh: "DeepL API Free",
    labelEn: "DeepL API Free",
    serviceType: "deepl",
    url: "https://api-free.deepl.com/v2/translate",
    model: "deepl",
  },
];

export function applyThemeDom(theme?: string) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }
}

import { PLACEHOLDER_PATTERN_SOURCE } from "./model-profile";
import { childTrace, traceparent } from "./trace";
import { record } from "./storage-client";
import {
  requireValue,
  validTranslation,
  type Config,
  type Trace,
} from "./types";
import { reserveCloudQuota, recordUsageAttempt } from "./usage";

const DEEPL_LANG_MAP: Record<string, string> = {
  "zh-CN": "ZH-HANS",
  "zh-TW": "ZH-HANT",
  en: "EN",
  ja: "JA",
  ko: "KO",
};

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function encodeDeeplXml(source: string): {
  xml: string;
  tokens: string[];
} {
  const re = new RegExp(PLACEHOLDER_PATTERN_SOURCE, "g");
  const tokens: string[] = [];
  let cursor = 0;
  let xml = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    xml += escapeXml(source.slice(cursor, m.index));
    const idx = tokens.length;
    tokens.push(m[0]);
    xml += `<x id="${idx}"/>`;
    cursor = m.index + m[0].length;
  }
  xml += escapeXml(source.slice(cursor));
  return { xml, tokens };
}

export function decodeDeeplXml(xmlResult: string, tokens: string[]): string {
  const restored = xmlResult.replace(
    /<x\s+id="(\d+)"\s*(?:\/>|><\/x>)/gi,
    (_, idStr) => {
      const idx = Number(idStr);
      return idx >= 0 && idx < tokens.length ? tokens[idx] : "";
    },
  );
  return unescapeXml(restored);
}

export function resolveDeeplEndpoint(c: Config): string {
  if (c.deeplUrl?.trim()) {
    const u = new URL(c.deeplUrl.trim());
    const p = u.pathname.replace(/\/+$/, "");
    u.pathname = p.endsWith("/translate") ? p : (p || "/v2") + "/translate";
    u.hash = "";
    return u.href;
  }
  const isFree = (c.deeplKey || "").trim().endsWith(":fx");
  return isFree
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";
}

export async function translateDeeplBatch(
  c: Config,
  sources: string[],
  trace: Trace,
  signal: AbortSignal,
  onAttempt: (phase?: string) => void,
): Promise<string[]> {
  const key = (c.deeplKey || "").trim();
  requireValue(key, "DEEPL_KEY_REQUIRED");
  const url = resolveDeeplEndpoint(c);
  requireValue(
    await chrome.permissions.contains({
      origins: [new URL(url).origin + "/*"],
    }),
    "API_PERMISSION_REQUIRED",
  );
  const releaseQuota = await reserveCloudQuota(c);

  const encodedItems = sources.map(encodeDeeplXml);
  const targetLang = DEEPL_LANG_MAP[c.targetLang || "zh-CN"] || "ZH-HANS";
  const chars = sources.join("").length;

  const t = childTrace(trace);
  const requestId = crypto.randomUUID();
  const start = performance.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, c.timeoutMs ?? 60000);

  record(t, "http.attempt.start", {
    outcome: "started",
    requestId,
    attempt: 0,
    items: sources.length,
    chars,
    source: "deepl",
  });
  onAttempt("request");

  let status = 0;
  let recordedUsage = false;
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: "DeepL-Auth-Key " + key,
        traceparent: traceparent(t),
        "X-Request-ID": requestId,
      },
      body: JSON.stringify({
        text: encodedItems.map((e) => e.xml),
        target_lang: targetLang,
        tag_handling: "xml",
        ignore_tags: ["x"],
      }),
    });
    status = response.status;
    requireValue(response.ok, "DEEPL_HTTP_" + status);
    const data = await response.json();
    const list = data?.translations;
    requireValue(
      Array.isArray(list) && list.length === sources.length,
      "INVALID_PROVIDER_RESPONSE",
    );
    const decoded = list.map((item: any, idx: number) => {
      const out = decodeDeeplXml(
        String(item?.text || ""),
        encodedItems[idx].tokens,
      );
      requireValue(validTranslation(sources[idx], out), "INVALID_TRANSLATION");
      return out;
    });
    const outChars = decoded.join("").length;
    recordUsageAttempt({
      channel: "cloud",
      modelKey: "deepl",
      isRetry: false,
      promptTokens: Math.ceil(chars / 3.5),
      completionTokens: Math.ceil(outChars / 3.5),
      chars,
    });
    recordedUsage = true;
    record(t, "http.attempt.end", {
      outcome: "success",
      status,
      requestId,
      attempt: 0,
      durationMs: performance.now() - start,
      source: "deepl",
    });
    return decoded;
  } catch (err) {
    const reason = signal.aborted
      ? "CANCELLED"
      : timedOut
        ? "TIMEOUT"
        : err instanceof Error &&
            (err.message.startsWith("DEEPL_HTTP_") ||
              [
                "INVALID_PROVIDER_RESPONSE",
                "INVALID_TRANSLATION",
                "DAILY_QUOTA_REACHED",
              ].includes(err.message))
          ? err.message
          : status
            ? "DEEPL_HTTP_" + status
            : "NETWORK_OR_RESPONSE_ERROR";
    record(t, "http.attempt.end", {
      outcome: signal.aborted ? "cancelled" : "failed",
      status,
      reason,
      requestId,
      attempt: 0,
      durationMs: performance.now() - start,
      source: "deepl",
    });
    throw new Error(reason);
  } finally {
    if (!recordedUsage)
      recordUsageAttempt({
        channel: "cloud",
        modelKey: "deepl",
        isRetry: false,
        promptTokens: 0,
        completionTokens: 0,
        chars,
      });
    releaseQuota();
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

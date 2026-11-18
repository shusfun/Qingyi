import { PLACEHOLDER_PATTERN_SOURCE } from "./model-profile";

export type Outcome =
  | "started"
  | "success"
  | "failed"
  | "cancelled"
  | "paused"
  | "fallback"
  | "complete";
export interface Trace {
  traceId: string;
  operationId: string;
  sessionId?: string;
  batchId?: string;
  spanId: string;
  parentSpanId?: string;
}
export interface TraceEvent extends Trace {
  time: number;
  event: string;
  phase: string;
  outcome: Outcome;
  durationMs?: number;
  queueMs?: number;
  status?: number;
  requestId?: string;
  providerRequestId?: string;
  attempt?: number;
  items?: number;
  chars?: number;
  hits?: number;
  bytes?: number;
  compressedBytes?: number;
  reason?: string;
  resourceId?: string;
  source?: string;
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

export interface TranslationStyleConfig {
  preset?: "default" | "quote" | "soft" | "underline" | "custom";
  opacity?: number;
  gapPx?: number;
  strokePx?: number;
  insetPx?: number;
}

export interface Config {
  modelProfile?: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  intervalMs: number;
  timeoutMs: number;
  concurrency: number;
  mode: "chinese" | "bilingual";
  batch: boolean;
  budgetBytes: number;
  releaseRepo: string;
  routing: "local-first" | "local-only" | "cloud-only";
  localUrl: string;
  localToken: string;
  localModel: string;
  localBackend: "auto" | "cpu" | "cuda" | "metal";
  localAutoStart: boolean;
  localStartupTimeoutMs?: number;
  targetLang?: string;
  translateAttributes?: boolean;
  serviceType?: "chat" | "deepl";
  deeplUrl?: string;
  deeplKey?: string;
  syncDictionary?: boolean;
  dailyRequestLimit?: number;
  dailyTokenLimit?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}
export interface CacheInput {
  source: string;
  scope: string;
  domain: string;
  sourceLang: string;
  targetLang: string;
}
export interface CacheEntry extends CacheInput {
  translation: string;
}
export interface PackEntry {
  source: string;
  translation?: string;
  domain?: string;
  deleted?: boolean;
}
export interface PackManifest {
  format: "qingyi-pack-v1";
  id: string;
  version: number;
  baseVersion: number | null;
  kind: "full" | "delta";
  sourceLang: string;
  targetLang: string;
  domain: string;
  entries: number;
  uncompressedBytes: number;
  blocks: {
    file: string;
    sha256: string;
    bytes: number;
    uncompressedBytes: number;
    entries: number;
  }[];
}
export const MiB = 1024 * 1024;
export const DEFAULTS: Config = {
  apiUrl: "https://api.siliconflow.cn/v1/chat/completions",
  apiKey: "",
  model: "tencent/Hunyuan-MT-7B",
  intervalMs: 1000,
  timeoutMs: 60000,
  concurrency: 2,
  mode: "chinese",
  batch: true,
  budgetBytes: 4 * 1024 * MiB,
  releaseRepo: "shusfun/Qingyi",
  routing: "local-first",
  localUrl: "http://127.0.0.1:19820",
  localToken: "",
  localModel: "HY-MT1.5-1.8B-Q4_K_M.gguf",
  localBackend: "auto",
  localAutoStart: true,
};
export const CONFIG_KEY = "settings.v3",
  OLD_ID = "edhbbapfabbclogflaljpghhfmkopohn";
export const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export async function sha256(value: string | Uint8Array) {
  const data = typeof value === "string" ? encoder.encode(value) : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function requireValue(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) throw new Error(code);
}
export function normalizeSource(value: string) {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

// Normalize BCP-47 language tags while preserving regional Chinese variants and auto/* wildcards (Q-T13).
export function normalizeLang(raw?: string | null): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "auto";
  if (trimmed === "*" || trimmed.toLowerCase() === "auto") {
    return trimmed === "*" ? "*" : "auto";
  }
  const lower = trimmed.replace(/_/g, "-").toLowerCase();
  if (lower.startsWith("zh")) {
    if (
      lower.includes("tw") ||
      lower.includes("hk") ||
      lower.includes("mo") ||
      lower.includes("hant")
    ) {
      return "zh-TW";
    }
    return "zh-CN";
  }
  const primary = lower.split("-")[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : trimmed;
}

// Lightweight script heuristic used only when page lang is "auto" to match unambiguous packs (Q-T13).
export function inferScriptLang(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\uac00-\ud7af]/.test(text)) return "ko";
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const otherScripts = (
    text.match(/[\u00c0-\u024f\u0370-\u052f\u0600-\u06ff]/g) || []
  ).length;
  if (han > latin && han > 0) return "zh-CN";
  if (latin >= 2 && otherScripts === 0 && han === 0) return "en";
  return "auto";
}

export function normalizeLocalOriginUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  // Strip trailing /v1 if user pasted OpenAI base URL from mistral-gui (M-VD).
  return trimmed.replace(/\/v1$/i, "");
}

export function endpoint(value: string) {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error("INVALID_ENDPOINT");
  }
  requireValue(
    !u.username && !u.password && ["https:", "http:"].includes(u.protocol),
    "INVALID_ENDPOINT",
  );
  requireValue(
    u.protocol === "https:" ||
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname),
    "HTTPS_REQUIRED",
  );
  const p = u.pathname.replace(/\/+$/, "");
  u.pathname = p.endsWith("/chat/completions")
    ? p
    : (p || "/v1") + "/chat/completions";
  u.hash = "";
  return u.href;
}

export function configFrom(
  raw: Partial<Config> & {
    clearKey?: boolean;
    clearLocalToken?: boolean;
    clearDeeplKey?: boolean;
  },
  previous = DEFAULTS,
): Config {
  requireValue(raw && typeof raw === "object", "INVALID_CONFIG");
  const c: Config = {
    apiUrl: endpoint(raw.apiUrl || previous.apiUrl),
    apiKey: raw.clearKey
      ? ""
      : typeof raw.apiKey === "string" && raw.apiKey.trim()
        ? raw.apiKey.trim()
        : previous.apiKey,
    model: typeof raw.model === "string" ? raw.model.trim() : previous.model,
    intervalMs: raw.intervalMs ?? previous.intervalMs,
    timeoutMs: raw.timeoutMs ?? previous.timeoutMs ?? DEFAULTS.timeoutMs,
    concurrency: raw.concurrency ?? previous.concurrency,
    mode: raw.mode ?? previous.mode,
    batch: raw.batch ?? previous.batch,
    budgetBytes: raw.budgetBytes ?? previous.budgetBytes,
    releaseRepo:
      typeof raw.releaseRepo === "string"
        ? raw.releaseRepo.trim() || DEFAULTS.releaseRepo
        : previous.releaseRepo?.trim() || DEFAULTS.releaseRepo,
    routing: raw.routing ?? previous.routing ?? DEFAULTS.routing,
    localUrl: normalizeLocalOriginUrl(
      raw.localUrl ?? previous.localUrl ?? DEFAULTS.localUrl,
    ),
    localToken: raw.clearLocalToken
      ? ""
      : raw.localToken?.trim() || previous.localToken || "",
    localModel:
      raw.localModel?.trim() || previous.localModel || DEFAULTS.localModel,
    localBackend: raw.localBackend ?? previous.localBackend ?? "auto",
    localAutoStart: raw.localAutoStart ?? previous.localAutoStart ?? true,
  };
  if (
    raw.localStartupTimeoutMs !== undefined ||
    previous.localStartupTimeoutMs !== undefined
  ) {
    const waitMs =
      raw.localStartupTimeoutMs ?? previous.localStartupTimeoutMs ?? 300000;
    requireValue(
      Number.isFinite(waitMs) && waitMs >= 10000 && waitMs <= 600000,
      "INVALID_LOCAL_CONFIG",
    );
    c.localStartupTimeoutMs = waitMs;
  }
  if (raw.targetLang !== undefined || previous.targetLang !== undefined) {
    const tl = normalizeLang(raw.targetLang ?? previous.targetLang ?? "zh-CN");
    if (
      tl !== "zh-CN" ||
      raw.targetLang !== undefined ||
      previous.targetLang !== undefined
    ) {
      c.targetLang = tl === "auto" || tl === "*" ? "zh-CN" : tl;
    }
  }
  if (
    raw.translateAttributes !== undefined ||
    previous.translateAttributes !== undefined
  ) {
    c.translateAttributes =
      raw.translateAttributes ?? previous.translateAttributes ?? true;
  }
  if (raw.serviceType !== undefined || previous.serviceType !== undefined) {
    const st = raw.serviceType ?? previous.serviceType ?? "chat";
    requireValue(["chat", "deepl"].includes(st), "INVALID_CONFIG");
    c.serviceType = st;
  }
  if (raw.deeplUrl !== undefined || previous.deeplUrl !== undefined) {
    const du = (raw.deeplUrl ?? previous.deeplUrl ?? "").trim();
    if (du) {
      let parsed: URL;
      try {
        parsed = new URL(du);
      } catch {
        throw new Error("INVALID_ENDPOINT");
      }
      requireValue(
        !parsed.username &&
          !parsed.password &&
          (parsed.protocol === "https:" ||
            ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)),
        "HTTPS_REQUIRED",
      );
      c.deeplUrl = parsed.href;
    }
  }
  if (
    raw.clearDeeplKey ||
    raw.deeplKey !== undefined ||
    previous.deeplKey !== undefined
  ) {
    const dk = raw.clearDeeplKey
      ? ""
      : typeof raw.deeplKey === "string" && raw.deeplKey.trim()
        ? raw.deeplKey.trim()
        : previous.deeplKey || "";
    requireValue(dk.length < 8192, "INVALID_KEY");
    if (dk || previous.deeplKey !== undefined || raw.clearDeeplKey) {
      c.deeplKey = dk;
    }
  }
  if (
    raw.syncDictionary !== undefined ||
    previous.syncDictionary !== undefined
  ) {
    c.syncDictionary = !!(raw.syncDictionary ?? previous.syncDictionary);
  }
  if (
    raw.dailyRequestLimit !== undefined ||
    previous.dailyRequestLimit !== undefined
  ) {
    const lim = raw.dailyRequestLimit ?? previous.dailyRequestLimit ?? 0;
    requireValue(
      Number.isFinite(lim) && lim >= 0 && lim <= 10000000,
      "INVALID_CONFIG",
    );
    c.dailyRequestLimit = Math.floor(lim);
  }
  if (
    raw.dailyTokenLimit !== undefined ||
    previous.dailyTokenLimit !== undefined
  ) {
    const lim = raw.dailyTokenLimit ?? previous.dailyTokenLimit ?? 0;
    requireValue(
      Number.isFinite(lim) && lim >= 0 && lim <= 10000000000,
      "INVALID_CONFIG",
    );
    c.dailyTokenLimit = Math.floor(lim);
  }
  if (
    raw.inputPricePerMillion !== undefined ||
    previous.inputPricePerMillion !== undefined
  ) {
    const p = raw.inputPricePerMillion ?? previous.inputPricePerMillion ?? 0;
    requireValue(Number.isFinite(p) && p >= 0 && p <= 100000, "INVALID_CONFIG");
    c.inputPricePerMillion = p;
  }
  if (
    raw.outputPricePerMillion !== undefined ||
    previous.outputPricePerMillion !== undefined
  ) {
    const p = raw.outputPricePerMillion ?? previous.outputPricePerMillion ?? 0;
    requireValue(Number.isFinite(p) && p >= 0 && p <= 100000, "INVALID_CONFIG");
    c.outputPricePerMillion = p;
  }

  requireValue(c.model.length > 0 && c.model.length < 201, "INVALID_MODEL");
  let local: URL;
  try {
    local = new URL(c.localUrl);
  } catch {
    throw new Error("INVALID_LOCAL_ENDPOINT");
  }
  requireValue(local.hostname !== "[::1]", "IPV6_LOCALHOST_UNSUPPORTED");
  requireValue(
    ["localhost", "127.0.0.1"].includes(local.hostname) &&
      ["http:", "https:"].includes(local.protocol) &&
      !local.username &&
      !local.password &&
      !local.search &&
      !local.hash &&
      local.pathname === "/",
    "INVALID_LOCAL_ENDPOINT",
  );
  requireValue(
    ["local-first", "local-only", "cloud-only"].includes(c.routing),
    "INVALID_ROUTING",
  );
  requireValue(
    c.localToken.length < 8192 && typeof c.localAutoStart === "boolean",
    "INVALID_LOCAL_CONFIG",
  );
  requireValue(
    c.localModel.length > 0 &&
      c.localModel.length <= 200 &&
      ["auto", "cpu", "cuda", "metal"].includes(c.localBackend),
    "INVALID_LOCAL_CONFIG",
  );
  requireValue(c.apiKey.length < 8192, "INVALID_KEY");
  requireValue(
    Number.isFinite(c.intervalMs) &&
      c.intervalMs >= 0 &&
      c.intervalMs <= 120000,
    "INVALID_INTERVAL",
  );
  requireValue(
    Number.isFinite(c.timeoutMs) &&
      c.timeoutMs >= 10000 &&
      c.timeoutMs <= 180000,
    "INVALID_TIMEOUT",
  );
  requireValue(
    Number.isInteger(c.concurrency) && c.concurrency >= 1 && c.concurrency <= 4,
    "INVALID_CONCURRENCY",
  );
  requireValue(
    ["chinese", "bilingual"].includes(c.mode) && typeof c.batch === "boolean",
    "INVALID_DISPLAY",
  );
  requireValue(
    Number.isFinite(c.budgetBytes) &&
      c.budgetBytes >= 64 * MiB &&
      c.budgetBytes <= 64 * 1024 * MiB,
    "INVALID_BUDGET",
  );
  requireValue(
    typeof c.releaseRepo === "string" &&
      (!c.releaseRepo || /^[\w.-]+\/[\w.-]+$/.test(c.releaseRepo)),
    "INVALID_REPOSITORY",
  );
  return c;
}
export function publicConfig(c: Config) {
  const { apiKey, localToken, deeplKey, ...rest } = c;
  return {
    ...rest,
    hasKey: !!apiKey,
    hasLocalToken: !!localToken,
    ...(deeplKey !== undefined ? { hasDeeplKey: !!deeplKey } : {}),
  };
}

const placeholderRegex = () => new RegExp(PLACEHOLDER_PATTERN_SOURCE, "g");

export function orderedPlaceholders(s: string): string[] {
  return s.match(placeholderRegex()) || [];
}

export function placeholders(s: string): string[] {
  return [...orderedPlaceholders(s)].sort();
}

// Enforce exact placeholder sequence order on both write and read (Q-T02).
export function validTranslation(
  source: string,
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length < Math.max(4000, source.length * 12) &&
    JSON.stringify(orderedPlaceholders(source)) ===
      JSON.stringify(orderedPlaceholders(value))
  );
}

function extractBatchItems(rawText: string): any[] | null {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const tryParse = (candidate: string): any[] | null => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        for (const key of [
          "translations",
          "items",
          "data",
          "results",
          "output",
        ]) {
          if (Array.isArray((parsed as any)[key])) return (parsed as any)[key];
        }
      }
    } catch {
      // fall through
    }
    return null;
  };

  const direct = tryParse(stripped);
  if (direct) return direct;

  // Extract first '[' ... last ']' if surrounded by conversational preamble/postamble (Q-T09).
  const firstBracket = stripped.indexOf("[");
  const lastBracket = stripped.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const sliced = tryParse(stripped.slice(firstBracket, lastBracket + 1));
    if (sliced) return sliced;
  }

  // Salvage complete {"id":"tN","text":"..."} entries from truncated JSON arrays (Q-T04, Q-T09).
  const salvaged: { id: string; text: string }[] = [];
  const itemRe =
    /\{\s*"id"\s*:\s*"(t\d+)"\s*,\s*"text"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(stripped)) !== null) {
    try {
      salvaged.push({ id: m[1], text: JSON.parse(`"${m[2]}"`) });
    } catch {
      // ignore malformed item
    }
  }
  return salvaged.length ? salvaged : null;
}

export function parseBatch(
  text: string,
  sources: string[],
): (string | undefined)[] {
  const parsed = extractBatchItems(text);
  if (!parsed) return sources.map(() => undefined);
  const map = new Map<string, unknown>(),
    duplicates = new Set<string>();
  for (const item of parsed) {
    if (typeof item?.id !== "string") continue;
    if (map.has(item.id)) duplicates.add(item.id);
    map.set(item.id, item.text);
  }
  return sources.map((source, i) => {
    const id = "t" + i,
      v = map.get(id);
    return !duplicates.has(id) && validTranslation(source, v)
      ? v.trim()
      : undefined;
  });
}

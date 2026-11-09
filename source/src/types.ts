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
export interface Config {
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
export function endpoint(value: string) {
  const u = new URL(value);
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
  raw: Partial<Config> & { clearKey?: boolean; clearLocalToken?: boolean },
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
    releaseRepo: raw.releaseRepo ?? previous.releaseRepo,
    routing: raw.routing ?? previous.routing ?? DEFAULTS.routing,
    localUrl: (raw.localUrl ?? previous.localUrl ?? DEFAULTS.localUrl).replace(
      /\/+$/,
      "",
    ),
    localToken: raw.clearLocalToken
      ? ""
      : raw.localToken?.trim() || previous.localToken || "",
    localModel:
      raw.localModel?.trim() || previous.localModel || DEFAULTS.localModel,
    localBackend: raw.localBackend ?? previous.localBackend ?? "auto",
    localAutoStart: raw.localAutoStart ?? previous.localAutoStart ?? true,
  };
  requireValue(c.model.length > 0 && c.model.length < 201, "INVALID_MODEL");
  const local = new URL(c.localUrl);
  requireValue(
    ["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) &&
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
  const { apiKey, localToken, ...rest } = c;
  return { ...rest, hasKey: !!apiKey, hasLocalToken: !!localToken };
}
export function placeholders(s: string) {
  return (
    s.match(
      /__QY\d+__|https?:\/\/[^\s<>"）)]+|\{\{[^{}]+\}\}|\$\{[^{}]+\}|%[sdif]|\{[a-zA-Z_]\w*\}/g,
    ) || []
  ).sort();
}
export function validTranslation(
  source: string,
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length < Math.max(4000, source.length * 12) &&
    JSON.stringify(placeholders(source)) === JSON.stringify(placeholders(value))
  );
}
export function parseBatch(
  text: string,
  sources: string[],
): (string | undefined)[] {
  try {
    const parsed = JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    );
    if (!Array.isArray(parsed)) return sources.map(() => undefined);
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
  } catch {
    return sources.map(() => undefined);
  }
}

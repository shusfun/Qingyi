import { childTrace, traceparent } from "./trace";
import { requireValue, type Trace, type TraceEvent } from "./types";
import { streamBytes } from "./codec";

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  digest: string | null;
}
export interface ReleaseInfo {
  tag: string;
  version: string;
  notes: string;
  url: string;
  current: string;
  newer: boolean;
  assets: ReleaseAsset[];
  hasChecksum: boolean;
}
export function parseRelease(
  data: unknown,
  repo: string,
  current: string,
): ReleaseInfo {
  requireValue(data && typeof data === "object", "INVALID_RELEASE_RESPONSE");
  const raw = data as Record<string, any>;
  requireValue(typeof raw.tag_name === "string", "INVALID_RELEASE_VERSION");
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.tag_name);
  requireValue(match, "INVALID_RELEASE_VERSION");
  requireValue(
    match
      .slice(1)
      .every((n) => Number.isSafeInteger(Number(n)) && Number(n) <= 65535),
    "INVALID_RELEASE_VERSION",
  );
  const version = match.slice(1).join("."),
    zip = `qingyi-${version}-chromium.zip`;
  const base = `https://github.com/${repo}/releases/`;
  const assets: ReleaseAsset[] = [];
  requireValue(Array.isArray(raw.assets), "INVALID_RELEASE_ASSETS");
  for (const a of raw.assets) {
    if (!a || ![zip, zip + ".sha256"].includes(a.name)) continue;
    requireValue(
      typeof a.browser_download_url === "string",
      "INVALID_RELEASE_ASSET_URL",
    );
    const url = new URL(a.browser_download_url);
    requireValue(
      url.protocol === "https:" &&
        url.hostname === "github.com" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname
          .toLowerCase()
          .startsWith(`/${repo.toLowerCase()}/releases/download/`) &&
        decodeURIComponent(url.pathname.split("/").at(-1)!) === a.name,
      "INVALID_RELEASE_ASSET_URL",
    );
    requireValue(
      Number.isSafeInteger(a.size) && a.size > 0 && a.size <= 128 * 1024 * 1024,
      "INVALID_RELEASE_ASSET_SIZE",
    );
    requireValue(
      !assets.some((x) => x.name === a.name),
      "DUPLICATE_RELEASE_ASSET",
    );
    assets.push({
      name: a.name,
      url: url.href,
      size: a.size,
      digest:
        typeof a.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(a.digest)
          ? a.digest
          : null,
    });
  }
  const numbers = version.split(".").map(Number),
    installed = current.split(".").map(Number);
  let newer = false;
  for (let i = 0; i < 3; i++) {
    if (numbers[i] !== installed[i]) {
      newer = numbers[i] > installed[i];
      break;
    }
  }
  const matched = assets.some((a) => a.name === zip)
    ? assets.sort(
        (a, b) =>
          Number(a.name.endsWith(".sha256")) -
          Number(b.name.endsWith(".sha256")),
      )
    : [];
  return {
    tag: raw.tag_name,
    version,
    notes: typeof raw.body === "string" ? raw.body.slice(0, 20000) : "",
    url:
      typeof raw.html_url === "string" && raw.html_url.startsWith(base)
        ? raw.html_url
        : base,
    current,
    newer,
    assets: matched,
    hasChecksum: matched.some((a) => a.name.endsWith(".sha256") || !!a.digest),
  };
}
export async function fetchRelease(
  repo: string,
  current: string,
  t: Trace,
  dependencies: {
    fetch?: typeof fetch;
    record: (trace: Trace, event: string, fields?: Partial<TraceEvent>) => void;
  },
): Promise<ReleaseInfo> {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repo), "INVALID_REPOSITORY");
  const span = childTrace(t),
    requestId = crypto.randomUUID(),
    start = performance.now();
  let status = 0;
  dependencies.record(span, "release.http.start", {
    outcome: "started",
    requestId,
  });
  try {
    const response = await (dependencies.fetch || fetch)(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          traceparent: traceparent(span),
          "X-Request-ID": requestId,
        },
        signal: AbortSignal.timeout(20000),
        credentials: "omit",
        redirect: "error",
      },
    );
    status = response.status;
    requireValue(response.ok, "RELEASE_HTTP_" + status);
    requireValue(response.body, "EMPTY_RELEASE_RESPONSE");
    const bytes = await streamBytes(response.body, 2 * 1024 * 1024),
      data = JSON.parse(new TextDecoder().decode(bytes)),
      result = parseRelease(data, repo, current);
    dependencies.record(span, "release.http.end", {
      outcome: "success",
      status,
      requestId,
      providerRequestId:
        response.headers.get("x-github-request-id") || "unavailable",
      durationMs: performance.now() - start,
      items: result.assets.length,
    });
    return result;
  } catch (e) {
    dependencies.record(span, "release.http.end", {
      outcome: "failed",
      status,
      requestId,
      durationMs: performance.now() - start,
      reason:
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "RELEASE_NETWORK_OR_RESPONSE_FAILED",
    });
    throw e;
  }
}

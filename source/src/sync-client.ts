import { childTrace, traceparent } from "./trace";
import { requireValue, type Config, type Trace } from "./types";
import { storage, record } from "./storage-client";

interface SyncStateRecord {
  syncedAt?: string;
  revisions?: number;
  packEntries?: number;
  targetUrl?: string;
  sinceTime?: number;
  packVersions?: Record<string, number>;
  error?: string;
}

function localHeaders(c: Config, span: Trace): Record<string, string> {
  requireValue(c.localUrl.trim().length > 0, "LOCAL_URL_REQUIRED");
  requireValue(c.localToken.trim().length > 0, "LOCAL_TOKEN_REQUIRED");
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + c.localToken.trim(),
    traceparent: traceparent(span),
    "X-Request-ID": crypto.randomUUID(),
  };
}

function normalizeLocalBase(localUrl: string): string {
  return localUrl.trim().replace(/\/+$/, "");
}

let syncTail: Promise<unknown> = Promise.resolve();

export function syncDictionaryToManager(
  c: Config,
  t: Trace,
  signal?: AbortSignal,
): Promise<{ revisions: number; packEntries: number }> {
  const run = syncTail.catch(() => {}).then(() => pushDictionary(c, t, signal));
  syncTail = run;
  return run;
}

async function pushDictionary(
  c: Config,
  t: Trace,
  signal?: AbortSignal,
): Promise<{ revisions: number; packEntries: number }> {
  const base = normalizeLocalBase(c.localUrl);
  const stored = await chrome.storage.local.get("sync.status");
  const prev: SyncStateRecord = stored["sync.status"] || {};
  const sameTarget = prev.targetUrl === base;
  const statusResponse = await fetch(`${base}/api/v1/dictionary/status`, {
    headers: localHeaders(c, t),
    signal: signal || AbortSignal.timeout(30000),
    redirect: "error",
  });
  requireValue(
    statusResponse.ok,
    statusResponse.status === 401
      ? "LOCAL_AUTH_FAILED"
      : "LOCAL_MANAGER_OFFLINE",
  );
  const remoteStatus = await statusResponse.json();
  const canReuseVersions =
    sameTarget && remoteStatus?.synced_at === prev.syncedAt;

  const payload = await storage(
    "exportSyncData",
    [
      sameTarget ? prev.sinceTime || 0 : 0,
      canReuseVersions ? prev.packVersions || {} : {},
    ],
    t,
  );

  const span = childTrace(t);
  const start = performance.now();
  record(span, "sync.push.start", { outcome: "started" });

  let resp: Response;
  try {
    resp = await fetch(`${base}/api/v1/dictionary/sync`, {
      method: "POST",
      headers: localHeaders(c, span),
      body: JSON.stringify(payload),
      signal: signal || AbortSignal.timeout(30000),
      redirect: "error",
    });
  } catch {
    record(span, "sync.push.end", {
      outcome: "failed",
      reason: "LOCAL_MANAGER_OFFLINE",
      durationMs: performance.now() - start,
    });
    throw new Error("LOCAL_MANAGER_OFFLINE");
  }

  if (resp.status === 401 || resp.status === 403) {
    record(span, "sync.push.end", {
      outcome: "failed",
      status: resp.status,
      reason: "LOCAL_AUTH_FAILED",
      durationMs: performance.now() - start,
    });
    throw new Error("LOCAL_AUTH_FAILED");
  }
  if (!resp.ok) {
    record(span, "sync.push.end", {
      outcome: "failed",
      status: resp.status,
      reason: "HTTP_" + resp.status,
      durationMs: performance.now() - start,
    });
    throw new Error("HTTP_" + resp.status);
  }

  const body = (await resp.json().catch(() => ({}))) as {
    revisions?: number;
    pack_entries?: number;
    synced_at?: string;
  };
  requireValue(
    Number.isSafeInteger(body.revisions) &&
      Number.isSafeInteger(body.pack_entries) &&
      typeof body.synced_at === "string",
    "INVALID_PROVIDER_RESPONSE",
  );
  const nextPackVersions: Record<string, number> = {};
  for (const p of payload.packs || []) {
    nextPackVersions[p.id] = p.version;
  }
  const revisionsCount =
    typeof body.revisions === "number"
      ? body.revisions
      : (payload.revisions || []).length;
  const packEntriesCount =
    typeof body.pack_entries === "number"
      ? body.pack_entries
      : (payload.packs || []).reduce(
          (acc: number, p: any) => acc + (p.entries?.length || 0),
          0,
        );

  const nextState: SyncStateRecord = {
    syncedAt: body.synced_at || new Date().toISOString(),
    revisions: revisionsCount,
    packEntries: packEntriesCount,
    targetUrl: base,
    sinceTime: payload.maxRevisionTime || prev.sinceTime || 0,
    packVersions: nextPackVersions,
  };
  await chrome.storage.local.set({ "sync.status": nextState });
  record(span, "sync.push.end", {
    outcome: "success",
    status: resp.status,
    durationMs: performance.now() - start,
  });
  return { revisions: revisionsCount, packEntries: packEntriesCount };
}

export async function clearSyncedDictionaryInManager(
  c: Config,
  t: Trace,
  signal?: AbortSignal,
): Promise<void> {
  const base = normalizeLocalBase(c.localUrl);
  const span = childTrace(t);
  record(span, "sync.clear.start", { outcome: "started" });
  let resp: Response;
  try {
    resp = await fetch(`${base}/api/v1/dictionary/clear`, {
      method: "POST",
      headers: localHeaders(c, span),
      body: "{}",
      signal,
    });
  } catch {
    throw new Error("LOCAL_MANAGER_OFFLINE");
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("LOCAL_AUTH_FAILED");
  }
  if (!resp.ok) {
    throw new Error("HTTP_" + resp.status);
  }
  await chrome.storage.local.remove("sync.status");
  record(span, "sync.clear.end", { outcome: "success", status: resp.status });
}

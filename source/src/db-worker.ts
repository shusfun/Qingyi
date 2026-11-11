import { CacheDatabase } from "./db-core";
import { validTrace, newTrace } from "./trace";
import { requireValue, type Trace } from "./types";
let core: CacheDatabase | undefined;
let init: Promise<CacheDatabase> | undefined;
let serial = Promise.resolve();
let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
let maintenanceCancelled = false;
const record = (...args: unknown[]) => postMessage({ kind: "trace", args });
async function database() {
  return (init ??= (async () => {
    requireValue(
      typeof navigator.storage?.getDirectory === "function",
      "OPFS_UNSUPPORTED",
    );
    const path = "./sqlite/index.mjs";
    const sqlite = await (
      await import(path)
    ).default({ print: () => {}, printErr: () => {} });
    const pool = await sqlite.installOpfsSAHPoolVfs({
      name: "qingyi-sahpool-v1",
      directory: ".qingyi-cache-v3",
      initialCapacity: 8,
      clearOnInit: false,
      preserveOnInitFailure: true,
    });
    core = new CacheDatabase(new pool.OpfsSAHPoolDb("/qingyi.sqlite3"), {
      record,
    });
    return core;
  })());
}
const operations = new Set([
  "lookup",
  "lookupModels",
  "enqueue",
  "flush",
  "startPack",
  "appendPack",
  "activatePack",
  "abortPack",
  "rollback",
  "revision",
  "revisionHistory",
  "readRevision",
  "configurePack",
  "clearModels",
  "deletePack",
  "clearRevisions",
  "collect",
  "status",
  "setBudget",
  "maintenanceStop",
]);
onmessage = (event: MessageEvent) => {
  const { id, operation, args = [], trace } = event.data || {};
  serial = serial
    .catch(() => {})
    .then(async () => {
      const t: Trace = validTrace(trace) ? trace : newTrace();
      const began = performance.now();
      record(t, "worker.start", { outcome: "started", resourceId: operation });
      try {
        requireValue(operations.has(operation), "INVALID_DATABASE_OPERATION");
        const db = await database();
        if (operation === "maintenanceStop") {
          clearTimeout(maintenanceTimer);
          maintenanceTimer = undefined;
          maintenanceCancelled = true;
          record(t, "worker.end", {
            outcome: "success",
            resourceId: operation,
          });
          postMessage({ id, ok: true, data: { stopped: true } });
          return;
        }
        const callArgs = [...args];
        if (
          [
            "lookup",
            "lookupModels",
            "enqueue",
            "startPack",
            "appendPack",
            "activatePack",
            "abortPack",
            "rollback",
            "revision",
            "configurePack",
            "clearModels",
            "deletePack",
            "clearRevisions",
            "collect",
          ].includes(operation)
        )
          callArgs.push(t);
        const result = await (db as any)[operation](...callArgs);
        record(t, "worker.end", {
          outcome: "success",
          resourceId: operation,
          durationMs: performance.now() - began,
        });
        postMessage({ id, ok: true, data: result });
        if (
          [
            "enqueue",
            "activatePack",
            "revision",
            "clearModels",
            "deletePack",
            "clearRevisions",
          ].includes(operation) &&
          !maintenanceTimer
        ) {
          maintenanceCancelled = false;
          maintenanceTimer = setTimeout(() => {
            maintenanceTimer = undefined;
            serial = serial
              .catch(() => {})
              .then(async () => {
                if (maintenanceCancelled) return;
                const trace = newTrace();
                record(trace, "operation.start", {
                  outcome: "started",
                  resourceId: "automatic-maintenance",
                });
                try {
                  const result = await db.collect(
                    trace,
                    () => maintenanceCancelled,
                  );
                  record(trace, "operation.end", {
                    outcome: "success",
                    bytes: result.bytes,
                  });
                } catch {
                  record(trace, "operation.end", {
                    outcome: "failed",
                    reason: "MAINTENANCE_FAILED",
                  });
                }
              });
          }, 60000);
        }
      } catch (error) {
        record(t, "worker.end", {
          outcome: "failed",
          resourceId: operation,
          reason: "DATABASE_FAILED",
          durationMs: performance.now() - began,
        });
        postMessage({
          id,
          ok: false,
          error: error instanceof Error ? error.message : "DATABASE_FAILED",
        });
      }
    });
};

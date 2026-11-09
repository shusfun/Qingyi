import { TraceBuffer, validTrace } from "./trace";
import { IndexedTraceSink } from "./trace-idb";
const traces = new TraceBuffer(new IndexedTraceSink());
const worker = new Worker("db-worker.js", { type: "module" });
let sequence = 0;
const pending = new Map<
  number,
  {
    resolve: (x: unknown) => void;
    reject: (x: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
worker.onmessage = (event) => {
  const m = event.data;
  if (m.kind === "trace") {
    const [trace, event, fields] = m.args;
    if (validTrace(trace)) traces.record(trace, event, fields);
    return;
  }
  const waiter = pending.get(m.id);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  pending.delete(m.id);
  m.ok ? waiter.resolve(m.data) : waiter.reject(new Error(m.error));
};
worker.onerror = () => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("DATABASE_WORKER_FAILED_DATA_PRESERVED"));
  }
  pending.clear();
};
function rawDb(operation: string, args: unknown[], trace: unknown) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("DATABASE_TIMEOUT_OUTCOME_UNKNOWN"));
    }, 120000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, operation, args, trace });
  });
}
let requestedBudget: number | undefined;
let configuredBudget: number | undefined;
let configuring: Promise<void> = Promise.resolve();
async function db(operation: string, args: unknown[], trace: unknown) {
  configuring = configuring
    .catch(() => {})
    .then(async () => {
      if (requestedBudget && requestedBudget !== configuredBudget) {
        await rawDb("setBudget", [requestedBudget], undefined);
        configuredBudget = requestedBudget;
      }
    });
  await configuring;
  return rawDb(operation, args, trace);
}
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  if (m?.target !== "qingyi-offscreen" || sender.id !== chrome.runtime.id)
    return;
  void (async () => {
    switch (m.operation) {
      case "ready":
        if (m.budget) requestedBudget = m.budget;
        return { ready: true };
      case "trace.record":
        if (validTrace(m.trace)) traces.record(m.trace, m.event, m.fields);
        return;
      case "trace.read":
        return {
          events: await traces.read(
            m.args?.[0],
            m.args?.[1],
            m.args?.[2],
            m.args?.[3],
          ),
          stats: traces.stats(),
        };
      case "trace.clear":
        return traces.clear();
      default:
        return db(m.operation, m.args || [], m.trace);
    }
  })().then(
    (data) => respond({ ok: true, data }),
    (e) => respond({ ok: false, error: e.message }),
  );
  return true;
});

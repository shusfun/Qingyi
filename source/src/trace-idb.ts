import type { TraceEvent } from "./types";
import type { TraceSink } from "./trace";
export class IndexedTraceSink implements TraceSink {
  private database?: Promise<IDBDatabase>;
  private submittedBytes = 0;
  private transactions = 0;
  stats() {
    return {
      diagnosticSubmittedBytes: this.submittedBytes,
      diagnosticTransactions: this.transactions,
    };
  }
  private open() {
    return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("qingyi-traces-v3", 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        const s = db.objectStoreNames.contains("events")
          ? r.transaction!.objectStore("events")
          : db.createObjectStore("events", { autoIncrement: true });
        if (!s.indexNames.contains("traceId"))
          s.createIndex("traceId", "traceId");
        if (!s.indexNames.contains("time")) s.createIndex("time", "event.time");
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      };
      r.onerror = () => {
        this.database = undefined;
        reject(r.error);
      };
      r.onblocked = () => {
        this.database = undefined;
        reject(new Error("TRACE_DATABASE_BLOCKED"));
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => {
          r.result.close();
          this.database = undefined;
        };
        resolve(r.result);
      };
    }));
  }
  async append(events: TraceEvent[]) {
    const db = await this.open();
    let submitted = 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["events", "meta"], "readwrite"),
        store = tx.objectStore("events"),
        meta = tx.objectStore("meta"),
        req = meta.get("bytes");
      req.onsuccess = () => {
        let total = Number(req.result) || 0;
        for (const event of events) {
          const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
          submitted += bytes + 96;
          store.add({ event, bytes, traceId: event.traceId });
          total += bytes;
        }
        const cursor = store.index("time").openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (
            item &&
            (total > 5 * 1024 * 1024 ||
              item.value.event.time < Date.now() - 14 * 86400000)
          ) {
            total -= item.value.bytes;
            submitted += item.value.bytes + 96;
            item.delete();
            item.continue();
            return;
          }
          meta.put(total, "bytes");
        };
      };
      tx.oncomplete = () => {
        this.transactions++;
        this.submittedBytes += submitted + 128;
        resolve();
      };
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async read(traceId?: string, batchId?: string, limit?: number) {
    const db = await this.open();
    return new Promise<TraceEvent[]>((resolve, reject) => {
      const tx = db.transaction("events", "readonly"),
        s = tx.objectStore("events"),
        request = traceId
          ? s.index("traceId").openCursor(IDBKeyRange.only(traceId), "prev")
          : s.openCursor(null, "prev"),
        out: TraceEvent[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const event = cursor.value.event;
        if (!batchId || event.batchId === batchId) out.push(event);
        if (limit !== undefined && out.length >= limit) return;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(out.reverse());
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  async clear() {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["events", "meta"], "readwrite");
      tx.objectStore("events").clear();
      tx.objectStore("meta").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
}

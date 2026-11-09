import type { Trace, TraceEvent } from "./types";
export const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export function newTrace(sessionId?: string): Trace {
  return {
    traceId: hex(16),
    operationId: crypto.randomUUID(),
    sessionId,
    spanId: hex(8),
  };
}
export function validTrace(t: unknown): t is Trace {
  const x = t as Trace;
  return (
    !!x &&
    /^[a-f0-9]{32}$/.test(x.traceId) &&
    !/^0+$/.test(x.traceId) &&
    /^[a-f0-9]{16}$/.test(x.spanId) &&
    !/^0+$/.test(x.spanId) &&
    typeof x.operationId === "string" &&
    x.operationId.length <= 80
  );
}
export function childTrace(t: Trace, extra: Partial<Trace> = {}): Trace {
  return { ...t, parentSpanId: t.spanId, spanId: hex(8), ...extra };
}
export function traceparent(t: Trace) {
  return `00-${t.traceId}-${t.spanId}-01`;
}
const strings = [
  "traceId",
  "operationId",
  "sessionId",
  "batchId",
  "spanId",
  "parentSpanId",
  "event",
  "phase",
  "outcome",
  "requestId",
  "providerRequestId",
  "reason",
  "resourceId",
  "source",
] as const;
const numbers = [
  "time",
  "durationMs",
  "queueMs",
  "status",
  "attempt",
  "items",
  "chars",
  "hits",
  "bytes",
  "compressedBytes",
] as const;
export function sanitizeTrace(input: TraceEvent): TraceEvent {
  const clean: Record<string, unknown> = {};
  for (const k of strings)
    if (typeof input[k] === "string") clean[k] = String(input[k]).slice(0, 160);
  for (const k of numbers)
    if (typeof input[k] === "number" && Number.isFinite(input[k]))
      clean[k] = input[k];
  return clean as unknown as TraceEvent;
}
export interface TraceSink {
  append(events: TraceEvent[]): Promise<void>;
  read(
    traceId?: string,
    batchId?: string,
    limit?: number,
  ): Promise<TraceEvent[]>;
  clear(): Promise<void>;
  stats?(): Record<string, number>;
}
export class TraceBuffer {
  private events: TraceEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = 0;
  private serial = Promise.resolve();
  dropped = 0;
  flushes = 0;
  constructor(
    private sink: TraceSink,
    private now = () => Date.now(),
    private interval = 60000,
  ) {}
  record(trace: Trace, event: string, fields: Partial<TraceEvent> = {}) {
    if (this.events.length >= 6000) {
      this.dropped++;
      return;
    }
    this.events.push(
      sanitizeTrace({
        ...trace,
        time: this.now(),
        event,
        phase: event.split(".")[0],
        outcome: "complete",
        ...fields,
      }),
    );
    if (!this.timer)
      this.timer = setTimeout(
        () => {
          this.timer = undefined;
          void this.flush().catch(() => {});
        },
        Math.max(0, this.lastFlush + this.interval - this.now(), this.interval),
      );
  }
  async flush() {
    if (!this.events.length) return;
    const delay = this.lastFlush + this.interval - this.now();
    if (delay > 0) {
      if (!this.timer)
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.flush().catch(() => {});
        }, delay);
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.lastFlush = this.now();
    const batch = this.events.splice(0);
    this.serial = this.serial
      .catch(() => {})
      .then(async () => {
        try {
          await this.sink.append(batch);
          this.flushes++;
        } catch (e) {
          const available = Math.max(0, 6000 - this.events.length);
          if (available) this.events.unshift(...batch.slice(-available));
          this.dropped += Math.max(0, batch.length - available);
          throw e;
        }
      });
    try {
      await this.serial;
    } finally {
      if (this.events.length && !this.timer)
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            void this.flush().catch(() => {});
          },
          Math.max(1, this.lastFlush + this.interval - this.now()),
        );
    }
  }
  async read(traceId?: string, batchId?: string, limit?: number, offset = 0) {
    await this.serial.catch(() => {});
    const bounded =
      limit == null ? undefined : Math.max(1, Math.min(200, Math.floor(limit)));
    offset = Math.max(0, Math.min(50000, Math.floor(offset) || 0));
    const rows = await this.sink.read(
      traceId,
      batchId,
      bounded === undefined ? undefined : bounded + offset,
    );
    const result = [
      ...rows,
      ...this.events.filter(
        (e) =>
          (!traceId || e.traceId === traceId) &&
          (!batchId || e.batchId === batchId),
      ),
    ];
    return bounded === undefined
      ? result
      : result.slice(
          Math.max(0, result.length - offset - bounded),
          Math.max(0, result.length - offset),
        );
  }
  async clear() {
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.serial.catch(() => {});
    this.events = [];
    await this.sink.clear();
  }
  stats() {
    return {
      pending: this.events.length,
      dropped: this.dropped,
      flushes: this.flushes,
      ...this.sink.stats?.(),
    };
  }
}

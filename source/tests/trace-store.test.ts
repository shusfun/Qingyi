import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { IndexedTraceSink } from "../src/trace-idb";
import { TraceBuffer, newTrace } from "../src/trace";
test("real trace store transactions, trace query, time retention and clear", async () => {
  const sink = new IndexedTraceSink();
  await sink.clear();
  const a = newTrace(),
    b = newTrace();
  const event = (t: any, time = Date.now()) => ({
    ...t,
    time,
    event: "operation.end",
    phase: "operation",
    outcome: "success" as const,
  });
  await sink.append([event(a), event(b)]);
  assert.equal((await sink.read(a.traceId)).length, 1);
  await sink.append([event(a, Date.now() - 15 * 86400000)]);
  await sink.append([event(b)]);
  assert.ok(
    (await sink.read()).every((e) => e.time > Date.now() - 14 * 86400000),
  );
  await sink.clear();
  assert.equal((await sink.read()).length, 0);
});
test("trace quota failure keeps events and throttles retries", async () => {
  let now = 100000,
    writes = 0;
  const sink = {
    append: async () => {
      writes++;
      if (writes === 1) throw Error("QUOTA");
    },
    read: async () => [],
    clear: async () => {},
  };
  const b = new TraceBuffer(sink, () => now),
    t = newTrace();
  b.record(t, "operation.start");
  await assert.rejects(b.flush(), /QUOTA/);
  assert.equal((await b.read()).length, 1);
  await b.flush();
  assert.equal(writes, 1);
  now += 60000;
  await b.flush();
  assert.equal(writes, 2);
  await b.clear();
});

test("retained operations beyond 6000 events remain queryable and exportable from their root", async () => {
  const sink = new IndexedTraceSink();
  await sink.clear();
  const t = newTrace(),
    now = Date.now();
  await sink.append(
    Array.from({ length: 6500 }, (_, i) => ({
      ...t,
      time: now,
      event:
        i === 0
          ? "operation.start"
          : i === 6499
            ? "operation.end"
            : "cache.lookup",
      phase: "operation",
      outcome: "success" as const,
    })),
  );
  const buffer = new TraceBuffer(sink),
    rows = await buffer.read(t.traceId);
  assert.equal(rows.length, 6500);
  assert.equal(rows[0].event, "operation.start");
  assert.equal(rows.at(-1)?.event, "operation.end");
  const first = await buffer.read(t.traceId, undefined, 200);
  const second = await buffer.read(t.traceId, undefined, 200, 200);
  assert.equal(first.length, 200);
  assert.equal(second.length, 200);
  assert.equal(first.at(-1)?.event, "operation.end");
  assert.equal(second.at(-1)?.event, "cache.lookup");
  // Paging across the pending/persisted boundary must not skip or repeat rows.
  buffer.record(t, "pending.only");
  assert.equal(
    (await buffer.read(t.traceId, undefined, 1)).at(-1)?.event,
    "pending.only",
  );
  assert.equal(
    (await buffer.read(t.traceId, undefined, 1, 1)).at(-1)?.event,
    "operation.end",
  );
  assert.equal((await buffer.read(t.traceId)).length, 6501);
  // Chrome runtime messaging serializes optional array slots as null.
  assert.equal(
    (await buffer.read(t.traceId, undefined, null as any)).length,
    6501,
  );
  await buffer.clear();
});

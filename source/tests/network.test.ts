import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DEFAULTS } from "../src/types";
import { newTrace } from "../src/trace";
import { translationPolicy } from "../src/model-profile";
import { translateBatch } from "../src/network";

test("Hunyuan-MT uses the official segment contract and preserves attempt linkage over HTTP", async () => {
  const events: any[] = [],
    requests: any[] = [];
  const session: Record<string, any> = {};
  (globalThis as any).chrome = {
    permissions: { contains: async () => true },
    storage: {
      local: { get: async () => ({}) },
      session: {
        get: async () => session,
        set: async (v: any) => Object.assign(session, v),
      },
    },
    offscreen: { hasDocument: async () => true },
    runtime: {
      sendMessage: async (m: any) => {
        if (m.operation === "trace.record") events.push(m.args?.[0] || m);
        return { ok: true };
      },
    },
  };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    requests.push({ headers: req.headers, data });
    const content = data.messages[0].content;
    if (
      content.endsWith("retry source") &&
      requests.filter((r) =>
        r.data.messages[0].content.endsWith("retry source"),
      ).length === 1
    ) {
      res.writeHead(429, { "Retry-After": "0" }).end("{}");
      return;
    }
    const text = content.endsWith("Hello.")
      ? "你好。"
      : content.endsWith("retry source")
        ? "重试译文"
        : "__QY0__前往__QY1__";
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Request-ID": "provider-" + requests.length,
    });
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: text } }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address() as any,
      config = {
        ...DEFAULTS,
        apiKey: "synthetic-network-key",
        apiUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        model: "tencent/Hunyuan-MT-7B",
        intervalMs: 0,
      },
      t = newTrace();
    const result = await translateBatch(
      config,
      ["Hello.", "__QY0__Go__QY1__"],
      t,
      new AbortController().signal,
      () => {},
    );
    assert.deepEqual(result, ["你好。", "__QY0__前往__QY1__"]);
    assert.equal(requests.length, 2);
    assert.equal(
      requests[0].data.messages[0].content,
      "Translate the following segment into Chinese, without additional explanation.\n\nHello.",
    );
    assert.ok(
      requests.every((r) =>
        r.headers.traceparent.startsWith("00-" + t.traceId + "-"),
      ),
    );
    assert.equal(
      new Set(requests.map((r) => r.headers["x-request-id"])).size,
      2,
    );
    assert.notEqual(
      translationPolicy(config.model),
      translationPolicy("generic-chat"),
    );
    await translateBatch(
      config,
      ["retry source"],
      t,
      new AbortController().signal,
      () => {},
    );
    const attempts = requests.slice(2);
    assert.equal(attempts.length, 2);
    assert.notEqual(
      attempts[0].headers.traceparent,
      attempts[1].headers.traceparent,
    );
    assert.notEqual(
      attempts[0].headers["x-request-id"],
      attempts[1].headers["x-request-id"],
    );
    await new Promise((r) => setTimeout(r, 25));
    const records = events.map((m) => ({
      trace: m.trace,
      event: m.event,
      fields: m.fields,
    }));
    assert.ok(
      records.some(
        (e) =>
          e.event === "batch.fallback" &&
          e.fields.reason === "model-single-text",
      ),
    );
    assert.ok(
      records.some(
        (e) => e.event === "http.attempt.end" && e.fields.status === 429,
      ),
    );
    assert.ok(
      records.some(
        (e) =>
          e.event === "http.attempt.end" &&
          e.fields.providerRequestId?.startsWith("provider-"),
      ),
    );
    assert.ok(!JSON.stringify(events).includes(config.apiKey));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DEFAULTS, placeholders } from "../src/types";
import { newTrace } from "../src/trace";
import { translateBatch } from "../src/network";
test("long Hunyuan text is bounded, slow responses survive 25 seconds, timeout retries and cancellation stay bounded", async () => {
  const events: any[] = [],
    requests: any[] = [],
    session: any = {};
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
        if (m.operation === "trace.record") events.push(m);
        return { ok: true };
      },
    },
  };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const data = JSON.parse(body),
      source = data.messages[0].content.split("\n\n").slice(1).join("\n\n");
    requests.push({ source, headers: req.headers });
    if (source === "stream source") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (content: string, finish_reason: any = null) =>
        "data: " +
        JSON.stringify({ choices: [{ delta: { content }, finish_reason }] }) +
        "\n\n";
      const bytes = Buffer.from(
        event("流式") + event("译文", "stop") + "data: [DONE]\n\n",
      );
      res.write(bytes.subarray(0, 20));
      res.end(bytes.subarray(20));
      return;
    }
    if (source === "slow source")
      await new Promise((r) => setTimeout(r, 26000));
    if (source === "timeout source" || source === "cancel source")
      await new Promise((r) => setTimeout(r, 200));
    if (res.destroyed) return;
    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Request-ID": "recovery-" + requests.length,
    });
    res.end(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: "译文" + source } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const config = {
        ...DEFAULTS,
        intervalMs: 0,
        apiKey: "synthetic-key",
        apiUrl: `http://127.0.0.1:${(server.address() as any).port}/v1/chat/completions`,
      },
      t = newTrace();
    const source =
      "__QY0__" +
      "Long English sentence about reading translated websites. ".repeat(70) +
      "__QY1__";
    const [translated] = await translateBatch(
      config,
      [source],
      t,
      new AbortController().signal,
      () => {},
    );
    assert.ok(requests.length >= 4);
    assert.ok(requests.every((r) => r.source.length <= 900));
    assert.deepEqual(placeholders(source), placeholders(translated));
    assert.ok(
      requests.every((r) =>
        r.headers.traceparent.startsWith("00-" + t.traceId + "-"),
      ),
    );
    await translateBatch(
      config,
      ["slow source"],
      t,
      new AbortController().signal,
      () => {},
    );
    assert.deepEqual(
      await translateBatch(
        config,
        ["stream source"],
        t,
        new AbortController().signal,
        () => {},
      ),
      ["流式译文"],
    );
    const failed = newTrace();
    await assert.rejects(
      translateBatch(
        { ...config, timeoutMs: 50 },
        ["timeout source"],
        failed,
        new AbortController().signal,
        () => {},
      ),
      /TIMEOUT/,
    );
    assert.equal(
      requests.filter((r) => r.source === "timeout source").length,
      2,
    );
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    await assert.rejects(
      translateBatch(
        config,
        ["cancel source"],
        newTrace(),
        abort.signal,
        () => {},
      ),
      /CANCELLED/,
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      events.some(
        (e) =>
          e.event === "batch.fallback" &&
          e.fields.reason === "long-segment-split",
      ),
    );
    assert.equal(
      events.filter(
        (e) =>
          e.trace.traceId === failed.traceId &&
          e.event === "http.attempt.end" &&
          e.fields.reason === "TIMEOUT",
      ).length,
      2,
    );
    assert.ok(!JSON.stringify(events).includes(config.apiKey));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

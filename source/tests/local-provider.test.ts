import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { DEFAULTS, type CacheInput } from "../src/types";
import { newTrace } from "../src/trace";
import { providerScope, translateRouted } from "../src/local-provider";
import { schedule } from "../src/network";

test("local routing isolates cache revisions, falls back per paragraph and propagates correlation", async () => {
  const events: any[] = [],
    requests: any[] = [],
    payloads: any[] = [],
    cache = new Map<string, string>();
  const session: Record<string, any> = {};
  (globalThis as any).chrome = {
    permissions: { contains: async () => true },
    offscreen: { hasDocument: async () => true },
    storage: {
      local: { get: async () => ({}) },
      session: {
        get: async () => session,
        set: async (v: any) => Object.assign(session, v),
      },
    },
    runtime: {
      sendMessage: async (m: any) => {
        if (m.operation === "trace.record") events.push(m);
        if (m.operation === "lookupModels")
          return {
            ok: true,
            data: {
              translations: m.args[0].map((x: any) =>
                cache.get(x.scope + ":" + x.source),
              ),
            },
          };
        return { ok: true };
      },
    },
  };
  let revision = "rev1",
    deploymentRevision = "config1",
    statusModel = "translation";
  const server = http.createServer(async (req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    if (req.url?.startsWith("/api/v1/status?model=")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          settings: { model: statusModel },
          status: { state: "stopped" },
          model_revision: revision,
          selected_backend: "cpu",
          deployments: [
            {
              id: statusModel,
              model: DEFAULTS.localModel,
              model_name: "tencent/HY-MT1.5-1.8B",
              deployment_revision: deploymentRevision,
            },
          ],
        }),
      );
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const data = JSON.parse(raw);
    payloads.push(data);
    if (
      req.url === "/v1/chat/completions" &&
      data.messages[0].content.endsWith("bad")
    ) {
      res.writeHead(422).end("{}");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: req.url === "/cloud" ? "云端译文" : "本地译文",
            },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = "http://127.0.0.1:" + (server.address() as any).port;
  const config = {
    ...DEFAULTS,
    localUrl: url,
    localToken: "local-synthetic",
    localModel: "translation",
    apiUrl: url + "/cloud",
    apiKey: "cloud-synthetic",
    model: "tencent/Hunyuan-MT-7B",
    intervalMs: 0,
  };
  const inputs: CacheInput[] = ["good", "bad"].map((source) => ({
    source,
    scope: "dictionary",
    domain: "example.com",
    sourceLang: "en",
    targetLang: "zh-CN",
  }));
  const t = newTrace(),
    signal = new AbortController().signal;
  try {
    const a = await translateRouted(config, inputs, t, signal, () => {});
    assert.deepEqual(a.translations, ["本地译文", "云端译文"]);
    assert.equal(a.hits, 0);
    assert.ok(
      payloads.some(
        (p) =>
          p.model === "translation" &&
          p.messages[0].content.startsWith("Translate the following segment"),
      ),
      "deployment alias must retain the underlying HY-MT prompt contract",
    );
    assert.ok(
      a.entries.find((x) => x.source === "good")?.scope.startsWith("local:"),
    );
    assert.ok(
      !a.entries.find((x) => x.source === "bad")?.scope.startsWith("local:"),
    );
    assert.ok(
      requests.every((r) =>
        r.headers.traceparent.startsWith("00-" + t.traceId + "-"),
      ),
    );
    for (const entry of a.entries)
      cache.set(entry.scope + ":" + entry.source, entry.translation);
    const count = requests.length;
    assert.deepEqual(
      (await translateRouted(config, [inputs[0]], t, signal, () => {}))
        .translations,
      ["本地译文"],
    );
    assert.equal(
      requests.length,
      count + 1,
      "cache hit must only read manager revision and must not start inference",
    );
    revision = "rev2";
    await translateRouted(config, [inputs[0]], t, signal, () => {});
    assert.equal(
      requests.length,
      count + 3,
      "new model revision must invalidate local inference cache",
    );
    revision = "rev1";
    const stoppedBefore = requests.length;
    const stoppedCache = await translateRouted(
      { ...config, routing: "local-only", localAutoStart: false },
      [inputs[0]],
      t,
      signal,
      () => {},
    );
    assert.deepEqual(stoppedCache.translations, ["本地译文"]);
    assert.equal(stoppedCache.hits, 1);
    assert.equal(
      requests.length,
      stoppedBefore + 1,
      "stopped model cache must not start inference",
    );
    await assert.rejects(
      translateRouted(
        { ...config, routing: "local-only", localAutoStart: false },
        [{ ...inputs[0], source: "not cached" }],
        t,
        signal,
        () => {},
      ),
      /LOCAL_RUNTIME_STOPPED/,
    );
    assert.equal(
      requests.length,
      stoppedBefore + 2,
      "disabled auto-start cache miss must not call inference",
    );
    deploymentRevision = "config2";
    const changed = await translateRouted(
      config,
      [inputs[0]],
      t,
      signal,
      () => {},
    );
    assert.equal(
      changed.hits,
      0,
      "deployment tuning change must invalidate the local cache",
    );
    statusModel = "different-model";
    const before = requests.filter((r) => r.path === "/cloud").length;
    await assert.rejects(
      translateRouted(
        { ...config, routing: "local-only" },
        inputs,
        t,
        signal,
        () => {},
      ),
      /LOCAL_MODEL_MISMATCH/,
    );
    assert.equal(requests.filter((r) => r.path === "/cloud").length, before);
    const cloudOnlyBefore = requests.filter(
      (r) => r.path === "/api/v1/status",
    ).length;
    await translateRouted(
      { ...config, routing: "cloud-only" },
      [inputs[0]],
      t,
      signal,
      () => {},
    );
    assert.equal(
      requests.filter((r) => r.path === "/api/v1/status").length,
      cloudOnlyBefore,
    );
    assert.notEqual(
      await providerScope(config),
      await providerScope(config, true, "rev2"),
    );
    assert.ok(
      events.some(
        (e) => e.event === "provider.fallback" && e.trace.traceId === t.traceId,
      ),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a saturated cloud queue cannot block another local provider", async () => {
  const cloud = {
    ...DEFAULTS,
    apiUrl: "https://cloud-queue.example/v1/chat/completions",
    concurrency: 1,
  };
  const local = {
    ...cloud,
    apiUrl: "http://127.0.0.1:19820/v1/chat/completions",
  };
  let release!: () => void;
  const first = schedule(
    cloud,
    newTrace(),
    new AbortController().signal,
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  await new Promise((r) => setTimeout(r, 0));
  const aborted = new AbortController();
  const second = schedule(cloud, newTrace(), aborted.signal, async () => {
    throw Error("queued request ran");
  });
  const rejected = assert.rejects(second, /CANCELLED/);
  aborted.abort();
  assert.equal(
    await schedule(
      local,
      newTrace(),
      new AbortController().signal,
      async () => "local ran",
    ),
    "local ran",
  );
  release();
  await first;
  await rejected;
});

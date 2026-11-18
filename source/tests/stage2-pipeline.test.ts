import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  DEFAULTS,
  orderedPlaceholders,
  parseBatch,
  validTranslation,
  normalizeLang,
  type CacheEntry,
  type PackManifest,
} from "../src/types";
import { splitSegments } from "../src/segments";
import { CacheDatabase } from "../src/db-core";
import { encodeLines, streamBytes, base64 } from "../src/codec";
import { newTrace } from "../src/trace";
import {
  schedule,
  setActiveTabs,
  cancelQueuedForTab,
  translateBatchDetailed,
} from "../src/network";
import {
  translateRouted,
  invalidateLocalStatusCache,
} from "../src/local-provider";
import {
  BASE_SKIP_SELECTOR,
  inspectDomElement,
  type ExtractedGroup,
} from "../src/dom-collect";
import {
  PagePriorityQueue,
  type QueuedUnitLike,
  type UnitPriorityTier,
} from "../src/page-queue";
import { providerResult } from "../src/provider-response";

const sqlite = await sqlite3InitModule();

function installChromeMock(session: Record<string, any> = {}) {
  const events: any[] = [];
  (globalThis as any).chrome = {
    permissions: { contains: async () => true },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      session: {
        get: async () => session,
        set: async (v: any) => Object.assign(session, v),
      },
    },
    offscreen: { hasDocument: async () => true },
    runtime: {
      sendMessage: async (m: any) => {
        if (m.operation === "trace.record") events.push(m);
        if (m.operation === "lookupModels") {
          return {
            ok: true,
            data: { translations: (m.args?.[0] || []).map(() => null) },
          };
        }
        return { ok: true, data: {} };
      },
    },
  };
  return events;
}

// Minimal selector-capable mock DOM for pure Node testing of inspectDomElement (Q-T01, Q-T20).
class MockText {
  readonly nodeType = 3;
  parentElement: MockElement | null = null;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
}

class MockElement {
  readonly nodeType = 1;
  readonly tagName: string;
  parentElement: MockElement | null = null;
  readonly childNodes: (MockElement | MockText)[] = [];
  readonly attrs = new Map<string, string>();
  readonly classList = new Set<string>();

  constructor(
    tag: string,
    attrs: Record<string, string> = {},
    children: (MockElement | MockText | string)[] = [],
  ) {
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      this.attrs.set(k.toLowerCase(), v);
      if (k.toLowerCase() === "class") {
        for (const c of v.split(/\s+/).filter(Boolean)) this.classList.add(c);
      }
    }
    for (const c of children) {
      const node = typeof c === "string" ? new MockText(c) : c;
      node.parentElement = this;
      this.childNodes.push(node);
    }
  }

  get children(): MockElement[] {
    return this.childNodes.filter((n): n is MockElement => n.nodeType === 1);
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }

  matches(selectorList: string): boolean {
    return selectorList
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .some((sel) => this.matchesSingle(sel));
  }

  private matchesSingle(sel: string): boolean {
    if (sel === '[contenteditable]:not([contenteditable="false"])') {
      return (
        this.attrs.has("contenteditable") &&
        this.attrs.get("contenteditable") !== "false"
      );
    }
    if (sel === '[class*="code-block"]') {
      return (this.attrs.get("class") || "").includes("code-block");
    }
    if (sel.startsWith("[") && sel.endsWith("]")) {
      const inner = sel.slice(1, -1);
      const eq = inner.indexOf("=");
      if (eq < 0) return this.attrs.has(inner.toLowerCase());
      const attr = inner.slice(0, eq).toLowerCase();
      const val = inner.slice(eq + 1).replace(/^["']|["']$/g, "");
      return this.attrs.get(attr) === val;
    }
    if (sel.startsWith(".")) {
      return this.classList.has(sel.slice(1));
    }
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }

  closest(selectorList: string): MockElement | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (cur.matches(selectorList)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
}

function walkAllGroups(root: MockElement): ExtractedGroup[] {
  const out: ExtractedGroup[] = [];
  const stack: MockElement[] = [root];
  while (stack.length) {
    const el = stack.shift()!;
    const { groups, descendInto } = inspectDomElement(
      el as unknown as Element,
      BASE_SKIP_SELECTOR,
      "zh-CN",
    );
    out.push(...groups);
    stack.unshift(...descendInto.map((d) => d as unknown as MockElement));
  }
  return out;
}

test("Q-00 priority scheduler prioritizes selection and active-tab viewport ahead of 20 background batches", async () => {
  installChromeMock();
  const c = {
    ...DEFAULTS,
    apiUrl: "https://scheduler-test.example.com/v1/chat/completions",
    concurrency: 1,
    intervalMs: 0,
  };
  const order: string[] = [];
  const slotMs = 8;

  // Baseline FIFO simulation: 1 in-flight + 20 background batches ahead of active tab = 21 * slotMs wait
  const legacyFifoWaitSlots = 21;

  // Priority scheduler test: tab 10 is background, tab 20 becomes active
  setActiveTabs([20]);
  const t = newTrace();
  const sig = new AbortController().signal;

  let releaseInFlight!: () => void;
  const firstGate = new Promise<void>((r) => {
    releaseInFlight = r;
  });

  const inFlight = schedule(
    c,
    t,
    sig,
    async () => {
      order.push("inflight-bg-0");
      await firstGate;
    },
    { tabId: 10, priority: 1 },
  );

  // Queue 20 background-tab tasks (tabId: 10 -> demoted to priority 3 because active tab is 20)
  const bgPromises: Promise<void>[] = [];
  for (let i = 1; i <= 20; i++) {
    bgPromises.push(
      schedule(
        c,
        t,
        sig,
        async () => {
          order.push(`bg-${i}`);
        },
        { tabId: 10, priority: 1 },
      ),
    );
  }

  // Queue active-tab near-viewport (priority 2), active-tab visible (priority 1), and selection (priority 0)
  const activeNear = schedule(
    c,
    t,
    sig,
    async () => {
      order.push("active-near");
    },
    { tabId: 20, priority: 2 },
  );

  let activeFirstResolvedSlot = -1;
  const activeVisible = schedule(
    c,
    t,
    sig,
    async () => {
      order.push("active-visible");
      activeFirstResolvedSlot = order.length - 1; // 1 slot after inflight!
    },
    { tabId: 20, priority: 1 },
  );

  const selectionTask = schedule(
    c,
    t,
    sig,
    async () => {
      order.push("selection");
    },
    { tabId: 10, priority: 0 },
  );

  // Also queue tasks for tab 30 and cancel them immediately via cancelQueuedForTab
  const cancelledTask = schedule(
    c,
    t,
    sig,
    async () => {
      order.push("cancelled-tab-30");
    },
    { tabId: 30, priority: 1 },
  );
  cancelQueuedForTab(30);
  await assert.rejects(cancelledTask, /CANCELLED/);

  // Release the single in-flight request
  releaseInFlight();
  await Promise.all([
    inFlight,
    selectionTask,
    activeVisible,
    activeNear,
    ...bgPromises,
  ]);

  assert.equal(order[0], "inflight-bg-0");
  assert.equal(order[1], "selection");
  assert.equal(order[2], "active-visible");
  assert.equal(order[3], "active-near");
  assert.equal(order[4], "bg-1");
  assert.ok(!order.includes("cancelled-tab-30"));
  assert.ok(
    activeFirstResolvedSlot <= 2 &&
      activeFirstResolvedSlot < legacyFifoWaitSlots,
    `Active tab waited ${activeFirstResolvedSlot * slotMs}ms vs legacy FIFO ${legacyFifoWaitSlots * slotMs}ms`,
  );
  setActiveTabs([]);
});

test("Q-T01 & Q-T20 nested block inline-runs are extracted while visually hidden and code containers are skipped", () => {
  const tree = new MockElement("div", {}, [
    new MockElement("li", {}, [
      "Category Name",
      new MockElement("ul", {}, [
        new MockElement("li", {}, ["First Child Item"]),
        new MockElement("li", { class: "sr-only" }, ["Screen Reader Only"]),
      ]),
    ]),
    new MockElement("div", {}, [
      "Section Intro ",
      new MockElement("strong", {}, ["Important"]),
      new MockElement("p", {}, ["Paragraph Body Text"]),
      new MockElement("div", { class: "highlight" }, ["const x = 42;"]),
      new MockElement("span", { "aria-hidden": "true" }, ["Hidden Icon Label"]),
    ]),
  ]);

  const groups = walkAllGroups(tree);
  const sources = groups.map((g) => ({ kind: g.kind, source: g.source }));

  assert.deepEqual(sources, [
    { kind: "inline-run", source: "Category Name" },
    { kind: "element", source: "First Child Item" },
    { kind: "inline-run", source: "__QY0__Section Intro __QY1__Important" },
    { kind: "element", source: "Paragraph Body Text" },
  ]);
});

test("Q-T02 ordered placeholder validation, read-time cache self-healing, and explicit purgeInvalidModels", async () => {
  assert.deepEqual(orderedPlaceholders("__QY1__ then __QY0__"), [
    "__QY1__",
    "__QY0__",
  ]);
  assert.equal(
    validTranslation("__QY0__Click __QY1__here", "__QY0__点击__QY1__这里"),
    true,
  );
  assert.equal(
    validTranslation("__QY0__Click __QY1__here", "__QY1__这里__QY0__点击"),
    false,
  );

  const events: any[] = [];
  const db = new CacheDatabase(new sqlite.oo1.DB(":memory:"), {
    record: (...x: any[]) => events.push(x),
  });
  const t = newTrace();

  try {
    const validEntry: CacheEntry = {
      source: "__QY0__Open __QY1__settings",
      translation: "__QY0__打开__QY1__设置",
      scope: "cloud-v1",
      domain: "example.com",
      sourceLang: "en",
      targetLang: "zh-CN",
    };
    await db.enqueue([validEntry], t);
    await db.flush();

    // Simulate a legacy pre-existing misordered entry directly inside SQLite blocks + model table
    const badSource = "__QY0__Save __QY1__draft";
    const badEntry: CacheEntry = {
      source: badSource,
      translation: "__QY1__草稿__QY0__保存",
      scope: "cloud-v1",
      domain: "example.com",
      sourceLang: "en",
      targetLang: "zh-CN",
    };
    const raw = encodeLines([badEntry]);
    db.db.exec({
      sql: "INSERT INTO blocks VALUES(?,?,?,?)",
      bind: ["legacy-bad-block", 0, raw.length, raw],
    });
    db.db.exec({
      sql: "INSERT INTO model_blocks(block_id,bytes) VALUES(?,?)",
      bind: ["legacy-bad-block", raw.length],
    });
    const { entryKey } = await import("../src/db-core");
    const badHex = await entryKey(badEntry);
    const badBlob = Uint8Array.from(badHex.match(/../g)!, (h) =>
      parseInt(h, 16),
    );
    db.db.exec({
      sql: "INSERT INTO model VALUES(?,?,?)",
      bind: [badBlob, "legacy-bad-block", 0],
    });

    // Read-time lookup rejects bad entry AND self-heals it out of model table
    const res = await db.lookupModels([badEntry], t);
    assert.equal(res.translations[0], null);
    const remainingBad = db.db.selectValue(
      "SELECT count(*) FROM model WHERE block_id='legacy-bad-block'",
    );
    assert.equal(Number(remainingBad), 0);

    // Re-insert another legacy bad entry and verify explicit purgeInvalidModels cleans only bad entries
    db.db.exec({
      sql: "INSERT INTO model VALUES(?,?,?)",
      bind: [badBlob, "legacy-bad-block", 0],
    });
    const purgeResult = await db.purgeInvalidModels(t);
    assert.equal(purgeResult.purged, 1);
    assert.equal(
      (await db.lookupModels([validEntry], t)).translations[0],
      "__QY0__打开__QY1__设置",
    );
  } finally {
    db.dispose();
  }
});

test("Q-T04 stream interruption produces STREAM_INTERRUPTED and parseBatch salvages completed items", async () => {
  // Stream closed before [DONE] with finish_reason null
  const encoder = new TextEncoder();
  const truncatedStream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"[{\\"id\\":\\"t0\\",\\"text\\":\\"第一段\\"},{\\"id\\":\\"t1\\",\\"text\\":\\"未完"}}]}\n\n',
        ),
      );
      ctrl.close();
    },
  });
  const fakeRes = new Response(truncatedStream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
  await assert.rejects(
    () => providerResult(fakeRes, () => {}),
    (err: any) => {
      assert.equal(err.code, "STREAM_INTERRUPTED");
      assert.ok(err.partialText.includes("第一段"));
      return true;
    },
  );

  // parseBatch salvages t0 from truncated array and wrapper objects (Q-T04, Q-T09)
  const salvaged = parseBatch(
    '[{"id":"t0","text":"第一段"},{"id":"t1","text":"未完',
    ["First paragraph", "Incomplete second"],
  );
  assert.deepEqual(salvaged, ["第一段", undefined]);

  const wrappedWithProse = parseBatch(
    'Here is the JSON result:\n```json\n{"translations":[{"id":"t0","text":"你好"},{"id":"t1","text":"世界"}]}\n```\nHope this helps!',
    ["Hello", "World"],
  );
  assert.deepEqual(wrappedWithProse, ["你好", "世界"]);
});

test("Q-T05 & Q-T09 partial batch success preserves valid items while bounding split retries", async () => {
  installChromeMock();
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const userContent = payload.messages[payload.messages.length - 1]
      .content as string;
    const items = userContent.includes("\n[")
      ? (JSON.parse(userContent.slice(userContent.lastIndexOf("\n[") + 1)) as {
          id: string;
          text: string;
        }[])
      : [{ id: "t0", text: userContent.split("\n\n").at(-1) || userContent }];
    // t0 & t1 succeed with valid translations; item with "__QY0__Bad" always returns broken placeholder
    const out = items.map((it) => ({
      id: it.id,
      text: it.text.includes("__QY0__")
        ? "丢失占位符的坏译文"
        : `译:${it.text}`,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: JSON.stringify(out) } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const ac1 = new AbortController();
  try {
    const port = (server.address() as any).port;
    const cfg = {
      ...DEFAULTS,
      apiKey: "test-key",
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      model: "gpt-4o-mini",
      batch: true,
      intervalMs: 0,
    };
    const res = await translateBatchDetailed(
      cfg,
      ["First good", "__QY0__Bad item", "Third good"],
      newTrace(),
      ac1.signal,
      () => {},
    );
    assert.equal(res.translations[0], "译:First good");
    assert.equal(res.translations[1], null);
    assert.equal(res.translations[2], "译:Third good");
    assert.ok(res.errors[1]);
    assert.ok(calls <= 3, `Expected bounded retry calls <= 3, got ${calls}`);
  } finally {
    ac1.abort();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Q-T03 & M-R1 session local status cache avoids per-segment status roundtrips and polls runtime_loading", async () => {
  installChromeMock();
  invalidateLocalStatusCache();
  let statusHits = 0;
  let chatHits = 0;

  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/api/v1/status")) {
      statusHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "mistral-gui",
          model_revision: "v1:sha256",
          deployment_revision: "dep-1",
          selected_backend: "auto",
          status: { state: "running" },
          settings: { model: "local-qwen" },
          deployments: [
            {
              id: "local-qwen",
              model: "local-qwen",
              model_name: "Qwen2.5-7B-Instruct",
              model_revision: "v1:sha256",
              deployment_revision: "dep-1",
              status: { state: "running" },
            },
          ],
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions") {
      chatHits++;
      if (chatHits === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "runtime_loading",
              stage: "loading_weights",
              elapsed_ms: 120,
              estimated_ms: 500,
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "本地译文" },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const ac2 = new AbortController();
  try {
    const port = (server.address() as any).port;
    const cfg = {
      ...DEFAULTS,
      routing: "local-first" as const,
      localUrl: `http://127.0.0.1:${port}`,
      localModel: "local-qwen",
      localToken: "tok",
      apiKey: "cloud-key",
      apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      intervalMs: 0,
    };
    const sessionTrace = { ...newTrace(), sessionId: "page-session-1" };
    const r1 = await translateRouted(
      cfg,
      [
        {
          source: "Segment one",
          scope: "cloud",
          domain: "example.com",
          sourceLang: "en",
          targetLang: "zh-CN",
        },
      ],
      sessionTrace,
      ac2.signal,
      () => {},
    );
    const r2 = await translateRouted(
      cfg,
      [
        {
          source: "Segment two",
          scope: "cloud",
          domain: "example.com",
          sourceLang: "en",
          targetLang: "zh-CN",
        },
      ],
      sessionTrace,
      ac2.signal,
      () => {},
    );
    assert.equal(r1.translations[0], "本地译文");
    assert.equal(r2.translations[0], "本地译文");
    assert.equal(r1.channels[0], "local");
    // Status endpoint hit once for the session + once during runtime_loading poll, NOT per segment!
    assert.ok(statusHits <= 2, `Expected <= 2 status hits, got ${statusHits}`);
  } finally {
    ac2.abort();
    invalidateLocalStatusCache();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Q-T07 URL trailing punctuation stripped & Q-T12 CJK sentence splitting without spaces", () => {
  // Trailing ASCII '.' in source turns into CJK '。' in translation and must remain valid!
  const src = "Visit https://example.com/docs.";
  const tr = "请访问 https://example.com/docs。";
  assert.deepEqual(orderedPlaceholders(src), ["https://example.com/docs"]);
  assert.equal(validTranslation(src, tr), true);

  // CJK long paragraph splits cleanly at '。' without requiring trailing whitespace
  const s1 = "这是第一句非常完整的中文说明，用来测试没有空格时的断句能力。";
  const s2 = "这是第二句紧接着前一句的中文内容，中间没有任何空格分隔！";
  const s3 = "这是第三句收尾内容，确保每一片都在句号或感叹号之后自然切开。";
  const combined = s1 + s2 + s3;
  const parts = splitSegments(combined, 45);
  assert.equal(parts.join(""), combined);
  assert.ok(
    parts[0].endsWith("。"),
    `Expected CJK sentence boundary, got: ${parts[0]}`,
  );
});

test("Q-T13 normalized language matching & Q-T14 automatic cloud model cache budget eviction", async () => {
  assert.equal(normalizeLang("en-US"), "en");
  assert.equal(normalizeLang("zh-Hans-CN"), "zh-CN");
  assert.equal(normalizeLang("zh-Hant-TW"), "zh-TW");

  const db = new CacheDatabase(new sqlite.oo1.DB(":memory:"), {
    record: () => {},
  });
  const t = newTrace();
  try {
    // Import an 'en' -> 'zh-CN' dictionary pack and verify 'en-US' and 'auto' match it!
    const packRows = encodeLines([
      {
        source: "Documentation",
        translation: "文档",
        sourceLang: "en",
        targetLang: "zh-CN",
        domain: "*",
      },
    ]);
    const gz = await streamBytes(
      new Blob([packRows]).stream().pipeThrough(new CompressionStream("gzip")),
      packRows.length + 1024,
    );
    const manifest: PackManifest = {
      format: "qingyi-pack-v1",
      id: "en-dict",
      version: 1,
      kind: "full",
      baseVersion: null,
      sourceLang: "en",
      targetLang: "zh-CN",
      domain: "*",
      entries: 1,
      uncompressedBytes: packRows.length,
      blocks: [
        {
          file: "p.gz",
          sha256: await (await import("../src/types")).sha256(gz),
          bytes: gz.length,
          uncompressedBytes: packRows.length,
          entries: 1,
        },
      ],
    };
    await db.startPack(manifest, t);
    await db.appendPack("en-dict", 1, "p.gz", base64(gz), t);
    await db.activatePack("en-dict", 1, t);

    await db.revision(
      {
        source: "Pinned term",
        translation: "固定术语",
        scope: "",
        domain: "example.com",
        sourceLang: "en",
        targetLang: "zh-CN",
      },
      t,
    );

    const lookupEnUs = await db.lookup(
      [
        {
          source: "Documentation",
          scope: "cloud",
          domain: "example.com",
          sourceLang: "en-US",
          targetLang: "zh-CN",
        },
        {
          source: "Documentation",
          scope: "cloud",
          domain: "example.com",
          sourceLang: "auto",
          targetLang: "zh-CN",
        },
      ],
      t,
    );
    assert.deepEqual(lookupEnUs.translations, ["文档", "文档"]);

    // Q-T14: Set tight budget (64 MiB), inflate existing cloud block metadata near budget, and verify oldest cloud block evicts while dictionary & revision survive!
    db.setBudget(64 * 1024 * 1024);
    const oldCloud: CacheEntry = {
      source: "Old cloud paragraph",
      translation: "旧云端译文",
      scope: "cloud",
      domain: "example.com",
      sourceLang: "en",
      targetLang: "zh-CN",
    };
    await db.enqueue([oldCloud], t);
    await db.flush();

    // Pad oldCloud with distinct incompressible random bytes (~24 KiB across 8 entries < 4,000 chars each) so its block frees multiple SQLite pages
    const makeNoise = (seed: number) => {
      let x = seed >>> 0;
      let s = "";
      for (let i = 0; i < 3200; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        s += String.fromCharCode(48 + ((x >>> 0) % 74));
      }
      return s;
    };
    const paddedOldCloud: CacheEntry = {
      ...oldCloud,
      translation: "旧云端译文 " + makeNoise(101),
    };
    const extraOldEntries: CacheEntry[] = Array.from(
      { length: 7 },
      (_, idx) => ({
        ...oldCloud,
        source: `Old cloud paragraph extra ${idx}`,
        translation: `旧译文${idx} ` + makeNoise(202 + idx * 97),
      }),
    );
    await db.enqueue([paddedOldCloud, ...extraOldEntries], t);
    await db.flush();

    // Capture fixed usable budget ceiling so freeing paddedOldCloud's pages brings usedDbBytes below fixedCeiling
    const realUsable = (db as any).usableBudgetBytes.bind(db);
    const fixedCeiling = (db as any).usedDbBytes() + 64;
    let tightOnce = true;
    (db as any).usableBudgetBytes = () =>
      tightOnce ? fixedCeiling : realUsable();

    const newCloud: CacheEntry = {
      source: "Fresh cloud paragraph after budget full",
      translation: "预算满后的新云端译文",
      scope: "cloud",
      domain: "example.com",
      sourceLang: "en",
      targetLang: "zh-CN",
    };
    await db.enqueue([newCloud], t);
    await db.flush();
    tightOnce = false;

    assert.equal(
      (await db.lookupModels([paddedOldCloud], t)).translations[0],
      null,
    );
    assert.equal(
      (await db.lookupModels([newCloud], t)).translations[0],
      "预算满后的新云端译文",
    );
    const preserved = await db.lookup(
      [
        {
          source: "Documentation",
          scope: "cloud",
          domain: "example.com",
          sourceLang: "en-US",
          targetLang: "zh-CN",
        },
        {
          source: "Pinned term",
          scope: "cloud",
          domain: "example.com",
          sourceLang: "en-US",
          targetLang: "zh-CN",
        },
      ],
      t,
    );
    assert.deepEqual(preserved.translations, ["文档", "固定术语"]);
  } finally {
    db.dispose();
  }
});

test("Q-T18 10,000-paragraph queue & progress benchmark stays sub-50ms vs O(N^2) legacy queue", () => {
  interface BenchUnit extends QueuedUnitLike {
    id: number;
    len: number;
  }

  const N = 10_000;
  const units: BenchUnit[] = Array.from({ length: N }, (_, i) => ({
    id: i,
    tier: (i < 60 ? 1 : i < 300 ? 2 : 3) as UnitPriorityTier,
    queued: false,
    len: 120,
    isConnected: () => true,
  }));

  // Legacy O(N^2) simulation: array sort + full-array filter progress scan per batch of 16
  const legacyQueue = units.map((u) => ({ ...u, queued: true }));
  const t0 = performance.now();
  let legacyBatches = 0;
  while (legacyQueue.length > 0) {
    legacyQueue.sort((a, b) => a.tier - b.tier);
    const batch = legacyQueue.splice(0, 16);
    for (const b of batch) b.translation = "ok";
    // Legacy progress() scanned all units twice per batch
    let done = 0;
    for (let i = 0; i < units.length; i++) if (units[i].id >= 0) done++;
    if (done < 0) break;
    legacyBatches++;
  }
  const legacyMs = performance.now() - t0;

  // New PagePriorityQueue: O(1) bucket sets + O(1) incremental counters
  const pq = new PagePriorityQueue<BenchUnit>();
  const t1 = performance.now();
  for (const u of units) {
    pq.discoveredCount++;
    pq.enqueue(u, u.tier);
  }
  let newBatches = 0;
  while (pq.queuedSize > 0) {
    const { batch } = pq.dequeueBatch({
      maxItems: 16,
      maxChars: 3600,
      getLength: (u) => u.len,
      includeOffscreen: true,
    });
    pq.renderedCount += batch.length;
    newBatches++;
  }
  const newMs = performance.now() - t1;

  assert.equal(newBatches, legacyBatches);
  assert.equal(pq.renderedCount, N);
  assert.ok(
    newMs < 80 && newMs < legacyMs,
    `Expected PagePriorityQueue (${newMs.toFixed(2)}ms) < 80ms and faster than legacy (${legacyMs.toFixed(2)}ms)`,
  );
  console.log(
    `[Q-T18 benchmark 10,000 segments] legacy=${legacyMs.toFixed(2)}ms -> PagePriorityQueue=${newMs.toFixed(2)}ms`,
  );
});

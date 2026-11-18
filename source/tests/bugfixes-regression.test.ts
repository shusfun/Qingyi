import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, validTranslation } from "../src/types";
import { newTrace } from "../src/trace";
import { translateBatchDetailed } from "../src/network";
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
import { grantOriginsOnce } from "../src/options-app/rpc";

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
      .some((sel) => {
        if (/^[a-z0-9-]+$/i.test(sel))
          return this.tagName === sel.toUpperCase();
        if (sel.startsWith(".")) return this.classList.has(sel.slice(1));
        if (sel === "[hidden]") return this.attrs.has("hidden");
        if (sel === '[aria-hidden="true"]')
          return this.attrs.get("aria-hidden") === "true";
        if (sel === "[data-qingyi]") return this.attrs.has("data-qingyi");
        if (sel === '[translate="no"]')
          return this.attrs.get("translate") === "no";
        return false;
      });
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
  while (stack.length > 0) {
    const el = stack.pop()!;
    const res = inspectDomElement(el as unknown as Element, BASE_SKIP_SELECTOR);
    out.push(...res.groups);
    for (let i = res.descendInto.length - 1; i >= 0; i--) {
      stack.push(res.descendInto[i] as unknown as MockElement);
    }
  }
  return out;
}

test("inspectDomElement traverses body, custom elements, and nested wrapper divs without dropping or swallowing paragraphs", () => {
  const tree = new MockElement("body", {}, [
    new MockElement("ytd-app", {}, [
      new MockElement("div", { class: "card-wrapper" }, [
        new MockElement("my-card", {}, [
          new MockElement("h2", {}, ["Modern Architecture"]),
          new MockElement("p", {}, [
            "Read the ",
            new MockElement("a", { href: "/docs" }, ["official guide"]),
            " carefully.",
          ]),
        ]),
      ]),
      new MockElement("yt-formatted-string", {}, [
        "Standalone custom element text.",
      ]),
    ]),
  ]);

  const groups = walkAllGroups(tree);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].source, "Modern Architecture");
  assert.equal(
    groups[1].source,
    "__QY0__Read the __QY1__official guide__QY2__ carefully.",
  );
  assert.equal(groups[2].source, "Standalone custom element text.");
});

test("PagePriorityQueue separates activeQueuedSize from offscreen tier-3 items and resets unit.queued on dequeue", () => {
  const pq = new PagePriorityQueue<QueuedUnitLike & { text: string }>();
  const makeUnit = (text: string, tier: UnitPriorityTier) => ({
    text,
    tier,
    queued: false,
    isConnected: () => true,
  });

  const uVisible = makeUnit("Visible", 1);
  const uOffscreen = makeUnit("Offscreen", 3);
  pq.enqueue(uVisible, 1);
  pq.enqueue(uOffscreen, 3);

  assert.equal(pq.queuedSize, 2);
  assert.equal(pq.activeQueuedSize, 1);

  const batch1 = pq.dequeueBatch({
    maxItems: 4,
    maxChars: 1000,
    getLength: (u) => u.text.length,
  });
  assert.equal(batch1.batch.length, 1);
  assert.equal(batch1.batch[0], uVisible);
  assert.equal(uVisible.queued, false);
  // Offscreen item stays in tier-3 without blocking activeQueuedSize completion!
  assert.equal(pq.activeQueuedSize, 0);
  assert.equal(pq.queuedSize, 1);
});

test("Hunyuan-MT singleTextModel recovers cleanly when model drops __QY__ markers on multi-node paragraphs", async () => {
  const prevChrome = (globalThis as any).chrome;
  const prevFetch = globalThis.fetch;
  try {
    (globalThis as any).chrome = {
      permissions: { contains: async () => true },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        session: { get: async () => ({}), set: async () => {} },
      },
      runtime: { sendMessage: async () => ({ ok: true, data: {} }) },
    };

    const seenPrompts: string[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(String(init.body));
      const content: string = body.messages[0].content;
      seenPrompts.push(content);
      // Simulate Hunyuan-MT dropping __QY0__ / __QY1__ tokens on the initial full-paragraph call,
      // then translating each clean span accurately on fallback!
      let reply = "未知";
      if (content.includes("__QY0__")) {
        reply = "仔细阅读官方文档。"; // dropped __QY0__, __QY1__, __QY2__!
      } else if (content.endsWith("Read the")) {
        reply = "请阅读";
      } else if (content.endsWith("official guide")) {
        reply = "官方指南";
      } else if (content.endsWith("carefully.")) {
        reply = "并留意细节。";
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: reply } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const cfg = {
      ...DEFAULTS,
      apiUrl: "https://api.example.com/v1/chat/completions",
      apiKey: "sk-test",
      model: "tencent/Hunyuan-MT-7B",
      intervalMs: 0,
    };
    const src = "__QY0__Read the __QY1__official guide__QY2__ carefully.";
    const res = await translateBatchDetailed(
      cfg,
      [src],
      newTrace(),
      new AbortController().signal,
      () => {},
    );
    assert.equal(res.errors[0], undefined);
    assert.equal(
      res.translations[0],
      "__QY0__请阅读 __QY1__官方指南__QY2__ 并留意细节。",
    );
    assert.equal(validTranslation(src, res.translations[0]), true);
    assert.equal(seenPrompts.length, 4);
  } finally {
    (globalThis as any).chrome = prevChrome;
    globalThis.fetch = prevFetch;
  }
});

test("grantOriginsOnce invokes chrome.permissions.request synchronously in the first turn before any await", async () => {
  const prevChrome = (globalThis as any).chrome;
  try {
    let syncCalledBeforeMicrotask = false;
    let microtaskTicked = false;
    void Promise.resolve().then(() => {
      microtaskTicked = true;
    });

    (globalThis as any).chrome = {
      permissions: {
        contains: async () => false,
        request: async () => {
          syncCalledBeforeMicrotask = !microtaskTicked;
          return true;
        },
      },
      runtime: { sendMessage: async () => ({ ok: true }) },
    };

    await grantOriginsOnce(["https://api.siliconflow.cn/v1/chat/completions"]);
    assert.equal(syncCalledBeforeMicrotask, true);
  } finally {
    (globalThis as any).chrome = prevChrome;
  }
});

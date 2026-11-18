import { newTrace, childTrace, validTrace } from "./trace";
import { normalizeLang, validTranslation, type Trace } from "./types";
import { singleTextModel } from "./model-profile";
import {
  resolvePageError as resolveError,
  normalizePageLang as normalizeUiLang,
} from "./inpage/errors-lite";
import {
  buildSkipSelector,
  detectMainArticleRoot,
  INLINE_INTERACTIVE_TAGS,
  inspectDomElement,
  isTextUseful,
  isVisuallyHiddenElement,
  NON_ARTICLE_CHROME_SELECTOR,
  type TextPart,
} from "./dom-collect";
import { PagePriorityQueue, type UnitPriorityTier } from "./page-queue";
import { createInPageOverlay } from "./inpage/overlay";

declare global {
  interface Window {
    __qingyi3?: { runtime: typeof chrome.runtime };
  }
}

const FATAL_PAGE_ERRORS = new Set([
  "KEY_REQUIRED",
  "DEEPL_KEY_REQUIRED",
  "API_PERMISSION_REQUIRED",
  "HTTP_401",
  "HTTP_403",
  "LOCAL_TOKEN_REQUIRED",
  "LOCAL_PERMISSION_REQUIRED",
  "LOCAL_HTTP_401",
  "LOCAL_HTTP_403",
  "LOCAL_MODEL_MISMATCH",
  "LOCAL_BACKEND_MISMATCH",
  "LOCAL_MODEL_NOT_INSTALLED",
  "LOCAL_RUNTIME_STOPPED",
  "LOCAL_RUNTIME_COOLDOWN",
  "OPFS_UNSUPPORTED",
  "DAILY_QUOTA_REACHED",
]);

if (window.__qingyi3?.runtime.id !== chrome.runtime.id) {
  window.__qingyi3 = { runtime: chrome.runtime };
  const app = launch();
  chrome.runtime.onMessage.addListener((m, s, respond) => {
    if (
      s.id !== chrome.runtime.id ||
      !["CONTROL", "PROGRESS"].includes(m?.type)
    )
      return;
    void app
      .then((a) =>
        m.type === "PROGRESS" ? a.networkProgress(m) : a.control(m),
      )
      .then(
        () => respond({ ok: true }),
        (e) => respond({ ok: false, error: e.message }),
      );
    return true;
  });
}

async function send(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<any> {
  let r: any;
  try {
    r = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/Receiving end does not exist|message port closed/i.test(msg)) {
      throw new Error("EXTENSION_DISCONNECTED");
    }
    throw err;
  }
  if (!r?.ok) throw Error(r?.error || "EXTENSION_DISCONNECTED");
  return r.data;
}

function getShadowRootAny(
  el: Element,
  overlayHost: Element,
): ShadowRoot | null {
  if (el === overlayHost) return null;
  if (el instanceof HTMLElement && chrome.dom?.openOrClosedShadowRoot) {
    try {
      return chrome.dom.openOrClosedShadowRoot(el);
    } catch {
      return el.shadowRoot;
    }
  }
  return el.shadowRoot;
}

async function launch() {
  const isTopFrame = window === window.top;
  let info = await send("PUBLIC");
  let active = false;
  let mode: "chinese" | "bilingual" =
    info.mode === "bilingual" ? "bilingual" : "chinese";
  let trace: Trace | undefined;
  let session = "";
  let running = 0;
  let first = true;
  let requests = 0;
  let hits = 0;
  let scanning = 0;
  let generation = 0;
  let cacheWarning = false;
  let unitLimitReached = false;
  let pageForeground =
    typeof document !== "undefined" ? !document.hidden : true;
  let startQueue = Promise.resolve();

  const requestCounts = new Map<string, number>();

  type Unit = {
    kind: "element" | "inline-run" | "attribute";
    key: string;
    el: Element;
    anchorNode?: Node;
    attrName?: string;
    originalAttr?: string;
    parts: TextPart[];
    source: string;
    translation?: string;
    showingOriginal?: boolean;
    annotation?: HTMLElement;
    tier: UnitPriorityTier;
    queued: boolean;
    failed?: boolean;
    version: number;
    isConnected(): boolean;
  };

  let unitsByElement = new WeakMap<Element, Unit[]>();
  const allUnits = new Set<Unit>();
  const pq = new PagePriorityQueue<Unit>();
  const dirtyRoots = new Set<Node>();
  const observedRoots = new Set<Node>();

  // Batched trace buffer on content side to eliminate per-segment IPC overhead (Q-T17).
  const traceQueue: {
    trace: Trace;
    event: string;
    fields?: Record<string, unknown>;
  }[] = [];
  let traceTimer: ReturnType<typeof setTimeout> | undefined;

  function flushTraces() {
    clearTimeout(traceTimer);
    traceTimer = undefined;
    if (!traceQueue.length) return;
    const chunk = traceQueue.splice(0, 128);
    void send("TRACE_BATCH", { events: chunk }).catch(() => {});
    if (traceQueue.length) {
      traceTimer = setTimeout(flushTraces, 250);
    }
  }

  function emit(
    t: Trace | undefined,
    event: string,
    fields: Record<string, unknown> = {},
    immediate = false,
  ) {
    if (!t) return;
    traceQueue.push({
      trace: t,
      event,
      fields: { time: Date.now(), ...fields },
    });
    if (immediate || traceQueue.length >= 64) {
      flushTraces();
    } else if (!traceTimer) {
      traceTimer = setTimeout(flushTraces, 400);
    }
  }

  // Apply custom --qingyi-translation-* CSS variables on document root (Prompt item 13).
  function applyTranslationStyleVars(styleCfg: any) {
    const rootStyle = document.documentElement?.style;
    if (!rootStyle) return;
    if (!styleCfg || typeof styleCfg !== "object") {
      rootStyle.removeProperty("--qingyi-translation-gap");
      rootStyle.removeProperty("--qingyi-translation-stroke");
      rootStyle.removeProperty("--qingyi-translation-inset");
      rootStyle.removeProperty("--qingyi-translation-opacity");
      return;
    }
    if (styleCfg.gapPx !== undefined) {
      rootStyle.setProperty(
        "--qingyi-translation-gap",
        `${Number(styleCfg.gapPx) || 3}px`,
      );
    }
    if (styleCfg.strokePx !== undefined) {
      rootStyle.setProperty(
        "--qingyi-translation-stroke",
        `${Number(styleCfg.strokePx) ?? 3}px`,
      );
    }
    if (styleCfg.insetPx !== undefined) {
      rootStyle.setProperty(
        "--qingyi-translation-inset",
        `${Number(styleCfg.insetPx) || 7}px`,
      );
    }
    if (styleCfg.opacity !== undefined) {
      rootStyle.setProperty(
        "--qingyi-translation-opacity",
        String(styleCfg.opacity),
      );
    }
  }
  applyTranslationStyleVars(info.translationStyle);

  const overlay = createInPageOverlay(
    {
      theme: info.theme || "system",
      locale: info.locale,
      progressVisible: info.progressVisible !== false,
      position: info.position,
      isTopFrame,
    },
    {
      onOpenSettings: () => {
        const t = newTrace(session || undefined);
        emit(t, "control.start", {
          outcome: "started",
          resourceId: "settings",
        });
        void send("OPEN_SETTINGS", { trace: t })
          .then(() =>
            emit(t, "control.end", {
              outcome: "success",
              resourceId: "settings",
            }),
          )
          .catch(() => {
            emit(t, "control.end", {
              outcome: "failed",
              resourceId: "settings",
            });
            updateProgress(
              overlay.getLang() === "en"
                ? "Could not open Settings"
                : "无法打开设置页",
              overlay.getLang() === "en"
                ? "Open from browser extension management"
                : "请从浏览器扩展管理页进入",
              "error",
            );
          });
      },
      onSavePosition: (pos) => {
        info.position = pos;
        void send("POSITION", pos).catch(() => {});
      },
      onSaveRevision: async ({ source, translation }) => {
        const t = newTrace(session || undefined);
        await send("SAVE_REVISION", {
          source,
          translation,
          sourceLang: document.documentElement.lang || "auto",
          targetLang: info.targetLang || "zh-CN",
          trace: t,
        });
      },
      onAreaSelected: (elements) => {
        void translateSelectedArea(elements);
      },
    },
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes["ui.theme"]) {
      info.theme = changes["ui.theme"].newValue || "system";
      overlay.setTheme(info.theme);
    }
    if (changes["ui.locale"]) {
      info.locale = changes["ui.locale"].newValue || "";
      overlay.setLocale(info.locale);
    }
    if (changes["ui.progressVisible"]) {
      info.progressVisible = changes["ui.progressVisible"].newValue !== false;
      overlay.setProgressPreference(info.progressVisible);
    }
    if (changes["ui.translationStyle"]) {
      info.translationStyle = changes["ui.translationStyle"].newValue || null;
      applyTranslationStyleVars(info.translationStyle);
    }
  });

  let currentStatusText = overlay.getLang() === "en" ? "Ready" : "等待开始";
  let currentHintText = "";
  let currentTone: "neutral" | "warning" | "error" = "neutral";

  function updateProgress(
    statusText = currentStatusText,
    hintText = currentHintText,
    tone: "neutral" | "warning" | "error" = currentTone,
    forceShow = false,
  ) {
    currentStatusText = statusText;
    currentHintText = hintText;
    currentTone = tone;
    overlay.scheduleProgress({
      statusText,
      hintText: hintText || undefined,
      tone,
      rendered: pq.renderedCount,
      discovered: pq.discoveredCount,
      hits,
      queued: pq.queuedSize,
      requests,
      failed: pq.failedCount,
      capped: unitLimitReached,
      forceShow,
    });
  }

  function computeViewportTier(el: Element): UnitPriorityTier {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && el.getClientRects().length === 0) {
      return 3;
    }
    if (r.bottom >= 0 && r.top <= innerHeight) return 1;
    if (r.bottom >= -600 && r.top <= innerHeight + 600) return 2;
    return 3;
  }

  // Observe both in-viewport and near-viewport (600px) so offscreen segments enter queue lazily as user scrolls (Q-00, Item 6).
  const nearObserver = new IntersectionObserver(
    (entries) => {
      if (!active) return;
      let newlyNear = false;
      for (const entry of entries) {
        const list = unitsByElement.get(entry.target);
        if (!list) continue;
        const tier: UnitPriorityTier = entry.isIntersecting
          ? computeViewportTier(entry.target)
          : 3;
        for (const unit of list) {
          if (unit.translation !== undefined || unit.failed) continue;
          if (tier <= 2) {
            pq.enqueue(unit, tier);
            newlyNear = true;
          } else {
            // Left near-viewport before starting: remove from active dispatch queue until scrolled back near
            pq.remove(unit);
            unit.tier = 3;
          }
        }
      }
      if (newlyNear && pageForeground) {
        kick();
        updateProgress();
      }
    },
    { rootMargin: "600px 0px" },
  );

  function getSkipSelector(): string {
    const extra = info.siteRule?.skipSelector || "";
    const chromeSkip = info.siteRule?.articleOnly
      ? NON_ARTICLE_CHROME_SELECTOR
      : "";
    return buildSkipSelector([extra, chromeSkip].filter(Boolean).join(","));
  }

  function registerUnitOnElement(el: Element, unit: Unit) {
    let arr = unitsByElement.get(el);
    if (!arr) {
      arr = [];
      unitsByElement.set(el, arr);
    }
    arr.push(unit);
  }

  function removeUnitAccounting(unit: Unit) {
    if (!allUnits.has(unit)) return;
    allUnits.delete(unit);
    pq.remove(unit);
    pq.discoveredCount = Math.max(0, pq.discoveredCount - 1);
    if (unit.translation !== undefined) {
      pq.renderedCount = Math.max(0, pq.renderedCount - 1);
    }
    if (unit.failed) {
      pq.failedCount = Math.max(0, pq.failedCount - 1);
    }
  }

  // Restore a single unit cleanly with zero residual译文 in DOM (Q-25, Q-03).
  function restoreUnit(unit: Unit) {
    unit.annotation?.remove();
    unit.annotation = undefined;
    if (
      unit.kind === "attribute" &&
      unit.attrName &&
      unit.originalAttr !== undefined
    ) {
      if (unit.el.isConnected) {
        unit.el.setAttribute(unit.attrName, unit.originalAttr);
      }
    } else {
      for (const p of unit.parts) {
        if (p.node.data === p.current) {
          p.node.data = p.original;
        }
        p.current = p.original;
      }
    }
    unit.showingOriginal = false;
  }

  function collectAttributesOnElement(
    el: Element,
    skipSelector: string,
    targetLang: string,
    forceEnqueue = false,
  ) {
    if (info.translateAttributes === false) return;
    if (el.closest(skipSelector) || isVisuallyHiddenElement(el)) return;
    const existingList = unitsByElement.get(el) || [];

    for (const attrName of ["placeholder", "title"]) {
      const val = el.getAttribute(attrName);
      if (!val || !isTextUseful(val, targetLang)) continue;
      if (pq.discoveredCount >= 10000) {
        unitLimitReached = true;
        return;
      }
      const key = `attr:${attrName}`;
      const existing = existingList.find((u) => u.key === key);
      if (existing) {
        if (existing.translation && val === existing.translation) continue;
        if (val === existing.originalAttr) {
          if (
            existing.translation === undefined &&
            !existing.queued &&
            !existing.failed &&
            (forceEnqueue || computeViewportTier(el) <= 2)
          ) {
            pq.enqueue(existing, computeViewportTier(el));
          }
          continue;
        }
        restoreUnit(existing);
        removeUnitAccounting(existing);
      }
      const tier = forceEnqueue ? 1 : computeViewportTier(el);
      const unit: Unit = {
        kind: "attribute",
        key,
        el,
        attrName,
        originalAttr: val,
        parts: [],
        source: val.trim(),
        tier,
        queued: false,
        version: 0,
        isConnected: () => el.isConnected,
      };
      allUnits.add(unit);
      pq.discoveredCount++;
      registerUnitOnElement(el, unit);
      nearObserver.observe(el);
      if (tier <= 2) pq.enqueue(unit, tier);
    }
  }

  function collectElementTree(root: Node, forceEnqueue = false): Element[] {
    const skipSelector = getSkipSelector();
    const targetLang = info.targetLang || "zh-CN";
    const pending: Element[] =
      root instanceof Element
        ? [root]
        : Array.from(root.childNodes).filter(
            (n): n is Element => n instanceof Element,
          );
    return pending.filter(
      (el) => el !== overlay.host && !el.matches(skipSelector),
    );
  }

  function processElement(el: Element, forceEnqueue = false) {
    if (el === overlay.host) return;
    const skipSelector = getSkipSelector();
    if (el.matches(skipSelector)) return;

    // Inspect open or closed Shadow DOM (Q-T16).
    const shadowRoot = getShadowRootAny(el, overlay.host);
    if (shadowRoot && !observedRoots.has(shadowRoot)) {
      observeRoot(shadowRoot);
      scan(shadowRoot, forceEnqueue);
    }

    const targetLang = info.targetLang || "zh-CN";
    collectAttributesOnElement(el, skipSelector, targetLang, forceEnqueue);

    if (el.getClientRects().length === 0) return [];
    const { groups, descendInto } = inspectDomElement(
      el,
      skipSelector,
      targetLang,
    );

    const existingList = unitsByElement.get(el);
    if (groups.length > 0) {
      // Reconcile against any existing text units on `el` cleanly: restore before replacing (Q-25).
      if (existingList) {
        const textUnits = existingList.filter((u) => u.kind !== "attribute");
        const unchanged =
          textUnits.length === groups.length &&
          textUnits.every(
            (u, idx) =>
              u.parts.length === groups[idx].parts.length &&
              u.parts.every(
                (p, pi) =>
                  p.node === groups[idx].parts[pi].node &&
                  p.node.isConnected &&
                  p.node.data === p.current,
              ),
          );
        if (unchanged) {
          const tier = forceEnqueue ? 1 : computeViewportTier(el);
          for (const u of textUnits) {
            if (
              u.translation === undefined &&
              !u.queued &&
              !u.failed &&
              tier <= 2
            ) {
              pq.enqueue(u, tier);
            }
          }
          return descendInto;
        }
        // Page modified part of an already-translated element: restore our translated parts BEFORE re-collecting (Q-25)!
        for (const oldUnit of textUnits) {
          restoreUnit(oldUnit);
          removeUnitAccounting(oldUnit);
          oldUnit.version++;
        }
        unitsByElement.set(
          el,
          existingList.filter((u) => u.kind === "attribute"),
        );
        // Re-extract after restoring original text so we never mistake our own translation for page text!
        const rechecked = inspectDomElement(el, skipSelector, targetLang);
        groups.splice(0, groups.length, ...rechecked.groups);
      }

      for (let gi = 0; gi < groups.length; gi++) {
        if (pq.discoveredCount >= 10000) {
          unitLimitReached = true;
          break;
        }
        const g = groups[gi];
        const tier = forceEnqueue ? 1 : computeViewportTier(el);
        const unit: Unit = {
          kind: g.kind,
          key: `${g.kind}:${gi}`,
          el: g.el,
          anchorNode: g.anchorNode,
          parts: g.parts,
          source: g.source,
          tier,
          queued: false,
          version: 0,
          isConnected: () =>
            g.el.isConnected && g.parts.every((p) => p.node.isConnected),
        };
        allUnits.add(unit);
        pq.discoveredCount++;
        registerUnitOnElement(el, unit);
        nearObserver.observe(el);
        if (tier <= 2) pq.enqueue(unit, tier);
      }
    }

    return descendInto;
  }

  function scan(root: Node, forceEnqueue = false) {
    if (!active || !root.isConnected) return;
    const t = trace ? childTrace(trace) : undefined;
    const start = performance.now();
    const token = generation;
    const beforeDiscovered = pq.discoveredCount;
    scanning++;
    emit(t, "scan.start", { outcome: "started" });
    const pending = collectElementTree(root, forceEnqueue);

    const step = () => {
      if (!active || token !== generation) {
        scanning--;
        return;
      }
      const budget = performance.now() + 8;
      while (pending.length && performance.now() < budget) {
        const el = pending.pop()!;
        const children = processElement(el, forceEnqueue);
        if (children && children.length) {
          for (let i = children.length - 1; i >= 0; i--) {
            pending.push(children[i]);
          }
        }
      }
      if (pageForeground && pq.queuedSize > 0) kick();
      // Only update status message if new segments were actually discovered (fixes Q-26 flashing!).
      if (pq.discoveredCount > beforeDiscovered && running > 0) {
        updateProgress(
          overlay.getLang() === "en"
            ? "Scanning & translating"
            : "扫描与翻译中",
        );
      }
      if (pending.length) {
        setTimeout(step, 0);
      } else {
        scanning--;
        for (const unit of allUnits) {
          if (!unit.isConnected()) {
            unit.annotation?.remove();
            nearObserver.unobserve(unit.el);
            removeUnitAccounting(unit);
          }
        }
        emit(t, "scan.end", {
          outcome: "success",
          durationMs: performance.now() - start,
          items: pq.discoveredCount,
        });
        if (
          !pq.queuedSize &&
          !running &&
          pq.discoveredCount > beforeDiscovered
        ) {
          complete();
        } else if (beforeDiscovered === 0 && !pq.queuedSize && !running) {
          complete();
        }
      }
    };
    step();
  }

  function markUnitFailed(unit: Unit) {
    if (!unit.failed) {
      unit.failed = true;
      pq.failedCount++;
    }
  }

  // Render translation into DOM without creating sibling nodes outside original element (Q-03, Q-15).
  function renderUnit(
    unit: Unit,
    value: string | null | undefined,
    version: number,
    t: Trace,
  ): boolean {
    const start = performance.now();
    if (
      unit.version !== version ||
      !unit.isConnected() ||
      (unit.kind !== "attribute" &&
        !unit.parts.every(
          (p) => unit.el.contains(p.node) && p.node.data === p.current,
        ))
    ) {
      emit(childTrace(t), "render.end", {
        outcome: "cancelled",
        reason: "source-snapshot-changed",
        durationMs: performance.now() - start,
      });
      return false;
    }

    if (!validTranslation(unit.source, value)) {
      markUnitFailed(unit);
      emit(childTrace(t), "render.end", {
        outcome: "failed",
        reason: "placeholder-validation",
      });
      return false;
    }

    if (unit.kind === "attribute" && unit.attrName) {
      const cleanVal = value.replace(/__QY\d+__/g, "").trim();
      unit.el.setAttribute(unit.attrName, cleanVal);
      if (unit.translation === undefined) pq.renderedCount++;
      unit.translation = value;
      unit.failed = false;
      emit(childTrace(t), "render.end", {
        outcome: "success",
        items: 1,
        durationMs: performance.now() - start,
      });
      return true;
    }

    const tokens = unit.parts.map((p) => p.token);
    const matches =
      unit.parts.length === 1 && tokens[0] === ""
        ? [{ index: 0, 0: "" }]
        : [...value.matchAll(/__QY\d+__/g)];
    if (
      matches.length !== tokens.length ||
      matches.some((m, i) => m[0] !== tokens[i])
    ) {
      markUnitFailed(unit);
      emit(childTrace(t), "render.end", {
        outcome: "failed",
        reason: "placeholder-order",
      });
      return false;
    }

    unit.annotation?.remove();
    unit.annotation = undefined;
    if (unit.translation === undefined) pq.renderedCount++;
    if (unit.failed) {
      unit.failed = false;
      pq.failedCount = Math.max(0, pq.failedCount - 1);
    }
    unit.translation = value;
    unit.showingOriginal = false;

    const targetLangAttr = normalizeLang(info.targetLang || "zh-CN");

    if (mode === "chinese") {
      unit.parts.forEach((p, i) => {
        const text = value.slice(
          matches[i].index! + tokens[i].length,
          i + 1 < matches.length ? matches[i + 1].index : undefined,
        );
        p.current = text;
        p.node.data = text;
      });
      if (
        unit.el instanceof HTMLElement &&
        !unit.el.hasAttribute("data-qingyi-orig-lang")
      ) {
        unit.el.setAttribute(
          "data-qingyi-orig-lang",
          unit.el.getAttribute("lang") ?? "",
        );
        unit.el.setAttribute("lang", targetLangAttr);
      }
    } else {
      // Bilingual mode: embed child span INSIDE unit.el so tables, flex/grid, lists, and buttons never distort (Q-03).
      const cleanText = value.replace(/__QY\d+__/g, "").trim();
      const tag = unit.el.tagName;
      const isInlineControl =
        unit.kind === "inline-run" ||
        (INLINE_INTERACTIVE_TAGS.has(tag) &&
          (unit.source.length <= 42 ||
            tag === "A" ||
            tag === "BUTTON" ||
            tag === "LABEL"));

      const annotation = document.createElement("span");
      annotation.dataset.qingyi = "translation";
      annotation.setAttribute("translate", "no");
      annotation.setAttribute("lang", targetLangAttr);

      if (
        isInlineControl &&
        unit.kind === "element" &&
        (tag === "BUTTON" || tag === "A") &&
        unit.source.length <= 28
      ) {
        annotation.style.cssText =
          "display:inline;color:inherit;font:inherit;opacity:var(--qingyi-translation-opacity, 0.88);margin-inline-start:var(--qingyi-translation-inset, 5px);";
        annotation.textContent = `· ${cleanText}`;
      } else if (unit.kind === "inline-run") {
        annotation.style.cssText =
          "display:block;color:inherit;font:inherit;opacity:var(--qingyi-translation-opacity, 0.92);margin-block:var(--qingyi-translation-gap, 3px);border-inline-start:var(--qingyi-translation-stroke, 3px) solid currentColor;padding-inline-start:var(--qingyi-translation-inset, 7px);";
        annotation.textContent = cleanText;
      } else {
        annotation.style.cssText =
          "display:block;color:inherit;font:inherit;opacity:var(--qingyi-translation-opacity, 0.92);margin-block-start:var(--qingyi-translation-gap, 3px);border-inline-start:var(--qingyi-translation-stroke, 3px) solid currentColor;padding-inline-start:var(--qingyi-translation-inset, 7px);";
        annotation.textContent = cleanText;
      }

      if (
        unit.kind === "inline-run" &&
        unit.anchorNode?.parentNode === unit.el
      ) {
        unit.el.insertBefore(annotation, unit.anchorNode.nextSibling);
      } else {
        unit.el.append(annotation);
      }
      unit.annotation = annotation;
    }

    emit(childTrace(t), "render.end", {
      outcome: "success",
      items: 1,
      durationMs: performance.now() - start,
    });
    return true;
  }

  function complete() {
    if (!active || scanning || running || pq.queuedSize > 0) return;
    const isEn = overlay.getLang() === "en";
    const failed = pq.failedCount;
    if (failed > 0) {
      updateProgress(
        isEn
          ? `Finished · ${failed} segment(s) failed`
          : `本轮结束 · ${failed} 段未完成`,
        isEn
          ? "Right-click and translate again to retry failed segments"
          : "右键再次翻译可复用缓存并重试失败段落",
        "warning",
      );
    } else if (cacheWarning) {
      updateProgress(
        isEn
          ? "Translated · Cache writeback paused"
          : "已翻译 · 缓存写回已暂停",
        isEn
          ? "Click Qingyi to check storage space in Settings"
          : "点击“轻译”打开设置查看空间状态",
        "warning",
      );
    } else if (unitLimitReached) {
      updateProgress(
        isEn
          ? "Viewport translated (10,000-segment cap)"
          : "已完成视口翻译（已达 10,000 段上限）",
        isEn
          ? "Use area or selection translation for remaining content"
          : "超长页面超出部分可用划词或框选翻译",
        "neutral",
      );
    } else {
      const moreOffscreen = pq.discoveredCount > pq.renderedCount;
      updateProgress(
        isEn ? "Viewport ready" : "当前视口已完成",
        moreOffscreen
          ? isEn
            ? "Scrolling will translate newly visible paragraphs"
            : "向下滚动时继续按需翻译后续段落"
          : isEn
            ? "Watching for new page text"
            : "监听新增文字",
        "neutral",
      );
    }
    emit(
      trace,
      "operation.end",
      {
        outcome: failed ? "failed" : "success",
        ...(failed ? { reason: "PARTIAL_TRANSLATION" } : {}),
        items: pq.renderedCount,
        hits,
      },
      true,
    );
  }

  function batchMaxItems(): number {
    if (
      info.routing !== "cloud-only" ||
      (info.serviceType !== "deepl" && singleTextModel(info.model))
    ) {
      return 1;
    }
    if (first) return 4;
    return info.batch ? 16 : 1;
  }

  function kick() {
    if (!active || !trace || !pageForeground) return;
    while (running < (info.concurrency || 2) && pq.queuedSize > 0) {
      const maxItems = batchMaxItems();
      const maxChars = first ? 1600 : 5000;
      const dequeued = pq.dequeueBatch({
        maxItems,
        maxChars,
        getLength: (u) => u.source.length,
        onDisconnected: (u) => removeUnitAccounting(u),
      });
      const batch = dequeued.batch;
      if (!batch.length) break;

      first = false;
      running++;
      const token = generation;
      const batchPriority = dequeued.priority;
      const t = childTrace(trace, { batchId: crypto.randomUUID() });
      const versions = batch.map((u) => u.version);

      emit(t, "batch.start", {
        outcome: "started",
        items: batch.length,
        chars: dequeued.chars,
      });

      void (async () => {
        let failures = 0;
        const isEn = overlay.getLang() === "en";
        updateProgress(isEn ? "Checking local cache" : "查询本地缓存");

        let cached: any;
        try {
          cached = await send("LOOKUP", {
            sources: batch.map((u) => u.source),
            sourceLang: document.documentElement.lang || "auto",
            trace: t,
          });
        } catch (lookupErr) {
          if (
            lookupErr instanceof Error &&
            lookupErr.message === "EXTENSION_DISCONNECTED" &&
            token === generation &&
            chrome.runtime?.id
          ) {
            // Service worker restarted: re-enqueue units and wake SW seamlessly (Q-T06).
            await new Promise((r) => setTimeout(r, 350));
            if (token === generation && active) {
              for (const u of batch) pq.enqueue(u, u.tier);
            }
            return;
          }
          throw lookupErr;
        }
        if (token !== generation) return;

        const missing: number[] = [];
        batch.forEach((u, i) => {
          const value = cached.translations[i];
          if (value) {
            if (renderUnit(u, value, versions[i], t)) {
              hits++;
            } else {
              missing.push(i);
            }
          } else {
            missing.push(i);
          }
        });

        if (missing.length) {
          updateProgress(isEn ? "Translating" : "请求翻译中");
          const size =
            info.serviceType !== "deepl" && singleTextModel(info.model)
              ? 1
              : missing.length;
          if (size === 1 && missing.length > 1) {
            emit(childTrace(t), "batch.fallback", {
              outcome: "fallback",
              reason: "model-single-text",
              items: missing.length,
            });
          }

          for (let offset = 0; offset < missing.length; offset += size) {
            if (token !== generation) return;
            if (!pageForeground) {
              // Tab moved to background: return remaining unstarted units to queue and pause dispatching (Q-00).
              for (const remIdx of missing.slice(offset)) {
                pq.enqueue(batch[remIdx], batch[remIdx].tier);
              }
              break;
            }

            const indexes = missing.slice(offset, offset + size);
            const next = childTrace(t, { batchId: crypto.randomUUID() });
            emit(next, "batch.start", {
              outcome: "started",
              items: indexes.length,
              chars: indexes.reduce(
                (sum, i) => sum + batch[i].source.length,
                0,
              ),
            });

            try {
              const result = await send("TRANSLATE", {
                sources: indexes.map((i) => batch[i].source),
                sourceLang: document.documentElement.lang || "auto",
                priority: batchPriority,
                skipLookup: true,
                trace: next,
              });
              if (token !== generation) return;

              cacheWarning ||= !!result.cacheWarning;
              requests += Math.max(
                0,
                (result.requests || 0) -
                  (requestCounts.get(next.batchId!) || 0),
              );
              hits += result.hits || 0;

              let fatalError: string | undefined;
              indexes.forEach((unitIdxInBatch, j) => {
                const translated = result.translations?.[j];
                const segErr = result.errors?.[j];
                if (translated !== null && translated !== undefined) {
                  renderUnit(
                    batch[unitIdxInBatch],
                    translated,
                    versions[unitIdxInBatch],
                    next,
                  );
                } else {
                  if (segErr && FATAL_PAGE_ERRORS.has(segErr)) {
                    fatalError = segErr;
                  } else {
                    markUnitFailed(batch[unitIdxInBatch]);
                    failures++;
                  }
                }
              });

              emit(next, "batch.end", {
                outcome: failures ? "fallback" : "success",
                items: indexes.length,
              });

              if (fatalError) throw new Error(fatalError);
              updateProgress(isEn ? "Translating" : "已回填，继续翻译");
            } catch (e) {
              const reason =
                e instanceof Error ? e.message : "TRANSLATION_FAILED";
              emit(next, "batch.end", {
                outcome: token !== generation ? "cancelled" : "failed",
                reason,
                items: indexes.length,
              });
              if (token !== generation) return;

              if (reason === "CANCELLED") {
                if (!pageForeground) {
                  for (const idx of indexes)
                    pq.enqueue(batch[idx], batch[idx].tier);
                  return;
                }
                throw e;
              }

              // Service worker restart recovery: re-enqueue unfinished units without pausing page (Q-T06).
              if (reason === "EXTENSION_DISCONNECTED" && chrome.runtime?.id) {
                await new Promise((r) => setTimeout(r, 350));
                if (token === generation && active) {
                  for (const idx of indexes)
                    pq.enqueue(batch[idx], batch[idx].tier);
                }
                return;
              }

              // Only global auth/config/quota errors pause the whole page; single-segment errors mark failed & continue (Q-T10).
              if (!FATAL_PAGE_ERRORS.has(reason)) {
                for (const i of indexes) {
                  if (batch[i].translation === undefined) {
                    markUnitFailed(batch[i]);
                    failures++;
                  }
                }
                emit(childTrace(next), "queue.skip", {
                  outcome: "failed",
                  reason,
                  items: indexes.length,
                });
                const resolved = resolveError(reason, overlay.getLang());
                updateProgress(
                  isEn
                    ? "Some segments skipped, continuing"
                    : "部分段落未完成，继续翻译其余内容",
                  resolved.message,
                  "warning",
                );
                continue;
              }
              throw e;
            } finally {
              // Clean up completed batchId counter entry so Map never grows unbounded (Q-T25).
              if (next.batchId) requestCounts.delete(next.batchId);
            }
          }
        } else {
          updateProgress(isEn ? "Cache hit" : "缓存命中");
        }

        emit(t, "batch.end", {
          outcome: failures ? "failed" : "success",
          items: batch.length,
          ...(failures ? { reason: "PARTIAL_TRANSLATION" } : {}),
        });
      })()
        .catch((e) => {
          if (token === generation) {
            const code = e instanceof Error ? e.message : "TRANSLATION_FAILED";
            emit(
              t,
              "batch.end",
              {
                outcome: code === "CANCELLED" ? "cancelled" : "failed",
                reason: code,
                items: batch.length,
              },
              true,
            );
            pause("error", code);
          }
        })
        .finally(() => {
          for (const u of batch) {
            if (!pq.queuedSize) u.queued = false;
          }
          running--;
          if (active && pageForeground) {
            kick();
            complete();
          }
        });
    }
  }

  let observer: MutationObserver | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;

  function observeRoot(root: Node) {
    if (observedRoots.has(root) || !observer) return;
    observedRoots.add(root);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "placeholder", "title"],
    });
  }

  // Single disconnected-before-recreate MutationObserver, watching only text-relevant mutations (Q-07, Q-26).
  function watchDom() {
    observer?.disconnect();
    observedRoots.clear();
    observer = new MutationObserver((mutations) => {
      if (!active) return;
      for (const m of mutations) {
        const targetEl =
          m.target instanceof Element ? m.target : m.target.parentElement;
        if (!targetEl || targetEl.closest("[data-qingyi]")) continue;

        if (m.type === "childList") {
          let addedRelevant = false;
          for (const n of Array.from(m.addedNodes)) {
            if (n.nodeType === 3 && n.textContent?.trim()) {
              dirtyRoots.add(targetEl);
              addedRelevant = true;
            } else if (n instanceof Element && !n.matches("[data-qingyi]")) {
              dirtyRoots.add(n);
              addedRelevant = true;
            }
          }
          if (!addedRelevant) {
            for (const n of Array.from(m.removedNodes)) {
              if (n.nodeType === 3 && n.textContent?.trim()) {
                dirtyRoots.add(targetEl);
              }
            }
          }
        } else if (m.type === "attributes") {
          dirtyRoots.add(targetEl);
        } else if (m.type === "characterData") {
          const existingList = unitsByElement.get(targetEl);
          if (
            !existingList ||
            existingList.some((u) =>
              u.parts.some(
                (p) => p.node === m.target && p.node.data !== p.current,
              ),
            )
          ) {
            dirtyRoots.add(targetEl);
          }
        }
      }
      if (dirtyRoots.size && !scanTimer) {
        scanTimer = setTimeout(drainDirtyRoots, 160);
      }
    });
    observeRoot(document.documentElement);
  }

  function drainDirtyRoots() {
    scanTimer = undefined;
    if (!active) {
      dirtyRoots.clear();
      return;
    }
    const budget = performance.now() + 8;
    while (dirtyRoots.size && performance.now() < budget) {
      const root = dirtyRoots.values().next().value!;
      dirtyRoots.delete(root);
      scan(root);
    }
    if (dirtyRoots.size) scanTimer = setTimeout(drainDirtyRoots, 50);
  }

  // Map internal pause causes to clean localized user messages (Q-45, Q-16, Q-05).
  function pause(
    kind:
      | "user"
      | "restart"
      | "navigation"
      | "config-updated"
      | "original"
      | "error" = "user",
    errorCode?: string,
  ) {
    if (trace) {
      emit(
        trace,
        "operation.cancel",
        { outcome: "cancelled", reason: errorCode || kind },
        true,
      );
      void send("CANCEL", { session }).catch(() => {});
    }
    active = false;
    generation++;
    pq.clearQueue();
    dirtyRoots.clear();
    observer?.disconnect();
    observer = undefined;
    observedRoots.clear();
    nearObserver.disconnect();
    clearTimeout(scanTimer);
    scanTimer = undefined;

    if (kind === "restart" || kind === "navigation") return;

    const isEn = overlay.getLang() === "en";
    if (kind === "original") {
      updateProgress(
        isEn ? "Restored original text" : "已恢复原文",
        "",
        "neutral",
      );
      return;
    }
    if (kind === "config-updated") {
      updateProgress(
        isEn ? "Settings updated" : "翻译配置已更新",
        isEn
          ? "Right-click or press shortcut to continue with the new settings"
          : "右键翻译或按快捷键即可使用新配置继续",
        "neutral",
      );
      return;
    }
    if (kind === "error" && errorCode) {
      if (errorCode === "DAILY_QUOTA_REACHED") {
        const resolved = resolveError(errorCode, overlay.getLang());
        updateProgress(
          isEn ? "Daily cloud limit reached" : "已达今日云端上限",
          resolved.message,
          "neutral",
          true,
        );
        return;
      }
      const resolved = resolveError(errorCode, overlay.getLang());
      updateProgress(
        resolved.message,
        isEn ? "Click Qingyi to check Settings" : "点击“轻译”打开设置检查配置",
        resolved.isCancelled ? "neutral" : "error",
        !resolved.isCancelled,
      );
      return;
    }
    updateProgress(isEn ? "Paused" : "已暂停翻译", "", "neutral");
  }

  function restoreAll() {
    overlay.hidePeek();
    for (const u of allUnits) {
      restoreUnit(u);
      if (
        u.el instanceof HTMLElement &&
        u.el.hasAttribute("data-qingyi-orig-lang")
      ) {
        const prevLang = u.el.getAttribute("data-qingyi-orig-lang") || "";
        u.el.removeAttribute("data-qingyi-orig-lang");
        if (prevLang) u.el.setAttribute("lang", prevLang);
        else u.el.removeAttribute("lang");
      }
    }
  }

  // Serialized start so rapid double-clicks or mode switches never race or leak observers (Q-07).
  function start(
    nextMode: string,
    provided?: Trace,
    userInitiated = false,
  ): Promise<void> {
    startQueue = startQueue
      .catch(() => {})
      .then(async () => {
        if (active) pause("restart");
        restoreAll();
        info = await send("PUBLIC");
        if (info.never && !userInitiated) return;

        overlay.setTheme(info.theme || "system");
        overlay.setLocale(info.locale);
        overlay.setProgressPreference(info.progressVisible !== false);
        applyTranslationStyleVars(info.translationStyle);
        overlay.resetSessionClose(userInitiated);

        mode = nextMode === "bilingual" ? "bilingual" : "chinese";
        generation++;
        session = crypto.randomUUID();
        trace = validTrace(provided)
          ? childTrace(provided, { sessionId: session })
          : newTrace(session);
        active = true;
        first = true;
        requests = 0;
        hits = 0;
        cacheWarning = false;
        unitLimitReached = false;
        requestCounts.clear();
        allUnits.clear();
        unitsByElement = new WeakMap();
        pq.resetAll();

        emit(trace, "operation.start", { outcome: "started" });
        watchDom();
        const scanRoot = info.siteRule?.articleOnly
          ? detectMainArticleRoot(document)
          : document.body;
        if (scanRoot) scan(scanRoot);
        updateProgress(
          overlay.getLang() === "en" ? "Scanning page" : "正在扫描页面",
          "",
          "neutral",
        );
      });
    return startQueue;
  }

  // Incremental SPA route update: retain already-translated DOM and scan only new/changed content without flashing (Q-08).
  function handleSpaRoute() {
    if (!active) return;
    const scanRoot = info.siteRule?.articleOnly
      ? detectMainArticleRoot(document)
      : document.body;
    if (scanRoot) scan(scanRoot);
  }

  async function translateSelectedArea(elements: Element[]) {
    if (!active) {
      await start(info.mode || "bilingual", undefined, true);
      // Pause full-page scan and clear non-selected queue so only chosen elements translate
      pq.clearQueue();
    }
    for (const el of elements) {
      scan(el, true);
    }
    kick();
  }

  // --- Selection Translation ("翻译选中文字", Priority 0, Prompt item 7) ---
  async function handleSelectionTranslate() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || "";
    if (!text || !sel || sel.rangeCount === 0) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    overlay.showSelectionPopover({ rect, source: text, loading: true });

    const t = newTrace();
    try {
      const cached = await send("LOOKUP", {
        sources: [text],
        sourceLang: document.documentElement.lang || "auto",
        trace: t,
      });
      if (cached.translations?.[0]) {
        overlay.showSelectionPopover({
          rect,
          source: text,
          translation: cached.translations[0],
          channel: "cache",
        });
        return;
      }
      const res = await send("TRANSLATE", {
        sources: [text],
        sourceLang: document.documentElement.lang || "auto",
        priority: 0,
        skipLookup: true,
        trace: t,
      });
      const translated = res.translations?.[0];
      if (!translated) {
        const code = res.errors?.[0] || "TRANSLATION_FAILED";
        throw new Error(code);
      }
      overlay.showSelectionPopover({
        rect,
        source: text,
        translation: translated,
        channel: res.channels?.[0] || "cloud",
      });
    } catch (err) {
      const resolved = resolveError(err, overlay.getLang());
      overlay.showSelectionPopover({
        rect,
        source: text,
        error: resolved.message,
      });
    }
  }

  // --- Right-click Target Tracking for "修正此译文" & Hover/Click Original Peek (Prompt item 13) ---
  let lastContextUnit: Unit | undefined;
  let lastContextRect: DOMRect | undefined;

  function findTranslatedUnitAt(target: EventTarget | null): Unit | undefined {
    let el =
      target instanceof Element
        ? target
        : (target as Node | null)?.parentElement;
    while (el && el !== document.body) {
      if (
        el instanceof HTMLElement &&
        el.dataset.qingyi === "translation" &&
        el.parentElement
      ) {
        el = el.parentElement;
      }
      const list = unitsByElement.get(el);
      const found = list?.find(
        (u) => u.kind !== "attribute" && u.translation !== undefined,
      );
      if (found) return found;
      el = el.parentElement;
    }
    return undefined;
  }

  document.addEventListener(
    "contextmenu",
    (e) => {
      const u = findTranslatedUnitAt(e.target);
      lastContextUnit = u;
      lastContextRect = u ? u.el.getBoundingClientRect() : undefined;
    },
    true,
  );

  // In translated ("chinese") mode: hover shows original text tooltip, Alt+Click (or click on non-interactive text) toggles original/translation (Prompt item 13).
  let hoveredUnit: Unit | undefined;
  document.addEventListener("pointermove", (e) => {
    if (!active || mode !== "chinese") {
      if (hoveredUnit) {
        hoveredUnit = undefined;
        overlay.hidePeek();
      }
      return;
    }
    const u = findTranslatedUnitAt(e.target);
    if (!u || u.showingOriginal) {
      if (hoveredUnit) {
        hoveredUnit = undefined;
        overlay.hidePeek();
      }
      return;
    }
    hoveredUnit = u;
    const origText = u.parts
      .map((p) => p.original)
      .join("")
      .trim();
    if (origText) overlay.showPeek(origText, e.clientX, e.clientY);
  });

  document.addEventListener("click", (e) => {
    if (!active || mode !== "chinese" || e.button !== 0) return;
    const target = e.target as Element | null;
    if (!target) return;
    // Do not hijack links, buttons, inputs, or active text selections
    if (
      !e.altKey &&
      (target.closest(
        "a,button,input,select,textarea,summary,[role='button']",
      ) ||
        (window.getSelection()?.toString().length || 0) > 0)
    ) {
      return;
    }
    const u = findTranslatedUnitAt(target);
    if (!u || !u.translation) return;
    if (!u.showingOriginal) {
      for (const p of u.parts) {
        p.node.data = p.original;
        p.current = p.original;
      }
      u.showingOriginal = true;
      overlay.hidePeek();
    } else {
      u.showingOriginal = false;
      renderUnit(u, u.translation, u.version, trace || newTrace());
    }
  });

  function openInlineRevisionForLastTarget() {
    const unit = lastContextUnit;
    if (!unit || !unit.translation) {
      const isEn = overlay.getLang() === "en";
      updateProgress(
        isEn
          ? "Right-click a translated paragraph first"
          : "请先在已翻译的段落上点击右键选择“修正此译文”",
        "",
        "neutral",
        true,
      );
      return;
    }
    const rect = lastContextRect || unit.el.getBoundingClientRect();
    overlay.showRevisionEditor({
      rect,
      source: unit.source,
      initialTranslation: unit.translation,
      onSaved: (newVal) => {
        renderUnit(unit, newVal, unit.version, trace || newTrace());
      },
    });
  }

  // --- Visibility & Foreground Tab Sync (Q-00, Item 6) ---
  function onForegroundChanged(nowForeground: boolean) {
    if (pageForeground === nowForeground) return;
    pageForeground = nowForeground;
    void send("TAB_VISIBILITY", { hidden: !nowForeground }).catch(() => {});
    if (nowForeground && active) {
      // Refresh viewport priority for discovered unfinished units when returning to foreground
      for (const u of allUnits) {
        if (u.translation === undefined && !u.failed && u.isConnected()) {
          const tier = computeViewportTier(u.el);
          if (tier <= 2) pq.enqueue(u, tier);
        }
      }
      kick();
    }
  }

  document.addEventListener("visibilitychange", () => {
    onForegroundChanged(!document.hidden);
  });

  async function control(m: any) {
    switch (m.command) {
      case "translate":
        return start(m.mode || info.mode, m.trace, true);
      case "toggle-mode": {
        const next = active && mode === "chinese" ? "bilingual" : "chinese";
        return start(next, m.trace, true);
      }
      case "route":
        handleSpaRoute();
        return;
      case "original":
        pause("original");
        restoreAll();
        return;
      case "pause":
        pause("user");
        return;
      case "progress":
        overlay.showProgressExplicitly();
        updateProgress(currentStatusText, currentHintText, currentTone, true);
        return;
      case "translate-selection":
        if (
          isTopFrame ||
          (window.getSelection()?.toString().trim().length || 0) > 0
        ) {
          await handleSelectionTranslate();
        }
        return;
      case "edit-translation":
        if (lastContextUnit || isTopFrame) openInlineRevisionForLastTarget();
        return;
      case "area-select":
        overlay.startAreaSelection();
        return;
      case "tab-activated":
        onForegroundChanged(!document.hidden);
        return;
      case "tab-deactivated":
        onForegroundChanged(false);
        return;
      case "config-updated":
        if (active) {
          info = await send("PUBLIC");
          pause("config-updated");
        }
        return;
      case "notify-error":
        if (isTopFrame && m.code) {
          const resolved = resolveError(m.code, overlay.getLang());
          updateProgress(resolved.message, "", "error", true);
        }
        return;
    }
  }

  let resumeAfterPageShow = false;
  document.addEventListener("qingyi-shadow-ready", (event) => {
    if (!active || !(event.target instanceof Element)) return;
    const sr = getShadowRootAny(event.target, overlay.host);
    if (sr && !observedRoots.has(sr)) {
      observeRoot(sr);
      scan(sr);
    }
  });

  addEventListener("pagehide", () => {
    resumeAfterPageShow = active;
    flushTraces();
    pause("navigation");
  });

  addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) {
      overlay.resetSessionClose(false);
      if (resumeAfterPageShow) void start(mode);
    }
  });

  if (info.auto && !info.never) await start(info.mode, undefined, false);

  return {
    control,
    networkProgress: (m: any) => {
      if (!active || trace?.traceId !== m.traceId) return;
      if (typeof m.batchId === "string" && Number.isSafeInteger(m.requests)) {
        requests += Math.max(
          0,
          m.requests - (requestCounts.get(m.batchId) || 0),
        );
        requestCounts.set(m.batchId, m.requests);
      }
      const isEn = overlay.getLang() === "en";
      if (m.state === "local-loading") {
        updateProgress(
          isEn ? "Local model starting…" : "本地模型启动中…",
          isEn
            ? "Waiting for mistral-gui to load weights (not counted against timeout)"
            : "等待本地模型加载就绪，不计入单次超时且不回退云端",
          "neutral",
        );
      } else if (m.state === "retry") {
        updateProgress(isEn ? "Retrying request…" : "接口重试中");
      } else if (m.state === "queue") {
        updateProgress(isEn ? "Queued for translation" : "排队等待翻译");
      } else {
        updateProgress(isEn ? "Translating" : "请求翻译中");
      }
    },
  };
}

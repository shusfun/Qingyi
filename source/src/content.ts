import { newTrace, childTrace, validTrace } from "./trace";
import { validTranslation, type Trace } from "./types";
import { singleTextModel } from "./model-profile";
declare global {
  interface Window {
    __qingyi3?: { runtime: typeof chrome.runtime };
  }
}
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
  const r = await chrome.runtime.sendMessage({ type, ...payload });
  if (!r?.ok) throw Error(r?.error || "EXTENSION_DISCONNECTED");
  return r.data;
}
async function launch() {
  let info = await send("PUBLIC");
  let active = false,
    mode = info.mode,
    trace: Trace | undefined,
    session = "",
    running = 0,
    first = true,
    closed = false,
    requests = 0,
    hits = 0,
    rendered = 0,
    scanning = 0;
  let generation = 0;
  let cacheWarning = false;
  const requestCounts = new Map<string, number>();
  const skip =
    'script,style,noscript,textarea,input,select,option,svg,math,canvas,pre,code,kbd,samp,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-qingyi]';
  const block =
    "p,li,h1,h2,h3,h4,h5,h6,td,th,button,label,figcaption,blockquote,dt,dd";
  type Part = { node: Text; original: string; current: string; token: string };
  type Unit = {
    el: Element;
    parts: Part[];
    source: string;
    translation?: string;
    annotation?: HTMLElement;
    visible: boolean;
    queued: boolean;
    failed?: boolean;
    version: number;
  };
  let byElement = new WeakMap<Element, Unit>();
  const units = new Set<Unit>(),
    queue = new Set<Unit>(),
    roots = new Set<Node>(),
    observed = new Set<Node>();
  const host = document.createElement("div");
  host.dataset.qingyi = "ui";
  host.style.cssText =
    "position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;z-index:2147483647!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `<style>:host{all:initial;font:12px/1.5 system-ui;color:#292824}*{box-sizing:border-box}[hidden]{display:none!important}.box{position:fixed;right:16px;bottom:16px;width:300px;max-width:calc(100vw - 16px);background:#faf9f5f5;border:1px solid #ddd9ce;border-radius:9px;padding:9px 11px;box-shadow:0 3px 16px #2928241a;backdrop-filter:blur(10px)}.top{display:flex;gap:8px;align-items:center;touch-action:none}.settings{font:inherit;font-weight:700;color:inherit;background:none;border:0;padding:0;cursor:pointer;user-select:none;touch-action:none}.settings:focus-visible{outline:2px solid #c96442;outline-offset:3px;border-radius:2px}.state{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:#716f66}.close{font:18px system-ui;cursor:pointer;background:none;border:0;color:#716f66}.counts{font-size:11px;color:#716f66;margin:3px 0 6px}.track{height:3px;border-radius:3px;background:#e8e4d9;overflow:hidden}.fill{height:100%;background:#c96442;width:0}.error .state{color:#b4432f}@media(prefers-reduced-motion:no-preference){.fill{transition:width .2s}}</style><section class="box" hidden aria-label="轻译统计"><div class="top"><button type="button" class="settings">轻译</button><span class="state" role="status"></span><button class="close" aria-label="关闭本页进度条">×</button></div><div class="counts"></div><div class="track" role="progressbar" aria-label="翻译进度" aria-valuemin="0" aria-valuemax="100"><div class="fill"></div></div></section>`;
  const box = shadow.querySelector(".box") as HTMLElement,
    state = shadow.querySelector(".state")!,
    counts = shadow.querySelector(".counts")!,
    fill = shadow.querySelector(".fill") as HTMLElement,
    track = shadow.querySelector(".track")!;
  let message = "等待开始";
  function emit(
    t: Trace | undefined,
    event: string,
    fields: Record<string, unknown> = {},
  ) {
    if (t) void send("TRACE", { trace: t, event, fields }).catch(() => {});
  }
  function mount() {
    if (!host.isConnected) document.documentElement.append(host);
    box.hidden = closed || info.progressVisible === false;
    if (info.position && !drag) {
      box.style.right = "auto";
      box.style.bottom = "auto";
      box.style.left =
        Math.max(
          8,
          Math.min(
            innerWidth - box.offsetWidth - 8,
            info.position.x * innerWidth,
          ),
        ) + "px";
      box.style.top =
        Math.max(
          8,
          Math.min(
            innerHeight - box.offsetHeight - 8,
            info.position.y * innerHeight,
          ),
        ) + "px";
    }
  }
  function progress(text = message, error = false) {
    message = text;
    state.textContent = text;
    state.setAttribute("title", text);
    box.classList.toggle("error", error);
    const currentRendered = [...units].filter(
      (unit) => unit.translation !== undefined,
    ).length;
    const failed = [...units].filter((u) => u.failed).length;
    counts.textContent = `已译 ${currentRendered} / ${units.size} · 缓存 ${hits} · 排队 ${queue.size} · 请求 ${requests}${failed ? ` · 失败 ${failed}` : ""}`;
    const value = units.size
      ? Math.min(100, Math.round((currentRendered / units.size) * 100))
      : 0;
    fill.style.width = value + "%";
    track.setAttribute("aria-valuenow", String(value));
    mount();
  }
  shadow.querySelector(".close")!.addEventListener("click", () => {
    closed = true;
    box.hidden = true;
  });
  const settings = shadow.querySelector(".settings")!;
  settings.setAttribute("title", "点击打开设置；拖动记住位置");
  settings.setAttribute("aria-label", "轻译设置，拖动可调整位置");
  let suppressClick = false;
  async function openSettings() {
    const t = newTrace(session || undefined);
    emit(t, "control.start", { outcome: "started", resourceId: "settings" });
    try {
      await send("OPEN_SETTINGS", { trace: t });
      emit(t, "control.end", { outcome: "success", resourceId: "settings" });
    } catch {
      emit(t, "control.end", { outcome: "failed", resourceId: "settings" });
      progress("无法打开设置，请从扩展管理页进入", true);
    }
  }
  settings.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      return;
    }
    void openSettings();
  });
  settings.addEventListener("keydown", () => {
    suppressClick = false;
  });
  let drag:
    | {
        x: number;
        y: number;
        left: number;
        top: number;
        moved: boolean;
        pointer: number;
      }
    | undefined;
  settings.addEventListener("pointerdown", (e) => {
    const p = e as PointerEvent,
      r = box.getBoundingClientRect();
    if (!p.isPrimary || p.button !== 0) return;
    suppressClick = false;
    drag = {
      x: p.clientX,
      y: p.clientY,
      left: r.left,
      top: r.top,
      moved: false,
      pointer: p.pointerId,
    };
    (e.target as Element).setPointerCapture(p.pointerId);
  });
  shadow.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = e as PointerEvent;
    if (p.pointerId !== drag.pointer) return;
    if (Math.hypot(p.clientX - drag.x, p.clientY - drag.y) < 6 && !drag.moved)
      return;
    drag.moved = true;
    suppressClick = true;
    box.style.right = "auto";
    box.style.bottom = "auto";
    box.style.left =
      Math.max(
        8,
        Math.min(
          innerWidth - box.offsetWidth - 8,
          drag.left + p.clientX - drag.x,
        ),
      ) + "px";
    box.style.top =
      Math.max(
        8,
        Math.min(
          innerHeight - box.offsetHeight - 8,
          drag.top + p.clientY - drag.y,
        ),
      ) + "px";
  });
  shadow.addEventListener("pointerup", (e) => {
    if (!drag || (e as PointerEvent).pointerId !== drag.pointer) return;
    const moved = drag.moved;
    drag = undefined;
    if (!moved) return;
    const r = box.getBoundingClientRect();
    info.position = { x: r.left / innerWidth, y: r.top / innerHeight };
    void send("POSITION", info.position).catch(() => {});
  });
  shadow.addEventListener("pointercancel", () => {
    drag = undefined;
    suppressClick = false;
    mount();
  });
  function eligible(el: Element) {
    return (
      !el.closest(skip) &&
      !el.closest('[hidden],[aria-hidden="true"]') &&
      el.getClientRects().length > 0
    );
  }
  function useful(s: string) {
    return (
      s.trim().length > 1 &&
      /[a-z\u00c0-\u024f\u0370-\u052f\u0600-\u06ff\u3040-\u30ff\uac00-\ud7af]/i.test(
        s,
      ) &&
      !/^\s*(https?:\/\/|www\.|\S+@\S+\.\S+$)/.test(s) &&
      ((s.match(/[a-z]/gi) || []).length >
        (s.match(/[\u3400-\u9fff]/g) || []).length * 2 ||
        /[\u3040-\u30ff\uac00-\ud7af]/.test(s))
    );
  }
  function collect(el: Element) {
    if (!eligible(el) || units.size >= 10000) return;
    let existing = byElement.get(el);
    if (
      existing &&
      existing.parts.every(
        (p) => p.node.isConnected && p.node.data === p.current,
      )
    ) {
      if (
        existing.translation === undefined &&
        !existing.queued &&
        !existing.failed
      ) {
        queue.add(existing);
        existing.queued = true;
      }
      return;
    }
    if (existing) {
      existing.annotation?.remove();
      units.delete(existing);
      queue.delete(existing);
      existing.version++;
    }
    const parts: Part[] = [];
    let source = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement?.closest(skip)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const token = "__QY" + parts.length + "__";
      parts.push({
        node: node as Text,
        original: node.textContent,
        current: node.textContent,
        token,
      });
      source += token + node.textContent;
    }
    if (parts.length === 1) {
      parts[0].token = "";
      source = parts[0].original.trim();
    }
    if (
      !parts.length ||
      !useful(parts.map((p) => p.original).join(" ")) ||
      source.length > 24000
    )
      return;
    const rect = el.getBoundingClientRect();
    const unit: Unit = {
      el,
      parts,
      source,
      visible: rect.bottom >= 0 && rect.top <= innerHeight,
      queued: true,
      version: 0,
    };
    units.add(unit);
    byElement.set(el, unit);
    queue.add(unit);
    intersection.observe(el);
  }
  const intersection = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const unit = byElement.get(entry.target);
        if (unit) unit.visible = entry.isIntersecting;
      }
      kick();
    },
    { rootMargin: "200px" },
  );
  function inspect(el: Element) {
    if (el === host || el.closest(skip)) return false;
    const root = el.shadowRoot;
    if (root && !observed.has(root)) {
      observe(root);
      scan(root);
    }
    if (el.matches(block)) {
      if (!el.querySelector(block)) collect(el);
      return !el.querySelector(block);
    }
    if (
      el.matches("div,section,article,main,span,a") &&
      el.childNodes.length &&
      ![...el.children].some((e) =>
        e.matches(block + ",div,section,article,main"),
      ) &&
      el.textContent?.trim()
    ) {
      collect(el);
      return true;
    }
    return false;
  }
  function scan(root: Node) {
    if (!active || !root.isConnected) return;
    const t = trace ? childTrace(trace) : undefined,
      start = performance.now(),
      token = generation;
    scanning++;
    emit(t, "scan.start", { outcome: "started" });
    const pending: Element[] =
      root instanceof Element
        ? [root]
        : [...root.childNodes].filter(
            (n): n is Element => n instanceof Element,
          );
    const step = () => {
      if (!active || token !== generation) {
        scanning--;
        return;
      }
      const budget = performance.now() + 8;
      while (pending.length && performance.now() < budget) {
        const el = pending.pop()!;
        if (el === host || el.matches(skip)) continue;
        if (!inspect(el)) pending.push(...[...el.children].reverse());
      }
      kick();
      progress("扫描与缓存查询");
      if (pending.length) setTimeout(step, 0);
      else {
        scanning--;
        for (const unit of units)
          if (!unit.el.isConnected) {
            units.delete(unit);
            queue.delete(unit);
            unit.annotation?.remove();
            intersection.unobserve(unit.el);
          }
        emit(t, "scan.end", {
          outcome: "success",
          durationMs: performance.now() - start,
          items: units.size,
        });
        if (!queue.size && !running) complete();
      }
    };
    step();
  }
  function render(unit: Unit, value: string, version: number, t: Trace) {
    const start = performance.now();
    if (
      unit.version !== version ||
      !unit.el.isConnected ||
      !unit.parts.every(
        (p) =>
          p.node.isConnected &&
          unit.el.contains(p.node) &&
          p.node.data === p.current,
      )
    ) {
      emit(childTrace(t), "render.end", {
        outcome: "cancelled",
        reason: "source-snapshot-changed",
        durationMs: performance.now() - start,
      });
      return;
    }
    if (!validTranslation(unit.source, value)) {
      emit(childTrace(t), "render.end", {
        outcome: "failed",
        reason: "placeholder-validation",
      });
      return;
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
      emit(childTrace(t), "render.end", {
        outcome: "failed",
        reason: "placeholder-order",
      });
      return;
    }
    unit.annotation?.remove();
    unit.annotation = undefined;
    unit.translation = value;
    if (mode === "chinese") {
      unit.parts.forEach((p, i) => {
        const text = value.slice(
          matches[i].index! + tokens[i].length,
          i + 1 < matches.length ? matches[i + 1].index : undefined,
        );
        p.current = text;
        p.node.data = text;
      });
    } else {
      const annotation = document.createElement("span");
      annotation.dataset.qingyi = "translation";
      annotation.setAttribute("translate", "no");
      annotation.style.cssText =
        "display:block;color:#a35035;font-size:.94em;line-height:1.65;margin:3px 0 5px";
      annotation.textContent = value.replace(/__QY\d+__/g, "");
      unit.el.after(annotation);
      unit.annotation = annotation;
    }
    rendered++;
    emit(childTrace(t), "render.end", {
      outcome: "success",
      items: 1,
      durationMs: performance.now() - start,
    });
  }
  function complete() {
    if (active && !scanning && !running && !queue.size) {
      const failed = [...units].filter((u) => u.failed).length;
      progress(
        failed
          ? `本轮结束 · ${failed} 段失败，右键翻译可重试`
          : cacheWarning
            ? "已翻译 · 缓存写回暂停，请检查设置"
            : "完成 · 监听新增文字",
        cacheWarning || failed > 0,
      );
      emit(trace, "operation.end", {
        outcome: failed ? "failed" : "success",
        ...(failed ? { reason: "PARTIAL_TRANSLATION" } : {}),
        items: rendered,
        hits,
      });
    }
  }
  function kick() {
    if (!active || !trace) return;
    while (running < info.concurrency && queue.size) {
      const sorted = [...queue].sort(
        (a, b) => Number(b.visible) - Number(a.visible),
      );
      const batch: Unit[] = [];
      let chars = 0;
      for (const u of sorted) {
        if (!u.el.isConnected) {
          queue.delete(u);
          continue;
        }
        if (
          batch.length &&
          (batch.length >=
            (info.routing !== "cloud-only" || singleTextModel(info.model)
              ? 1
              : first
                ? 4
                : info.batch
                  ? 16
                  : 1) ||
            chars + u.source.length > (first ? 1600 : 5000))
        )
          break;
        batch.push(u);
        chars += u.source.length;
        queue.delete(u);
        // Keep the unit reserved during lookup and network work.
      }
      if (!batch.length) break;
      first = false;
      running++;
      const token = generation,
        t = childTrace(trace, { batchId: crypto.randomUUID() }),
        versions = batch.map((u) => u.version);
      emit(t, "batch.start", {
        outcome: "started",
        items: batch.length,
        chars,
      });
      void (async () => {
        let failures = 0;
        progress("查询本地缓存");
        const cached = await send("LOOKUP", {
          sources: batch.map((u) => u.source),
          sourceLang: document.documentElement.lang || "auto",
          trace: t,
        });
        if (token !== generation) return;
        const missing: number[] = [];
        batch.forEach((u, i) => {
          const value = cached.translations[i];
          if (value) {
            render(u, value, versions[i], t);
            hits++;
          } else missing.push(i);
        });
        progress(missing.length ? "排队／请求翻译" : "缓存命中");
        if (missing.length) {
          // A single-segment model must commit and render each response before
          // requesting the next segment, so a late failure cannot lose results.
          const size = singleTextModel(info.model) ? 1 : missing.length;
          if (size === 1 && missing.length > 1)
            emit(childTrace(t), "batch.fallback", {
              outcome: "fallback",
              reason: "model-single-text",
              items: missing.length,
            });
          for (let offset = 0; offset < missing.length; offset += size) {
            if (token !== generation) return;
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
                trace: next,
              });
              if (token !== generation) return;
              cacheWarning ||= !!result.cacheWarning;
              requests += Math.max(
                0,
                (result.requests || 0) -
                  (requestCounts.get(next.batchId!) || 0),
              );
              requestCounts.set(next.batchId!, result.requests || 0);
              hits += result.hits || 0;
              indexes.forEach((i, j) =>
                render(batch[i], result.translations[j], versions[i], next),
              );
              emit(next, "batch.end", {
                outcome: "success",
                items: indexes.length,
              });
              progress("已回填，继续翻译");
            } catch (e) {
              const reason =
                e instanceof Error ? e.message : "TRANSLATION_FAILED";
              emit(next, "batch.end", {
                outcome: token !== generation ? "cancelled" : "failed",
                reason,
                items: indexes.length,
              });
              if (token !== generation) return;
              if (
                [
                  "TIMEOUT",
                  "NETWORK_OR_RESPONSE_ERROR",
                  "HTTP_500",
                  "HTTP_502",
                  "HTTP_503",
                  "HTTP_504",
                  "INVALID_TRANSLATION",
                  "TRANSLATION_TRUNCATED",
                  "INVALID_PROVIDER_RESPONSE",
                ].includes(reason)
              ) {
                indexes.forEach((i) => {
                  batch[i].failed = true;
                });
                failures += indexes.length;
                emit(childTrace(next), "queue.skip", {
                  outcome: "failed",
                  reason,
                  items: indexes.length,
                });
                progress("部分段落失败，继续翻译其余内容", true);
                continue;
              }
              throw e;
            }
          }
        }
        emit(t, "batch.end", {
          outcome: failures ? "failed" : "success",
          items: batch.length,
          ...(failures ? { reason: "PARTIAL_TRANSLATION" } : {}),
        });
      })()
        .catch((e) => {
          if (token === generation) {
            emit(t, "batch.end", {
              outcome: e.message === "CANCELLED" ? "cancelled" : "failed",
              reason: e.message,
              items: batch.length,
            });
            pause(e.message);
            progress(errorMessage(e.message), true);
          }
        })
        .finally(() => {
          batch.forEach((u) => {
            u.queued = false;
          });
          running--;
          if (active) {
            kick();
            complete();
          }
        });
    }
  }
  function errorMessage(code: string) {
    return (
      (
        {
          KEY_REQUIRED: "请先在设置中保存 API Key",
          API_PERMISSION_REQUIRED: "请在设置中授权 API 地址",
          HTTP_401: "Key 无效或权限不足",
          HTTP_429: "服务限流，稍后重试",
          TIMEOUT: "服务响应超时，已保留完成部分；点击轻译查看设置",
          NETWORK_OR_RESPONSE_ERROR: "网络或响应异常，已保留完成部分",
          CANCELLED: "已暂停",
          OPFS_UNSUPPORTED: "此浏览器不支持 OPFS",
        } as Record<string, string>
      )[code] || code
    );
  }
  let observer: MutationObserver | undefined,
    scanTimer: ReturnType<typeof setTimeout> | undefined;
  function observe(root: Node) {
    if (observed.has(root)) return;
    observed.add(root);
    observer?.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "class", "style"],
    });
  }
  function watch() {
    observer = new MutationObserver((mutations) => {
      if (!active) return;
      for (const m of mutations) {
        if ((m.target as Element).closest?.("[data-qingyi]")) continue;
        if (m.type === "childList") {
          if (
            [...m.addedNodes, ...m.removedNodes].some(
              (n) => n.nodeType === Node.TEXT_NODE,
            )
          )
            roots.add(m.target);
          for (const n of m.addedNodes) {
            if (n instanceof Element && !n.matches("[data-qingyi]"))
              roots.add(n);
          }
        } else if (m.type === "attributes") {
          roots.add(m.target);
        } else if (m.target.parentElement) {
          const el =
            m.target.parentElement.closest(block) || m.target.parentElement;
          const unit = byElement.get(el);
          if (!unit || unit.parts.some((p) => p.node.data !== p.current))
            roots.add(el);
        }
      }
      if (!host.isConnected) mount();
      if (!scanTimer) scanTimer = setTimeout(drainRoots, 100);
    });
    observed.clear();
    observe(document.documentElement);
  }
  function drainRoots() {
    scanTimer = undefined;
    if (!active) {
      roots.clear();
      return;
    }
    const budget = performance.now() + 8;
    while (roots.size && performance.now() < budget) {
      const root = roots.values().next().value!;
      roots.delete(root);
      scan(root);
    }
    if (roots.size) scanTimer = setTimeout(drainRoots, 0);
  }
  function pause(reason = "已暂停") {
    if (trace) {
      emit(trace, "operation.cancel", { outcome: "cancelled", reason });
      void send("CANCEL", { session }).catch(() => {});
    }
    active = false;
    generation++;
    queue.clear();
    observer?.disconnect();
    observed.clear();
    clearTimeout(scanTimer);
    scanTimer = undefined;
    progress(reason);
  }
  function restore() {
    for (const u of units) {
      u.annotation?.remove();
      u.annotation = undefined;
      for (const p of u.parts)
        if (p.node.data === p.current) {
          p.node.data = p.original;
          p.current = p.original;
        }
    }
  }
  async function start(nextMode: string, provided?: Trace) {
    if (active) pause("restart");
    restore();
    info = await send("PUBLIC");
    mode = nextMode === "bilingual" ? "bilingual" : "chinese";
    generation++;
    session = crypto.randomUUID();
    trace = validTrace(provided)
      ? childTrace(provided, { sessionId: session })
      : newTrace(session);
    active = true;
    first = true;
    requests = hits = rendered = 0;
    cacheWarning = false;
    requestCounts.clear();
    units.clear();
    byElement = new WeakMap();
    queue.clear();
    emit(trace, "operation.start", { outcome: "started" });
    watch();
    scan(document.body);
    progress("扫描");
  }
  async function control(m: any) {
    switch (m.command) {
      case "translate":
        return start(m.mode, m.trace);
      case "route":
        if (active) return start(mode);
        return;
      case "original":
        pause("已恢复原文");
        restore();
        return;
      case "pause":
        return pause();
      case "progress":
        closed = false;
        return progress();
    }
  }
  let resumeAfterPageShow = false;
  document.addEventListener("qingyi-shadow-ready", (event) => {
    if (active && event.target instanceof Element) scan(event.target);
  });
  addEventListener("pagehide", () => {
    resumeAfterPageShow = active;
    pause("page-navigation");
  });
  addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) {
      mount();
      if (resumeAfterPageShow) void start(mode);
    }
  });
  addEventListener("resize", () => {
    if (active) mount();
  });
  if (info.auto) await start(info.mode);
  return {
    control,
    networkProgress: (m: any) => {
      if (active && trace?.traceId === m.traceId) {
        if (typeof m.batchId === "string" && Number.isSafeInteger(m.requests)) {
          requests += Math.max(
            0,
            m.requests - (requestCounts.get(m.batchId) || 0),
          );
          requestCounts.set(m.batchId, m.requests);
        }
        progress(
          m.state === "retry"
            ? "接口重试中"
            : m.state === "queue"
              ? "未命中，排队中"
              : "请求翻译中",
        );
      }
    },
  };
}

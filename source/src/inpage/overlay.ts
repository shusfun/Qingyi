import themeTokens from "../../design-system/tokens.css";
import progressStyles from "../ui/progress.css";
import { normalizePageLang as normalizeUiLang } from "./errors-lite";

// Strict host-level style isolation so page div/html rules cannot distort or hide overlay (Q-V1, Q-V2).
const HOST_ISOLATION_CSS =
  "all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;display:block!important;visibility:visible!important;opacity:1!important;transform:none!important;filter:none!important;contain:none!important;pointer-events:none!important;";

export interface OverlayCallbacks {
  onOpenSettings: () => void;
  onSavePosition: (pos: { x: number; y: number }) => void;
  onSaveRevision: (payload: {
    source: string;
    translation: string;
  }) => Promise<void>;
  onAreaSelected: (elements: Element[]) => void;
}

export interface ProgressSnapshot {
  statusText: string;
  hintText?: string;
  tone?: "neutral" | "warning" | "error";
  rendered: number;
  discovered: number;
  hits: number;
  queued: number;
  requests: number;
  failed: number;
  capped?: boolean;
  forceShow?: boolean;
}

export function createInPageOverlay(
  initial: {
    theme: string;
    locale?: string;
    progressVisible: boolean;
    position?: { x: number; y: number };
    isTopFrame: boolean;
  },
  callbacks: OverlayCallbacks,
) {
  let lang = normalizeUiLang(
    initial.locale ||
      (typeof navigator !== "undefined" ? navigator.language : "zh-CN"),
  );
  let progressVisible = initial.progressVisible;
  let position = initial.position;
  let closedForSession = false;
  let forceVisible = false;
  let boxWidth = 301;
  let boxHeight = 85;
  let rafId = 0;
  let pendingSnapshot: ProgressSnapshot | undefined;

  const host = document.createElement("qingyi-overlay");
  host.dataset.qingyi = "ui";
  host.style.cssText = HOST_ISOLATION_CSS;
  host.dataset.theme = initial.theme || "system";

  // Promote host to browser top layer where supported so modal <dialog> cannot cover it (Q-V2).
  try {
    if ("popover" in host) {
      (host as any).popover = "manual";
    }
  } catch {
    // fallback to z-index: 2147483647
  }

  const shadow = host.attachShadow({ mode: "closed" });
  const en = () => lang === "en";

  shadow.innerHTML = `
    <style>${themeTokens}${progressStyles}</style>
    <section class="box" hidden aria-label="轻译统计">
      <div class="top">
        <button type="button" class="settings">轻译</button>
        <div class="state-wrap">
          <span class="state" role="status"></span>
          <span class="hint-line" hidden></span>
        </div>
        <button type="button" class="close" aria-label="关闭本页进度条">×</button>
      </div>
      <div class="counts"></div>
      <div class="track" role="progressbar" aria-label="翻译进度" aria-valuemin="0" aria-valuemax="100">
        <div class="fill"></div>
      </div>
    </section>
    <section class="popover" hidden role="dialog"></section>
    <div class="peek-tip" hidden></div>
    <div class="area-banner" hidden></div>
    <div class="area-rect" hidden></div>
  `;

  const box = shadow.querySelector(".box") as HTMLElement;
  const settingsBtn = shadow.querySelector(".settings") as HTMLButtonElement;
  const stateEl = shadow.querySelector(".state") as HTMLElement;
  const hintEl = shadow.querySelector(".hint-line") as HTMLElement;
  const closeBtn = shadow.querySelector(".close") as HTMLButtonElement;
  const countsEl = shadow.querySelector(".counts") as HTMLElement;
  const trackEl = shadow.querySelector(".track") as HTMLElement;
  const fillEl = shadow.querySelector(".fill") as HTMLElement;
  const popoverEl = shadow.querySelector(".popover") as HTMLElement;
  const peekEl = shadow.querySelector(".peek-tip") as HTMLElement;
  const areaBannerEl = shadow.querySelector(".area-banner") as HTMLElement;
  const areaRectEl = shadow.querySelector(".area-rect") as HTMLElement;

  function syncLabels() {
    const isEn = en();
    settingsBtn.textContent = isEn ? "Qingyi" : "轻译";
    settingsBtn.title = isEn
      ? "Click to open Settings; drag to reposition"
      : "点击打开设置；拖动记住位置";
    settingsBtn.setAttribute(
      "aria-label",
      isEn ? "Qingyi Settings, drag to reposition" : "轻译设置，拖动可调整位置",
    );
    closeBtn.setAttribute(
      "aria-label",
      isEn ? "Hide progress bar on this page" : "关闭本页进度条",
    );
    box.setAttribute("aria-label", isEn ? "Qingyi progress" : "轻译统计");
    trackEl.setAttribute(
      "aria-label",
      isEn ? "Translation progress" : "翻译进度",
    );
  }
  syncLabels();

  function ensureMounted() {
    const parentTarget =
      (document.fullscreenElement as HTMLElement | null) ||
      document.documentElement;
    if (!parentTarget) return;
    if (host.parentElement !== parentTarget) {
      parentTarget.append(host);
      try {
        if (typeof (host as any).showPopover === "function") {
          (host as any).showPopover();
        }
      } catch {
        // ignore if already open or unsupported
      }
    }
  }

  function clampPositionToViewport() {
    if (!position || drag) return;
    // Compensate if <html> has transform/filter creating a shifted containing block (Q-V2).
    let offsetLeft = 0;
    let offsetTop = 0;
    const docRect = document.documentElement?.getBoundingClientRect?.();
    if (docRect && !host.matches(":popover-open")) {
      const cs = getComputedStyle(document.documentElement);
      if (
        cs.transform !== "none" ||
        cs.filter !== "none" ||
        cs.perspective !== "none" ||
        cs.contain.includes("paint")
      ) {
        offsetLeft = docRect.left;
        offsetTop = docRect.top;
      }
    }
    const maxLeft = Math.max(7, innerWidth - boxWidth - 7);
    const maxTop = Math.max(7, innerHeight - boxHeight - 7);
    const left = Math.max(7, Math.min(maxLeft, position.x * innerWidth));
    const top = Math.max(7, Math.min(maxTop, position.y * innerHeight));
    box.style.right = "auto";
    box.style.bottom = "auto";
    box.style.left = `${left - offsetLeft}px`;
    box.style.top = `${top - offsetTop}px`;
  }

  function updateVisibility() {
    if (!initial.isTopFrame) {
      box.hidden = true;
      return;
    }
    ensureMounted();
    const shouldHide =
      !forceVisible && (closedForSession || progressVisible === false);
    box.hidden = shouldHide;
    if (!shouldHide) {
      const rect = box.getBoundingClientRect();
      if (rect.width > 0) boxWidth = rect.width;
      if (rect.height > 0) boxHeight = rect.height;
      clampPositionToViewport();
    }
  }

  closeBtn.addEventListener("click", () => {
    closedForSession = true;
    forceVisible = false;
    box.hidden = true;
  });

  let suppressClick = false;
  settingsBtn.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      return;
    }
    callbacks.onOpenSettings();
  });
  settingsBtn.addEventListener("keydown", () => {
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

  settingsBtn.addEventListener("pointerdown", (e) => {
    const p = e as PointerEvent;
    if (!p.isPrimary || p.button !== 0) return;
    const r = box.getBoundingClientRect();
    boxWidth = r.width || boxWidth;
    boxHeight = r.height || boxHeight;
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
        7,
        Math.min(innerWidth - boxWidth - 7, drag.left + p.clientX - drag.x),
      ) + "px";
    box.style.top =
      Math.max(
        7,
        Math.min(innerHeight - boxHeight - 7, drag.top + p.clientY - drag.y),
      ) + "px";
  });

  shadow.addEventListener("pointerup", (e) => {
    if (!drag || (e as PointerEvent).pointerId !== drag.pointer) return;
    const moved = drag.moved;
    drag = undefined;
    if (!moved) return;
    const r = box.getBoundingClientRect();
    position = {
      x: Math.max(0, Math.min(1, r.left / Math.max(1, innerWidth))),
      y: Math.max(0, Math.min(1, r.top / Math.max(1, innerHeight))),
    };
    callbacks.onSavePosition(position);
  });

  shadow.addEventListener("pointercancel", () => {
    drag = undefined;
    suppressClick = false;
    clampPositionToViewport();
  });

  function flushProgressRender() {
    rafId = 0;
    const snap = pendingSnapshot;
    if (!snap || !initial.isTopFrame) return;
    if (snap.forceShow || snap.tone === "error") {
      forceVisible = true;
    }
    stateEl.textContent = snap.statusText;
    stateEl.setAttribute("role", snap.tone === "error" ? "alert" : "status");
    if (snap.hintText) {
      hintEl.textContent = snap.hintText;
      hintEl.hidden = false;
    } else {
      hintEl.textContent = "";
      hintEl.hidden = true;
    }
    box.classList.toggle("error", snap.tone === "error");
    box.classList.toggle("warning", snap.tone === "warning");

    const isEn = en();
    countsEl.textContent = isEn
      ? `Translated ${snap.rendered} / Found ${snap.discovered} · Cache ${snap.hits} · Queue ${snap.queued} · Req ${snap.requests}${snap.failed ? ` · Failed ${snap.failed}` : ""}${snap.capped ? " · 10k limit" : ""}`
      : `已译 ${snap.rendered} / 已发现 ${snap.discovered} · 缓存 ${snap.hits} · 排队 ${snap.queued} · 请求 ${snap.requests}${snap.failed ? ` · 失败 ${snap.failed}` : ""}${snap.capped ? " · 已达万段上限" : ""}`;

    const pct = snap.discovered
      ? Math.min(100, Math.round((snap.rendered / snap.discovered) * 100))
      : 0;
    fillEl.style.transform = `scaleX(${pct / 100})`;
    trackEl.setAttribute("aria-valuenow", String(pct));
    updateVisibility();
  }

  function scheduleProgress(snapshot: ProgressSnapshot) {
    pendingSnapshot = snapshot;
    if (!initial.isTopFrame) return;
    if (!rafId) {
      rafId = requestAnimationFrame(flushProgressRender);
    }
  }

  // --- Selection Translation & Inline Revision Popover ---
  function positionPopoverNear(rect: DOMRect) {
    ensureMounted();
    popoverEl.hidden = false;
    const popRect = popoverEl.getBoundingClientRect();
    const w = popRect.width || 340;
    const h = popRect.height || 180;
    const left = Math.max(11, Math.min(innerWidth - w - 11, rect.left));
    const spaceBelow = innerHeight - rect.bottom;
    const top =
      spaceBelow >= h + 15 || rect.top < h + 15
        ? Math.min(innerHeight - h - 11, rect.bottom + 7)
        : Math.max(11, rect.top - h - 7);
    popoverEl.style.left = `${left}px`;
    popoverEl.style.top = `${top}px`;
  }

  function closePopover() {
    popoverEl.hidden = true;
    popoverEl.replaceChildren();
  }

  function showSelectionPopover(params: {
    rect: DOMRect;
    source: string;
    loading?: boolean;
    translation?: string;
    channel?: "local" | "cloud" | "cache";
    error?: string;
  }) {
    const isEn = en();
    popoverEl.replaceChildren();

    const head = document.createElement("div");
    head.className = "popover-head";
    const titleWrap = document.createElement("div");
    titleWrap.className = "popover-title";
    const titleText = document.createElement("span");
    titleText.textContent = isEn ? "Selection Translation" : "划词翻译";
    titleWrap.append(titleText);

    if (params.channel) {
      const pill = document.createElement("span");
      pill.className = `pill ${params.channel}`;
      pill.textContent =
        params.channel === "local"
          ? isEn
            ? "Local model"
            : "本地模型"
          : params.channel === "cache"
            ? isEn
              ? "Cache / Dict"
              : "缓存 / 词库"
            : isEn
              ? "Cloud API"
              : "云端服务";
      titleWrap.append(pill);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "×";
    close.setAttribute("aria-label", isEn ? "Close" : "关闭");
    close.onclick = closePopover;
    head.append(titleWrap, close);
    popoverEl.append(head);

    const body = document.createElement("div");
    body.className = params.error ? "popover-body error" : "popover-body";
    if (params.loading) {
      body.textContent = isEn ? "Translating…" : "正在翻译选中内容…";
    } else if (params.error) {
      body.setAttribute("role", "alert");
      body.textContent = params.error;
    } else {
      body.textContent = params.translation || "";
    }
    popoverEl.append(body);

    if (!params.loading && params.translation && !params.error) {
      const actions = document.createElement("div");
      actions.className = "popover-actions";
      const statusMsg = document.createElement("div");
      statusMsg.className = "popover-status";
      statusMsg.hidden = true;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn primary";
      copyBtn.textContent = isEn ? "Copy" : "复制译文";
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(params.translation!);
          statusMsg.textContent = isEn
            ? "Copied to clipboard."
            : "已复制译文。";
          statusMsg.hidden = false;
        } catch {
          statusMsg.textContent = isEn ? "Copy failed." : "复制失败。";
          statusMsg.hidden = false;
        }
      };

      const reviseBtn = document.createElement("button");
      reviseBtn.type = "button";
      reviseBtn.className = "btn";
      reviseBtn.textContent = isEn ? "Save as revision" : "存为修订";
      reviseBtn.onclick = () => {
        showRevisionEditor({
          rect: params.rect,
          source: params.source,
          initialTranslation: params.translation!,
        });
      };

      actions.append(copyBtn, reviseBtn);
      popoverEl.append(actions, statusMsg);
    }

    positionPopoverNear(params.rect);
  }

  function showRevisionEditor(params: {
    rect: DOMRect;
    source: string;
    initialTranslation: string;
    onSaved?: (newTranslation: string) => void;
  }) {
    const isEn = en();
    popoverEl.replaceChildren();

    const head = document.createElement("div");
    head.className = "popover-head";
    const title = document.createElement("div");
    title.className = "popover-title";
    title.textContent = isEn
      ? "Edit & Save Revision"
      : "修正译文并存为用户修订";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "×";
    close.onclick = closePopover;
    head.append(title, close);

    const srcBox = document.createElement("div");
    srcBox.className = "popover-source";
    srcBox.textContent = params.source;

    const editor = document.createElement("textarea");
    editor.value = params.initialTranslation;

    const statusMsg = document.createElement("div");
    statusMsg.className = "popover-status";
    statusMsg.hidden = true;

    const actions = document.createElement("div");
    actions.className = "popover-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn";
    cancelBtn.textContent = isEn ? "Cancel" : "取消";
    cancelBtn.onclick = closePopover;

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn primary";
    saveBtn.textContent = isEn ? "Save revision" : "保存修订";
    saveBtn.onclick = async () => {
      const nextVal = editor.value.trim();
      if (!nextVal) return;
      saveBtn.disabled = true;
      try {
        await callbacks.onSaveRevision({
          source: params.source,
          translation: nextVal,
        });
        params.onSaved?.(nextVal);
        closePopover();
      } catch (err) {
        saveBtn.disabled = false;
        statusMsg.hidden = false;
        statusMsg.textContent =
          err instanceof Error
            ? err.message
            : isEn
              ? "Save failed."
              : "保存失败。";
      }
    };

    actions.append(cancelBtn, saveBtn);
    popoverEl.append(head, srcBox, editor, actions, statusMsg);
    positionPopoverNear(params.rect);
    editor.focus();
  }

  // --- Hover Original Peek Tooltip ---
  function showPeek(text: string, x: number, y: number) {
    ensureMounted();
    peekEl.textContent = text;
    peekEl.hidden = false;
    const r = peekEl.getBoundingClientRect();
    const w = r.width || 240;
    const h = r.height || 40;
    peekEl.style.left = `${Math.max(11, Math.min(innerWidth - w - 11, x + 11))}px`;
    peekEl.style.top = `${Math.max(11, Math.min(innerHeight - h - 11, y + 15))}px`;
  }

  function hidePeek() {
    peekEl.hidden = true;
  }

  // --- Area Selection Mode ("框选区域翻译") ---
  let areaModeActive = false;
  let areaStart: { x: number; y: number } | null = null;

  function stopAreaSelection() {
    if (!areaModeActive) return;
    areaModeActive = false;
    areaStart = null;
    areaBannerEl.hidden = true;
    areaRectEl.hidden = true;
    document.documentElement.style.cursor = "";
    window.removeEventListener("pointerdown", onAreaDown, true);
    window.removeEventListener("pointermove", onAreaMove, true);
    window.removeEventListener("pointerup", onAreaUp, true);
  }

  function onAreaDown(e: PointerEvent) {
    if (!areaModeActive || e.button !== 0) return;
    if ((e.target as Element)?.closest?.("qingyi-overlay")) return;
    e.preventDefault();
    e.stopPropagation();
    areaStart = { x: e.clientX, y: e.clientY };
    areaRectEl.style.left = `${e.clientX}px`;
    areaRectEl.style.top = `${e.clientY}px`;
    areaRectEl.style.width = "0px";
    areaRectEl.style.height = "0px";
    areaRectEl.hidden = false;
  }

  function onAreaMove(e: PointerEvent) {
    if (!areaModeActive || !areaStart) return;
    const left = Math.min(areaStart.x, e.clientX);
    const top = Math.min(areaStart.y, e.clientY);
    const width = Math.abs(e.clientX - areaStart.x);
    const height = Math.abs(e.clientY - areaStart.y);
    areaRectEl.style.left = `${left}px`;
    areaRectEl.style.top = `${top}px`;
    areaRectEl.style.width = `${width}px`;
    areaRectEl.style.height = `${height}px`;
  }

  function onAreaUp(e: PointerEvent) {
    if (!areaModeActive || !areaStart) return;
    e.preventDefault();
    e.stopPropagation();
    const left = Math.min(areaStart.x, e.clientX);
    const top = Math.min(areaStart.y, e.clientY);
    const right = Math.max(areaStart.x, e.clientX);
    const bottom = Math.max(areaStart.y, e.clientY);
    stopAreaSelection();

    if (right - left < 8 && bottom - top < 8) {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      if (hit && hit !== document.body && hit !== document.documentElement) {
        callbacks.onAreaSelected([hit]);
      }
      return;
    }

    const picked: Element[] = [];
    const candidates = document.body.querySelectorAll(
      "p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dt,dd,figcaption,div,section,article",
    );
    for (const el of Array.from(candidates)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const intersects =
        r.right >= left &&
        r.left <= right &&
        r.bottom >= top &&
        r.top <= bottom;
      if (intersects) picked.push(el);
    }
    if (picked.length) callbacks.onAreaSelected(picked);
  }

  function startAreaSelection() {
    if (!initial.isTopFrame) return;
    ensureMounted();
    areaModeActive = true;
    areaBannerEl.textContent = en()
      ? "Drag a rectangle (or click a block) to translate only that area · Press Esc to cancel"
      : "拖动框选要翻译的区域（或直接点击段落块）· 按 Esc 取消";
    areaBannerEl.hidden = false;
    document.documentElement.style.cursor = "crosshair";
    window.addEventListener("pointerdown", onAreaDown, true);
    window.addEventListener("pointermove", onAreaMove, true);
    window.addEventListener("pointerup", onAreaUp, true);
  }

  // Global Esc & outside-click dismissal for popover / area mode, and always-in-viewport resize clamp (Q-46).
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (areaModeActive) {
        e.preventDefault();
        stopAreaSelection();
      } else if (!popoverEl.hidden) {
        closePopover();
      }
    }
  });

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (popoverEl.hidden) return;
      const path = e.composedPath();
      if (!path.includes(popoverEl)) {
        closePopover();
      }
    },
    true,
  );

  window.addEventListener("resize", () => {
    if (!box.hidden) clampPositionToViewport();
  });

  document.addEventListener("fullscreenchange", () => {
    if (!box.hidden || !popoverEl.hidden) ensureMounted();
  });

  return {
    host,
    setTheme(theme: string) {
      host.dataset.theme = theme || "system";
    },
    setLocale(nextLocale?: string) {
      lang = normalizeUiLang(nextLocale || navigator.language);
      syncLabels();
      if (pendingSnapshot) scheduleProgress(pendingSnapshot);
    },
    setProgressPreference(visible: boolean) {
      progressVisible = visible;
      updateVisibility();
    },
    resetSessionClose(userInitiated: boolean) {
      if (userInitiated) {
        closedForSession = false;
        forceVisible = false;
      }
      updateVisibility();
    },
    showProgressExplicitly() {
      closedForSession = false;
      forceVisible = true;
      updateVisibility();
      if (pendingSnapshot) flushProgressRender();
    },
    scheduleProgress,
    showSelectionPopover,
    showRevisionEditor,
    closePopover,
    showPeek,
    hidePeek,
    startAreaSelection,
    getLang: () => lang,
  };
}

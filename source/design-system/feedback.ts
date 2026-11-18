import { normalizeUiLang, resolveError, type UiLang } from "./errors";

export type FeedbackTone = "success" | "info" | "neutral" | "warning" | "error";

export interface FeedbackMessage {
  id?: number | string;
  scope?: string;
  tone: FeedbackTone;
  message: string;
  detail?: string;
  field?: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
  createdAt?: number;
}

export interface BannerObjectInput {
  tone: FeedbackTone;
  message: string;
  detail?: string;
  field?: string;
  autoHideMs?: number;
  autoDismissMs?: number;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
}

export interface ConfirmRequest {
  id: number;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  lang?: UiLang;
  resolve: (accepted: boolean) => void;
}

type Listener = () => void;

let nextMessageId = 1;
let nextConfirmId = 1;

class FeedbackStore {
  private banners = new Map<string, FeedbackMessage>();
  private bannerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private toasts: FeedbackMessage[] = [];
  private toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private busyObjects = new Map<string, Set<string>>();
  private confirmQueue: ConfirmRequest[] = [];
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify() {
    for (const listener of this.listeners) listener();
  }

  getBanner(scope: string): FeedbackMessage | undefined {
    return this.banners.get(scope);
  }

  getToasts(): readonly FeedbackMessage[] {
    return this.toasts;
  }

  clearBanner(scope: string) {
    const timer = this.bannerTimers.get(scope);
    if (timer) {
      clearTimeout(timer);
      this.bannerTimers.delete(scope);
    }
    if (this.banners.delete(scope)) this.notify();
  }

  setBanner(scope: string, input: BannerObjectInput): FeedbackMessage;
  setBanner(
    scope: string,
    tone: FeedbackTone,
    message: string,
    options?: {
      detail?: string;
      field?: string;
      autoHideMs?: number;
      autoDismissMs?: number;
      actionLabel?: string;
      actionHref?: string;
      onAction?: () => void;
    },
  ): FeedbackMessage;
  setBanner(
    scope: string,
    toneOrInput: FeedbackTone | BannerObjectInput,
    maybeMessage?: string,
    options: {
      detail?: string;
      field?: string;
      autoHideMs?: number;
      autoDismissMs?: number;
      actionLabel?: string;
      actionHref?: string;
      onAction?: () => void;
    } = {},
  ): FeedbackMessage {
    const tone: FeedbackTone =
      typeof toneOrInput === "string" ? toneOrInput : toneOrInput.tone;
    const message: string =
      typeof toneOrInput === "string"
        ? maybeMessage || ""
        : toneOrInput.message;
    const opts = typeof toneOrInput === "string" ? options : toneOrInput;
    const existingTimer = this.bannerTimers.get(scope);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.bannerTimers.delete(scope);
    }
    const item: FeedbackMessage = {
      id: nextMessageId++,
      scope,
      tone,
      message,
      detail: opts.detail,
      field: opts.field,
      actionLabel: opts.actionLabel,
      actionHref: opts.actionHref,
      onAction: opts.onAction,
      createdAt: Date.now(),
    };
    this.banners.set(scope, item);

    const autoHide =
      opts.autoHideMs ??
      opts.autoDismissMs ??
      (tone === "success" || tone === "info" ? 5000 : 0);
    if (autoHide > 0) {
      this.bannerTimers.set(
        scope,
        setTimeout(() => {
          if (this.banners.get(scope)?.id === item.id) {
            this.banners.delete(scope);
            this.bannerTimers.delete(scope);
            this.notify();
          }
        }, autoHide),
      );
    }
    this.notify();
    return item;
  }

  reportError(
    scope: string,
    err: unknown,
    langInput?: string | null,
    extra?: {
      actionLabel?: string;
      actionHref?: string;
      onAction?: () => void;
    },
  ) {
    const resolved = resolveError(err, langInput);
    if (resolved.isCancelled) {
      return this.setBanner(scope, "neutral", resolved.message, {
        autoHideMs: 5000,
      });
    }
    const detail =
      resolved.raw && resolved.raw !== resolved.message
        ? resolved.raw
        : resolved.code &&
            resolved.code !== "UNKNOWN_ERROR" &&
            !resolved.message.includes(resolved.code)
          ? resolved.code
          : undefined;
    return this.setBanner(scope, "error", resolved.message, {
      detail,
      field: resolved.field,
      ...extra,
    });
  }

  pushToast(
    message: string,
    tone: FeedbackTone = "success",
    durationMs = 4500,
  ): FeedbackMessage {
    const item: FeedbackMessage = {
      id: nextMessageId++,
      scope: "toast",
      tone,
      message,
      createdAt: Date.now(),
    };
    this.toasts = [...this.toasts.slice(-3), item];
    if (durationMs > 0 && tone !== "error") {
      const toastId = item.id as number;
      this.toastTimers.set(
        toastId,
        setTimeout(() => {
          this.dismissToast(toastId);
        }, durationMs),
      );
    }
    this.notify();
    return item;
  }

  dismissToast(id: number) {
    const timer = this.toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.toastTimers.delete(id);
    }
    const before = this.toasts.length;
    this.toasts = this.toasts.filter((t) => t.id !== id);
    if (this.toasts.length !== before) this.notify();
  }

  // --- Object-level & Action-level Busy Tracking ---
  startBusy(objectKey: string, actionKey = "default") {
    let set = this.busyObjects.get(objectKey);
    if (!set) {
      set = new Set();
      this.busyObjects.set(objectKey, set);
    }
    set.add(actionKey);
    this.notify();
  }

  endBusy(objectKey: string, actionKey = "default") {
    const set = this.busyObjects.get(objectKey);
    if (!set) return;
    set.delete(actionKey);
    if (!set.size) this.busyObjects.delete(objectKey);
    this.notify();
  }

  isBusy(objectKey: string, actionKey?: string): boolean {
    const set = this.busyObjects.get(objectKey);
    if (!set || !set.size) return false;
    return actionKey ? set.has(actionKey) : true;
  }

  async runTracked<T>(
    options: {
      objectKey: string;
      actionKey?: string;
      scope?: string;
      lang?: string | null;
      inProgressMessage?: string;
      successMessage?: string | ((result: T) => string | undefined);
      toastOnSuccess?: boolean;
    },
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const actionKey = options.actionKey || "default";
    if (this.isBusy(options.objectKey)) return undefined;
    this.startBusy(options.objectKey, actionKey);
    if (options.scope && options.inProgressMessage) {
      this.setBanner(options.scope, "neutral", options.inProgressMessage, {
        autoHideMs: 0,
      });
    } else if (options.scope) {
      // Clear stale error before starting fresh operation
      const current = this.getBanner(options.scope);
      if (current?.tone === "error") this.clearBanner(options.scope);
    }
    try {
      const result = await fn();
      const msg =
        typeof options.successMessage === "function"
          ? options.successMessage(result)
          : options.successMessage;
      if (msg) {
        if (options.scope) {
          this.setBanner(options.scope, "success", msg);
        }
        if (options.toastOnSuccess) {
          this.pushToast(msg, "success");
        }
      }
      return result;
    } catch (err) {
      if (options.scope) {
        this.reportError(options.scope, err, options.lang);
      } else {
        const resolved = resolveError(err, options.lang);
        this.pushToast(
          resolved.message,
          resolved.isCancelled ? "neutral" : "error",
        );
      }
      return undefined;
    } finally {
      this.endBusy(options.objectKey, actionKey);
    }
  }

  // --- FIFO Confirmation Queue (never silently rejects concurrent requests) ---
  getActiveConfirm(): ConfirmRequest | undefined {
    return this.confirmQueue[0];
  }

  getConfirmQueueLength(): number {
    return this.confirmQueue.length;
  }

  enqueueConfirm(options: {
    message: string;
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    lang?: string | null;
  }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.confirmQueue = [
        ...this.confirmQueue,
        {
          id: nextConfirmId++,
          title: options.title,
          message: options.message,
          confirmLabel: options.confirmLabel,
          cancelLabel: options.cancelLabel,
          danger: options.danger,
          lang: normalizeUiLang(options.lang),
          resolve,
        },
      ];
      this.notify();
    });
  }

  resolveActiveConfirm(accepted: boolean) {
    const active = this.confirmQueue[0];
    if (!active) return;
    this.confirmQueue = this.confirmQueue.slice(1);
    this.notify();
    active.resolve(accepted);
  }
}

export const feedbackStore = new FeedbackStore();

export interface RunTrackedOptions<T> {
  key?: string;
  objectKey?: string;
  actionKey?: string;
  scope?: string;
  lang?: string | null;
  inProgressMessage?: string;
  successMessage?: string | ((result: T) => string | undefined);
  toastOnSuccess?: boolean;
}

export function runTracked<T>(
  options: RunTrackedOptions<T>,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return feedbackStore.runTracked(
    {
      ...options,
      objectKey: options.objectKey || options.key || "default",
    },
    fn,
  );
}

export interface ConfirmActionOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  lang?: string | null;
}

export function confirmAction(options: ConfirmActionOptions): Promise<boolean>;
export function confirmAction(
  message: string,
  title?: string,
  confirmLabel?: string,
  options?: { cancelLabel?: string; danger?: boolean; lang?: string | null },
): Promise<boolean>;
export function confirmAction(
  messageOrOptions: string | ConfirmActionOptions,
  title?: string,
  confirmLabel?: string,
  options?: { cancelLabel?: string; danger?: boolean; lang?: string | null },
): Promise<boolean> {
  if (typeof messageOrOptions === "object") {
    return feedbackStore.enqueueConfirm({
      ...messageOrOptions,
      lang:
        messageOrOptions.lang ??
        (typeof document !== "undefined"
          ? document.documentElement.lang
          : "zh-CN"),
    });
  }
  return feedbackStore.enqueueConfirm({
    message: messageOrOptions,
    title,
    confirmLabel,
    cancelLabel: options?.cancelLabel,
    danger: options?.danger,
    lang:
      options?.lang ??
      (typeof document !== "undefined"
        ? document.documentElement.lang
        : "zh-CN"),
  });
}

export function toast(
  message: string,
  tone: FeedbackTone = "success",
  durationMs = 4500,
) {
  return feedbackStore.pushToast(message, tone, durationMs);
}

export function applyTheme(theme?: string | null) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme =
    theme === "light" || theme === "dark" ? theme : "system";
}

// Monotonic sequence + AbortController gate so stale async responses never overwrite newer state.
export interface RequestTicket {
  readonly seq: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export function createRequestGate() {
  let seq = 0;
  let controller: AbortController | undefined;
  return {
    next(abortPrevious = true): RequestTicket {
      if (abortPrevious) controller?.abort();
      const currentSeq = ++seq;
      const currentController = new AbortController();
      controller = currentController;
      return {
        seq: currentSeq,
        signal: currentController.signal,
        isCurrent: () =>
          currentSeq === seq && !currentController.signal.aborted,
      };
    },
    abort() {
      seq++;
      controller?.abort();
      controller = undefined;
    },
    get currentSeq() {
      return seq;
    },
  };
}

import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { normalizeUiLang, type UiLang } from "./errors";
import {
  feedbackStore,
  toast,
  type FeedbackMessage,
  type FeedbackTone,
} from "./feedback";

export function useFeedbackStore() {
  const [, setTick] = useState(0);
  useEffect(() => feedbackStore.subscribe(() => setTick((t) => t + 1)), []);
  return feedbackStore;
}

export interface ButtonProps
  extends Omit<JSX.IntrinsicElements["button"], "loading"> {
  variant?: "secondary" | "primary" | "danger" | "ghost";
  busy?: boolean;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  children?: ComponentChildren;
}

export function Button({
  variant = "secondary",
  busy = false,
  disabled = false,
  type = "button",
  class: className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    variant !== "secondary" ? variant : "",
    typeof className === "string" ? className : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      class={classes || undefined}
      disabled={disabled || busy}
      aria-busy={busy ? "true" : undefined}
    >
      {children}
    </button>
  );
}

export interface FieldProps {
  label: ComponentChildren;
  hint?: ComponentChildren;
  error?: string;
  class?: string;
  children: ComponentChildren;
}

export function Field({
  label,
  hint,
  error,
  class: className,
  children,
}: FieldProps) {
  return (
    <label class={["field", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      {children}
      {error ? (
        <span class="field-error" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span class="field-hint">{hint}</span>
      ) : null}
    </label>
  );
}

export type TextInputProps = {
  id?: string;
  name?: string;
  type?: "text" | "password" | "url" | "search" | "number" | "email" | "file";
  value?: string | number;
  placeholder?: string;
  autocomplete?: string;
  inputMode?: string;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  list?: string;
  accept?: string;
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  class?: string;
  "aria-label"?: string;
  "data-transient"?: boolean;
  label?: ComponentChildren;
  hint?: ComponentChildren;
  error?: string;
  onValueInput?: (value: string, event: Event) => void;
  onChange?: (event: Event) => void;
};

export function TextInput({
  label,
  hint,
  error,
  onValueInput,
  ...rest
}: TextInputProps) {
  const control = (
    <input
      {...(rest as Record<string, unknown>)}
      aria-invalid={error ? "true" : undefined}
      onInput={(e) => {
        onValueInput?.((e.currentTarget as HTMLInputElement).value, e);
      }}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error}>
      {control}
    </Field>
  );
}

export interface TextareaProps
  extends Omit<JSX.IntrinsicElements["textarea"], "onInput"> {
  label?: ComponentChildren;
  hint?: ComponentChildren;
  error?: string;
  onValueInput?: (value: string, event: Event) => void;
}

export function Textarea({
  label,
  hint,
  error,
  onValueInput,
  ...rest
}: TextareaProps) {
  const control = (
    <textarea
      {...rest}
      aria-invalid={error ? "true" : undefined}
      onInput={(e) => {
        onValueInput?.((e.currentTarget as HTMLTextAreaElement).value, e);
      }}
    />
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error}>
      {control}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectProps = {
  id?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  required?: boolean;
  class?: string;
  "aria-label"?: string;
  "data-transient"?: boolean;
  label?: ComponentChildren;
  hint?: ComponentChildren;
  error?: string;
  options: SelectOption[];
  onValueChange?: (value: string, event: Event) => void;
};

export function Select({
  label,
  hint,
  error,
  options,
  value,
  onValueChange,
  ...rest
}: SelectProps) {
  const control = (
    <select
      {...rest}
      value={value}
      aria-invalid={error ? "true" : undefined}
      onChange={(e) => {
        onValueChange?.((e.currentTarget as HTMLSelectElement).value, e);
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value} disabled={opt.disabled}>
          {opt.label}
        </option>
      ))}
    </select>
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error}>
      {control}
    </Field>
  );
}

export interface SelectFieldProps {
  id?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  required?: boolean;
  class?: string;
  "aria-label"?: string;
  label?: ComponentChildren;
  hint?: ComponentChildren;
  error?: string;
  children?: ComponentChildren;
  onValueChange?: (value: string, event: Event) => void;
}

export function SelectField({
  label,
  hint,
  error,
  value,
  children,
  onValueChange,
  ...rest
}: SelectFieldProps) {
  const control = (
    <select
      {...rest}
      value={value}
      aria-invalid={error ? "true" : undefined}
      onChange={(e) => {
        onValueChange?.((e.currentTarget as HTMLSelectElement).value, e);
      }}
    >
      {children}
    </select>
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error}>
      {control}
    </Field>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ComponentChildren;
  hint?: ComponentChildren;
  disabled?: boolean;
  id?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  id,
}: SwitchProps) {
  return (
    <div class="field">
      <div class="switch-row">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked ? "true" : "false"}
          disabled={disabled}
          class="switch-control"
          onClick={() => !disabled && onChange(!checked)}
        >
          <span class="switch-thumb" />
        </button>
        <span
          onClick={() => !disabled && onChange(!checked)}
          style={{ cursor: disabled ? "not-allowed" : "pointer" }}
        >
          {label}
        </span>
      </div>
      {hint ? <span class="field-hint">{hint}</span> : null}
    </div>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ComponentChildren;
  hint?: ComponentChildren;
  disabled?: boolean;
  id?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  id,
}: CheckboxProps) {
  return (
    <div class="field">
      <label class="check" style={{ margin: 0 }}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) =>
            onChange((e.currentTarget as HTMLInputElement).checked)
          }
        />
        <span>{label}</span>
      </label>
      {hint ? <span class="field-hint">{hint}</span> : null}
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  title: string;
  onClose?: () => void;
  children: ComponentChildren;
  labelledById?: string;
}

// Positioned inside .modal-backdrop so Windows frameless titlebar (z-index: 10000)
// always stays uncovered and interactive above every modal.
export function Dialog({
  open,
  title,
  onClose,
  children,
  labelledById = "modal-heading",
}: DialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const firstFocusable = cardRef.current?.querySelector<HTMLElement>(
      'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    firstFocusable?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus.current?.isConnected) {
        previousFocus.current.focus();
      }
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      class="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <div
        ref={cardRef}
        class="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledById}
      >
        <h2 id={labelledById}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmHost({ lang }: { lang?: string | null }) {
  const store = useFeedbackStore();
  const active = store.getActiveConfirm();
  const queueLen = store.getConfirmQueueLength();
  if (!active) return null;

  const uiLang: UiLang = normalizeUiLang(lang ?? active.lang);
  const en = uiLang === "en";
  const title = active.title || (en ? "Confirm action" : "确认操作");
  const cancelText = active.cancelLabel || (en ? "Cancel" : "取消");
  const confirmText = active.confirmLabel || (en ? "Continue" : "继续");

  return (
    <Dialog
      open={true}
      title={title}
      labelledById={`confirm-title-${active.id}`}
      onClose={() => store.resolveActiveConfirm(false)}
    >
      <p>{active.message}</p>
      {queueLen > 1 ? (
        <p class="hint">
          {en
            ? `1 of ${queueLen} pending confirmations`
            : `当前第 1 / ${queueLen} 项待确认操作`}
        </p>
      ) : null}
      <div class="actions">
        <Button onClick={() => store.resolveActiveConfirm(false)}>
          {cancelText}
        </Button>
        <Button
          variant={active.danger ? "danger" : "primary"}
          onClick={() => store.resolveActiveConfirm(true)}
        >
          {confirmText}
        </Button>
      </div>
    </Dialog>
  );
}

export function FeedbackBanner({
  scope,
  message: directMessage,
  lang,
}: {
  scope?: string;
  message?: FeedbackMessage | null;
  lang?: string | null;
}) {
  const store = useFeedbackStore();
  const item = directMessage ?? (scope ? store.getBanner(scope) : undefined);
  if (!item || !item.message) return null;

  const en = normalizeUiLang(lang) === "en";
  const isError = item.tone === "error";

  return (
    <div
      class="feedback-banner"
      data-tone={item.tone}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
    >
      <div>
        <span>{item.message}</span>
        {item.actionLabel && item.actionHref ? (
          <>
            {" "}
            <a href={item.actionHref} target="_blank" rel="noreferrer">
              {item.actionLabel}
            </a>
          </>
        ) : null}
        {item.actionLabel && item.onAction ? (
          <>
            {" "}
            <Button variant="ghost" onClick={item.onAction}>
              {item.actionLabel}
            </Button>
          </>
        ) : null}
      </div>
      {item.detail ? (
        <details>
          <summary>{en ? "Technical details" : "展开原始原因"}</summary>
          <pre>{item.detail}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function ToastViewport() {
  const store = useFeedbackStore();
  const toasts = store.getToasts();
  if (!toasts.length) return null;

  return (
    <div class="toast-stack" aria-live="polite">
      {toasts.map((item) => (
        <div
          key={item.id}
          class="toast"
          data-tone={item.tone}
          role={item.tone === "error" ? "alert" : "status"}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}

export interface VerdictMetric {
  label: string;
  value: ComponentChildren;
}

export function VerdictHero({
  eyebrow,
  title,
  description,
  tone = "neutral",
  badge,
  metrics,
  actions,
}: {
  eyebrow?: string;
  title: ComponentChildren;
  description?: ComponentChildren;
  tone?: FeedbackTone;
  badge?: ComponentChildren;
  metrics?: VerdictMetric[];
  actions?: ComponentChildren;
}) {
  return (
    <section class="verdict-hero" data-tone={tone}>
      <div class="split-head">
        <div>
          {eyebrow ? <p class="eyebrow">{eyebrow}</p> : null}
          <div class="verdict-title">{title}</div>
        </div>
        {badge ? <div>{badge}</div> : null}
      </div>
      {description ? <p class="muted">{description}</p> : null}
      {actions ? <div class="actions">{actions}</div> : null}
      {metrics && metrics.length > 0 ? (
        <div class="verdict-meta">
          {metrics.map((m, idx) => (
            <div key={idx} class="verdict-metric">
              <span>{m.label}</span>
              <strong>{m.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export type StateBlockKind =
  | "loading"
  | "empty"
  | "failed"
  | "unknown"
  | "unauthorized";

export function StateBlock({
  kind,
  title,
  message,
  detail,
  retryLabel,
  onRetry,
  action,
  lang,
}: {
  kind: StateBlockKind;
  title?: string;
  message: ComponentChildren;
  detail?: string;
  retryLabel?: string;
  onRetry?: () => void;
  action?: ComponentChildren;
  lang?: string | null;
}) {
  const en = normalizeUiLang(lang) === "en";
  return (
    <div
      class="state-block"
      data-state={kind}
      role={kind === "failed" ? "alert" : "status"}
    >
      {title ? <h3>{title}</h3> : null}
      <p>{message}</p>
      {detail ? (
        <details>
          <summary>{en ? "Technical details" : "展开原始原因"}</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
      {onRetry || action ? (
        <div class="actions">
          {onRetry ? (
            <Button variant="primary" onClick={onRetry}>
              {retryLabel || (en ? "Retry" : "重试")}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}

export function Disclosure({
  summary,
  defaultOpen = false,
  open: controlledOpen,
  onToggleOpen,
  children,
}: {
  summary: ComponentChildren;
  defaultOpen?: boolean;
  open?: boolean;
  onToggleOpen?: (open: boolean) => void;
  children: ComponentChildren;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = controlledOpen ?? uncontrolledOpen;

  return (
    <details
      open={isOpen}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (controlledOpen === undefined) setUncontrolledOpen(next);
        onToggleOpen?.(next);
      }}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

export function DataList<T>({
  items,
  getKey,
  renderItem,
  emptyMessage,
  lang,
}: {
  items: readonly T[];
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ComponentChildren;
  emptyMessage: string;
  lang?: string | null;
}) {
  if (!items.length) {
    return <StateBlock kind="empty" message={emptyMessage} lang={lang} />;
  }
  return (
    <div class="rows">
      {items.map((item, index) => (
        <div key={getKey(item, index)} class="list-row">
          {renderItem(item, index)}
        </div>
      ))}
    </div>
  );
}

export function CopyField({
  label,
  value,
  masked = false,
  copyValue,
  copyLabel,
  copiedMessage,
  lang,
}: {
  label: string;
  value: string;
  masked?: boolean;
  copyValue?: string;
  copyLabel?: string;
  copiedMessage?: string;
  lang?: string | null;
}) {
  const en = normalizeUiLang(lang) === "en";
  const actualCopy = copyValue ?? value;
  const display =
    masked && value ? "••••••••••••••••" : value || (en ? "Unknown" : "未知");

  return (
    <div class="copy-box">
      <div class="copy-box-body">
        <span class="copy-box-label">{label}</span>
        <code>{display}</code>
      </div>
      <Button
        disabled={!actualCopy}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(actualCopy);
            toast(
              copiedMessage || (en ? `${label} copied.` : `已复制 ${label}。`),
              "success",
            );
          } catch {
            toast(
              en ? "Clipboard access failed." : "复制失败，请手动选中复制。",
              "error",
            );
          }
        }}
      >
        {copyLabel || (en ? "Copy" : "复制")}
      </Button>
    </div>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: FeedbackTone;
  children: ComponentChildren;
}) {
  return (
    <span class="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export const ConfirmModal = ConfirmHost;
export const ToastHost = ToastViewport;

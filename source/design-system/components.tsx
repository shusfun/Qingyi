import { createContext, type ComponentChildren, type JSX } from "preact";
import { useContext, useEffect, useId, useRef, useState } from "preact/hooks";
import { normalizeUiLang, type UiLang } from "./errors";
import {
  feedbackStore,
  toast,
  type FeedbackMessage,
  type FeedbackTone,
} from "./feedback";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconMinus,
  IconPlus,
  IconClose,
  IconUpload,
  IconSpinner,
} from "./icons";

export function useFeedbackStore() {
  const [, setTick] = useState(0);
  useEffect(() => feedbackStore.subscribe(() => setTick((t) => t + 1)), []);
  return feedbackStore;
}

export interface ButtonProps
  extends Omit<JSX.IntrinsicElements["button"], "loading" | "icon"> {
  variant?: "secondary" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  icon?: ComponentChildren;
  busy?: boolean;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  children?: ComponentChildren;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  busy = false,
  disabled = false,
  type = "button",
  class: className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    variant !== "secondary" ? variant : "",
    size === "sm" ? "sm" : "",
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
      {busy ? <IconSpinner size={14} /> : icon ? icon : null}
      {children}
    </button>
  );
}

export function CopyButton({
  text,
  label,
  copiedLabel,
  variant = "secondary",
  size = "md",
  disabled = false,
  lang,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  variant?: "secondary" | "primary" | "ghost";
  size?: "sm" | "md";
  disabled?: boolean;
  lang?: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const en = normalizeUiLang(lang) === "en";

  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled || !text}
      icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          toast(en ? "Copy failed." : "复制失败。", "error");
        }
      }}
    >
      {copied
        ? copiedLabel || (en ? "Copied" : "已复制")
        : label || (en ? "Copy" : "复制")}
    </Button>
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
      <span class="field-label-text">{label}</span>
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

export function NumberStepper({
  label,
  name,
  en,
  unit,
  min,
  max,
  step = 1,
  value,
  disabled,
  error,
  onValueInput,
}: {
  label?: string;
  name?: string;
  en: boolean;
  unit?: string;
  min: number;
  max?: number;
  step?: number;
  value: number | string;
  disabled?: boolean;
  error?: string;
  onValueInput: (raw: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const shown = editing ?? String(value);
  const adjust = (direction: number) => {
    const field = input.current;
    if (!field) return;
    if (direction > 0) field.stepUp();
    else field.stepDown();
    setEditing(null);
    onValueInput(field.value);
  };
  const title = label ?? name;
  return (
    <div class={label ? "field" : "ds-number-field"}>
      {label && <label for={id}>{label}</label>}
      <div class="ds-stepper">
        <button
          type="button"
          class="ds-tool"
          title={en ? `Decrease ${title}` : `减小${title}`}
          disabled={disabled || (shown !== "" && Number(shown) <= min)}
          onClick={() => adjust(-1)}
        >
          <IconMinus size={14} />
        </button>
        <input
          ref={input}
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={shown}
          disabled={disabled}
          aria-label={name}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onInput={(event) => {
            const raw = event.currentTarget.value;
            setEditing(raw);
            onValueInput(raw);
          }}
          onBlur={() => setEditing(null)}
        />
        {unit && <span class="ds-unit">{unit}</span>}
        <button
          type="button"
          class="ds-tool"
          title={en ? `Increase ${title}` : `增大${title}`}
          disabled={
            disabled ||
            (shown !== "" && max !== undefined && Number(shown) >= max)
          }
          onClick={() => adjust(1)}
        >
          <IconPlus size={14} />
        </button>
      </div>
      {error && (
        <span id={`${id}-error`} class="field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  disabled,
  onValueInput,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onValueInput: (value: number) => void;
}) {
  const id = useId();
  const formatted = unit ? `${value} ${unit}` : String(value);
  return (
    <div class="field ds-slider">
      <div class="ds-slider-caption">
        <label for={id}>{label}</label>
        <span aria-hidden="true">{formatted}</span>
      </div>
      <input
        id={id}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-valuetext={formatted}
        style={{ "--progress": `${(100 * (value - min)) / (max - min)}%` }}
        onInput={(event) => onValueInput(event.currentTarget.valueAsNumber)}
      />
    </div>
  );
}

export function FilePickerButton({
  file,
  onSelect,
  accept,
  disabled,
  label,
  en,
}: {
  file: File | null;
  onSelect: (file: File | null) => void;
  accept: string;
  disabled?: boolean;
  label: string;
  en: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div class="field">
      <span>{label}</span>
      <div class="ds-picker">
        <input
          hidden
          ref={input}
          type="file"
          accept={accept}
          disabled={disabled}
          onChange={(event) => {
            const selected = event.currentTarget.files?.[0];
            if (selected) onSelect(selected);
            event.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          ref={trigger}
          disabled={disabled}
          aria-label={label}
          onClick={() => input.current?.click()}
        >
          <IconUpload size={15} />
          {en ? "Choose file" : "选择文件"}
        </button>
        {file && (
          <span class="ds-file-badge">
            <span title={file.name}>{file.name}</span>
            <button
              class="ds-tool"
              type="button"
              disabled={disabled}
              title={en ? "Clear selected file" : "清除所选文件"}
              onClick={() => {
                onSelect(null);
                trigger.current?.focus();
              }}
            >
              <IconClose size={14} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

export function SearchInput({
  value,
  onValueInput,
  placeholder,
  en,
}: {
  value: string;
  onValueInput: (value: string) => void;
  placeholder: string;
  en: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="ds-search">
      <input
        type="search"
        ref={input}
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onInput={(event) => onValueInput(event.currentTarget.value)}
      />
      {value && (
        <button
          class="ds-tool"
          type="button"
          title={en ? "Clear search" : "清空搜索"}
          onClick={() => {
            onValueInput("");
            input.current?.focus();
          }}
        >
          <IconClose size={14} />
        </button>
      )}
    </div>
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
    <span class="ds-select-wrap">
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
      <IconChevronDown size={14} class="ds-select-arrow" />
    </span>
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
    <span class="ds-select-wrap">
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
      <IconChevronDown size={14} class="ds-select-arrow" />
    </span>
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error}>
      {control}
    </Field>
  );
}

const RowLabel = createContext<string | undefined>(undefined);

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ComponentChildren;
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
  const ownId = useId();
  const rowLabelId = useContext(RowLabel);
  const controlId = id ?? ownId;
  const toggleBtn = (
    <button
      id={controlId}
      aria-labelledby={label ? `${ownId}-label` : rowLabelId}
      type="button"
      role="switch"
      aria-checked={checked ? "true" : "false"}
      disabled={disabled}
      class="switch-control"
      onClick={() => !disabled && onChange(!checked)}
    >
      <span class="switch-thumb" />
    </button>
  );

  if (!label) return toggleBtn;

  return (
    <div class="switch-line">
      <label
        class="switch-line-text"
        for={controlId}
        style={{ cursor: disabled ? "not-allowed" : "pointer" }}
      >
        <span id={`${ownId}-label`} class="switch-line-title">
          {label}
        </span>
        {hint ? <span class="field-hint">{hint}</span> : null}
      </label>
      {toggleBtn}
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
    <div style={{ margin: "6px 0" }}>
      <label class="check">
        <span class="ds-check-box">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) =>
              onChange((e.currentTarget as HTMLInputElement).checked)
            }
          />
          <IconCheck size={13} />
        </span>
        <span>{label}</span>
      </label>
      {hint ? <span class="field-hint">{hint}</span> : null}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ComponentChildren; disabled?: boolean }[];
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div class="ds-segmented" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={opt.disabled}
          aria-pressed={value === opt.value ? "true" : "false"}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function SettingGroup({
  title,
  description,
  actions,
  padded = false,
  children,
}: {
  title?: ComponentChildren;
  description?: ComponentChildren;
  actions?: ComponentChildren;
  padded?: boolean;
  children: ComponentChildren;
}) {
  const titleId = useId();
  return (
    <section
      class="setting-group"
      aria-labelledby={title ? titleId : undefined}
    >
      {title || actions ? (
        <div class="setting-group-head">
          <div>
            {title ? (
              <h2 id={titleId} class="setting-group-title">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p class="setting-group-desc">{description}</p>
            ) : null}
          </div>
          {actions ? (
            <div class="actions" style={{ margin: 0 }}>
              {actions}
            </div>
          ) : null}
        </div>
      ) : null}
      <div class={padded ? "setting-card setting-card-body" : "setting-card"}>
        {children}
      </div>
    </section>
  );
}

export function SettingRow({
  title,
  description,
  error,
  controlWidth,
  vertical = false,
  children,
}: {
  title: ComponentChildren;
  description?: ComponentChildren;
  error?: string;
  controlWidth?: "narrow" | "medium" | "wide";
  vertical?: boolean;
  children: ComponentChildren;
}) {
  const labelId = useId();
  return (
    <div class={vertical ? "setting-row vertical" : "setting-row"}>
      <div class="setting-row-info">
        <div id={labelId} class="setting-row-title">
          {title}
        </div>
        {description ? <div class="setting-row-desc">{description}</div> : null}
        {error ? (
          <span class="field-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
      <div
        class={["setting-row-control", controlWidth || ""]
          .filter(Boolean)
          .join(" ")}
      >
        <RowLabel.Provider value={labelId}>{children}</RowLabel.Provider>
      </div>
    </div>
  );
}

export function MetricGrid({
  items,
}: {
  items: { label: string; value: ComponentChildren }[];
}) {
  return (
    <div class="metric-grid">
      {items.map((item, idx) => (
        <div key={idx} class="metric-card">
          <span class="metric-card-label">{item.label}</span>
          <strong class="metric-card-value">{item.value}</strong>
        </div>
      ))}
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
      <p style={{ color: "var(--color-muted)", fontSize: "var(--font-sm)" }}>
        {active.message}
      </p>
      {queueLen > 1 ? (
        <p class="hint">
          {en
            ? `1 of ${queueLen} pending confirmations`
            : `当前第 1 / ${queueLen} 项待确认操作`}
        </p>
      ) : null}
      <div
        class="actions"
        style={{
          justifyContent: "flex-end",
          marginTop: "16px",
          marginBottom: 0,
        }}
      >
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
            <Button variant="ghost" size="sm" onClick={item.onAction}>
              {item.actionLabel}
            </Button>
          </>
        ) : null}
      </div>
      {item.detail ? (
        <details style={{ marginTop: "8px" }}>
          <summary>
            <span>{en ? "Technical details" : "展开原始原因"}</span>
            <IconChevronRight size={14} class="ds-chevron" />
          </summary>
          <div class="ds-disclosure-body">
            <pre>{item.detail}</pre>
          </div>
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <div class="verdict-title">{title}</div>
          {badge ? badge : null}
        </div>
        {actions ? (
          <div class="actions" style={{ margin: 0 }}>
            {actions}
          </div>
        ) : null}
      </div>
      {description ? (
        <p class="muted" style={{ margin: "4px 0 0" }}>
          {description}
        </p>
      ) : null}
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
      <p style={{ margin: 0 }}>{message}</p>
      {detail ? (
        <details style={{ marginTop: "10px", textAlign: "left" }}>
          <summary>
            <span>{en ? "Technical details" : "展开原始原因"}</span>
            <IconChevronRight size={14} class="ds-chevron" />
          </summary>
          <div class="ds-disclosure-body">
            <pre>{detail}</pre>
          </div>
        </details>
      ) : null}
      {onRetry || action ? (
        <div class="actions" style={{ marginTop: "12px", marginBottom: 0 }}>
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
      class="ds-disclosure"
      open={isOpen}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (controlledOpen === undefined) setUncontrolledOpen(next);
        onToggleOpen?.(next);
      }}
    >
      <summary>
        <span>{summary}</span>
        <IconChevronRight size={15} class="ds-chevron" />
      </summary>
      <div class="ds-disclosure-body">{children}</div>
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
      <CopyButton
        text={actualCopy}
        label={copyLabel || (en ? "Copy" : "复制")}
        copiedLabel={copiedMessage ? (en ? "Copied" : "已复制") : undefined}
        size="sm"
        lang={lang}
      />
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

/** Shared controls: button, confirmation, status, details, records, toast and draft protection. */
export function button(label, action, kind = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.className = kind;
  if (action) node.addEventListener("click", action);
  return node;
}
export function details(label, value) {
  const node = document.createElement("details"),
    summary = document.createElement("summary"),
    body = document.createElement("pre");
  summary.textContent = label;
  body.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  node.append(summary, body);
  return node;
}
export function status(node, message, tone = "neutral") {
  node.textContent = message;
  node.dataset.tone = tone;
  node.setAttribute("role", tone === "error" ? "alert" : "status");
}
export function empty(node, message) {
  const text = document.createElement("p");
  text.className = "empty";
  text.textContent = message;
  node.replaceChildren(text);
}
export function records(node, items, describe, emptyText) {
  node.replaceChildren();
  if (!items.length) return empty(node, emptyText);
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "event-row";
    const title = document.createElement("p");
    title.textContent = describe(item);
    row.append(
      title,
      details(
        document.documentElement.lang.startsWith("en") ? "Details" : "详情",
        item,
      ),
    );
    node.append(row);
  }
}
let confirmation;
export function confirmAction(message, title, confirmLabel) {
  if (confirmation) return Promise.resolve(false);
  const english = document.documentElement.lang.startsWith("en");
  const dialog = document.createElement("dialog"),
    heading = document.createElement("h2"),
    text = document.createElement("p"),
    actions = document.createElement("div");
  heading.id = "confirmation-title";
  heading.textContent = title || (english ? "Confirm action" : "确认操作");
  text.textContent = message;
  actions.className = "actions";
  dialog.setAttribute("aria-labelledby", heading.id);
  const previous = document.activeElement;
  return new Promise((resolve) => {
    confirmation = dialog;
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      confirmation = undefined;
      previous?.focus();
      if (previous?.disabled) {
        const observer = new MutationObserver(() => {
          if (!previous.disabled) {
            observer.disconnect();
            if (
              previous.isConnected &&
              document.activeElement === document.body
            )
              previous.focus();
          }
        });
        observer.observe(previous, {
          attributes: true,
          attributeFilter: ["disabled"],
        });
        setTimeout(() => observer.disconnect(), 10000);
      }
      resolve(value);
    };
    const cancel = button(english ? "Cancel" : "取消", () => finish(false));
    const accept = button(
      confirmLabel || (english ? "Continue" : "继续"),
      () => finish(true),
      "primary",
    );
    actions.append(cancel, accept);
    dialog.append(heading, text, actions);
    document.body.append(dialog);
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    dialog.showModal();
    cancel.focus();
  });
}
let toastNode, toastTimer;
export function toast(message) {
  clearTimeout(toastTimer);
  toastNode?.remove();
  toastNode = document.createElement("div");
  toastNode.className = "toast";
  toastNode.setAttribute("role", "status");
  toastNode.textContent = message;
  document.body.append(toastNode);
  toastTimer = setTimeout(() => toastNode?.remove(), 4500);
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = ["light", "dark"].includes(theme)
    ? theme
    : "system";
}
export function createDrafts(root = document) {
  const dirty = new Set();
  const mark = (e) => {
    if (
      e.target.matches("input,select,textarea") &&
      !e.target.readOnly &&
      !e.target.hasAttribute("data-transient")
    )
      dirty.add(e.target.id);
  };
  root.addEventListener("input", mark);
  root.addEventListener("change", mark);
  return {
    has: (id) => dirty.has(id),
    clear: (ids, saved) => {
      for (const id of ids) {
        const before = saved?.find((item) => item[0] === id);
        const node = document.getElementById(id);
        if (
          !saved ||
          (before && node?.value === before[1] && node?.checked === before[2])
        )
          dirty.delete(id);
      }
    },
    write: (id, value, checked = false) => {
      const node = document.getElementById(id);
      if (node && !dirty.has(id)) node[checked ? "checked" : "value"] = value;
    },
    snapshot: () =>
      [...dirty].map((id) => {
        const node = document.getElementById(id);
        return [id, node?.value, node?.checked];
      }),
    restore: (saved) => {
      for (const [id, value, checked] of saved) {
        const node = document.getElementById(id);
        if (node) {
          node.value = value;
          if (checked !== undefined) node.checked = checked;
        }
      }
    },
    any: () => dirty.size > 0,
  };
}

export function icon(name, className = "") {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function iconButton(name, label, { className = "", onClick, title } = {}) {
  const button = el("button", {
    class: `icon-btn ${className}`,
    type: "button",
    "aria-label": label,
    title: title || label,
    html: icon(name),
  });
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

export function setIcon(button, name) {
  if (!button) return;
  button.innerHTML = icon(name);
}

export function formatTime(seconds, { forceHours = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0 || forceHours) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${Math.max(1, m)} 分钟`;
}

export function initials(name) {
  const value = String(name || "?").trim();
  if (!value) return "?";
  const chars = [...value];
  return chars.slice(0, 2).join("").toUpperCase();
}

export function chatTime(ts) {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isMobile() {
  return window.matchMedia("(max-width: 860px)").matches;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = el("textarea", {
      style: { position: "fixed", top: "-1000px", opacity: "0" },
      text,
    });
    document.body.append(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    textarea.remove();
    return ok;
  }
}

export function safeImageUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, location.href);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:") return url.toString();
  } catch {
    return "";
  }
  return "";
}

let toastSeq = 0;

export function toast(message, { type = "info", duration = 3200 } = {}) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const id = `t${++toastSeq}`;
  const node = el(
    "div",
    { class: `toast toast-${type}`, role: "status", dataset: { id } },
    el("span", { class: "toast-dot" }),
    el("span", { class: "toast-text", text: message }),
  );
  root.append(node);
  requestAnimationFrame(() => node.classList.add("show"));
  const remove = () => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 220);
  };
  const timer = setTimeout(remove, duration);
  node.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
  while (root.children.length > 4) root.firstElementChild?.remove();
}

export function openModal({ title, body, actions = [], wide = false, closable = true, onClose = null }) {
  const root = document.getElementById("modal-root");
  if (!root) return null;
  const backdrop = el("div", { class: "modal-backdrop" });
  const modal = el("div", {
    class: `modal ${wide ? "modal-wide" : ""}`,
    role: "dialog",
    "aria-modal": "true",
  });
  const closeButton = closable
    ? el("button", { class: "icon-btn modal-close", type: "button", "aria-label": "关闭", html: icon("x") })
    : null;
  const head = el(
    "div",
    { class: "modal-head" },
    el("h3", { text: title || "" }),
    closeButton,
  );
  const content = el("div", { class: "modal-body" });
  if (body instanceof Node) content.append(body);
  else content.innerHTML = body || "";
  const footer = el("div", { class: "modal-actions" });
  modal.append(head, content, footer);
  backdrop.append(modal);
  root.append(backdrop);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    backdrop.classList.remove("show");
    setTimeout(() => {
      backdrop.remove();
      if (onClose) onClose();
    }, 180);
  };
  const onKey = (event) => {
    if (event.key === "Escape" && closable && backdrop === root.lastElementChild) close();
  };
  document.addEventListener("keydown", onKey);
  if (closeButton) closeButton.addEventListener("click", close);
  if (closable) {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close();
    });
  }

  for (const action of actions) {
    const button = el("button", {
      class: `btn ${action.kind === "primary" ? "btn-primary" : action.kind === "danger" ? "btn-danger" : "btn-ghost"} ${action.className || ""}`,
      type: "button",
      text: action.label,
      disabled: action.disabled || false,
    });
    if (action.id) button.id = action.id;
    if (action.icon) button.insertAdjacentHTML("afterbegin", icon(action.icon));
    button.addEventListener("click", async () => {
      if (action.onClick) {
        const result = await action.onClick({ close, button });
        if (result === false) return;
      }
      if (action.keepOpen) return;
      close();
    });
    footer.append(button);
  }
  requestAnimationFrame(() => {
    backdrop.classList.add("show");
    const focusable = modal.querySelector("input, textarea, select, button.btn-primary, button");
    focusable?.focus?.();
  });

  return { close, modal, body: content, footer, backdrop };
}

export function confirmDialog({ title = "确认", message, confirmLabel = "确定", danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title,
      body: el("p", { class: "modal-text", text: message }),
      actions: [
        { label: "取消", kind: "ghost", keepOpen: false, onClick: () => { settled = true; resolve(false); } },
        {
          label: confirmLabel,
          kind: danger ? "danger" : "primary",
          onClick: () => {
            settled = true;
            resolve(true);
          },
        },
      ],
      onClose: () => {
        if (!settled) resolve(false);
      },
    });
    if (!modal) resolve(false);
  });
}

import { el, icon, chatTime, initials, openModal } from "./ui.js";

const EMOJIS = ["❤️", "😍", "🥺", "😂", "😭", "🥰", "😴", "🍿", "🌙", "✨", "🎬", "🔥", "👏", "👍", "🤝", "🎉"];
const UPLOAD_RE = /^\/uploads\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/;

function openChatImage(url) {
  if (!UPLOAD_RE.test(url)) return;
  const body = el("div", { class: "lightbox" }, el("img", { class: "lightbox-img", src: url, alt: "图片" }));
  const modal = openModal({ title: "图片", body, wide: true, actions: [] });
  if (!modal) return;
  modal.footer.append(
    el("a", {
      class: "btn btn-ghost",
      href: url,
      download: "",
      target: "_blank",
      rel: "noopener",
      text: "保存图片",
    }),
  );
}

export class ChatView {
  constructor({ root, onSend, onTyping, onImage }) {
    this.root = root;
    this.onSend = onSend;
    this.onTyping = onTyping;
    this.onImage = onImage;
    this.messages = [];
    this.typingMembers = new Map();
    this.typingTimer = null;
    this.typingExpireTimer = null;
    this.lastTypingSent = 0;
    this.build();
  }

  build() {
    this.root.innerHTML = "";
    this.list = el("div", { class: "chat-list", id: "chat-list" });
    this.typing = el("div", { class: "chat-typing", id: "chat-typing" });
    this.emojiPanel = el("div", { class: "emoji-panel", hidden: true });
    for (const emoji of EMOJIS) {
      const button = el("button", { class: "emoji", type: "button", text: emoji, "aria-label": emoji });
      button.addEventListener("click", () => this.insertEmoji(emoji));
      this.emojiPanel.append(button);
    }
    this.input = el("textarea", {
      class: "chat-input",
      id: "chat-input",
      rows: "1",
      maxlength: "800",
      placeholder: "说点什么…",
      "aria-label": "聊天输入框",
    });
    this.sendButton = el("button", {
      class: "send-btn",
      type: "submit",
      "aria-label": "发送",
      html: icon("send"),
    });
    this.emojiButton = el("button", {
      class: "icon-btn chat-emoji-btn",
      type: "button",
      "aria-label": "表情",
      html: icon("smile"),
    });
    this.imageButton = el("button", {
      class: "icon-btn chat-emoji-btn",
      type: "button",
      "aria-label": "发送图片",
      title: "发送图片（视频不会暂停）",
      html: icon("image"),
    });
    this.fileInput = el("input", {
      type: "file",
      accept: "image/jpeg,image/png,image/webp,image/gif",
      hidden: true,
    });
    this.form = el(
      "form",
      { class: "chat-form", id: "chat-form" },
      this.imageButton,
      this.emojiButton,
      el("div", { class: "chat-input-wrap" }, this.input, this.emojiPanel),
      this.sendButton,
      this.fileInput,
    );

    this.root.append(
      el(
        "div",
        { class: "chat-head" },
        el("div", { class: "chat-title" }, el("span", { html: icon("chat") }), "聊天"),
        el("div", { class: "chat-online", id: "chat-online" }, ""),
      ),
      this.list,
      this.typing,
      this.form,
    );

    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener("input", () => {
      this.autoGrow();
      this.notifyTyping();
    });
    this.emojiButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.emojiPanel.hidden = !this.emojiPanel.hidden;
    });
    this.imageButton.addEventListener("click", () => {
      this.fileInput.click();
    });
    this.fileInput.addEventListener("change", () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = "";
      if (file) this.onImage?.(file);
    });
    this.input.addEventListener("paste", (event) => {
      const items = [...(event.clipboardData?.items || [])];
      const imageItem = items.find((item) => item.type.startsWith("image/"));
      if (!imageItem) return;
      const file = imageItem.getAsFile();
      if (!file) return;
      event.preventDefault();
      this.onImage?.(file);
    });
    document.addEventListener("click", (event) => {
      if (!this.emojiPanel.hidden && !this.emojiPanel.contains(event.target) && !this.emojiButton.contains(event.target)) {
        this.emojiPanel.hidden = true;
      }
    });
  }

  setOnlineCount(count) {
    const node = this.root.querySelector("#chat-online");
    if (node) node.textContent = count > 0 ? `${count} 人在线` : "";
  }

  autoGrow() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
  }

  insertEmoji(emoji) {
    const start = this.input.selectionStart || 0;
    const end = this.input.selectionEnd || 0;
    const text = this.input.value;
    this.input.value = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
    this.input.selectionStart = this.input.selectionEnd = start + emoji.length;
    this.input.focus();
    this.emojiPanel.hidden = true;
    this.autoGrow();
    this.notifyTyping();
  }

  notifyTyping() {
    const now = Date.now();
    if (now - this.lastTypingSent < 1200) return;
    this.lastTypingSent = now;
    this.onTyping?.(true);
    clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.lastTypingSent = 0;
      this.onTyping?.(false);
    }, 2200);
  }

  submit() {
    const text = this.input.value.trim();
    if (!text) return;
    const sent = this.onSend?.(text);
    if (sent === false) return;
    this.input.value = "";
    this.autoGrow();
    this.onTyping?.(false);
    this.lastTypingSent = 0;
    clearTimeout(this.typingTimer);
  }

  setMessages(messages) {
    this.messages = Array.isArray(messages) ? messages.slice(-200) : [];
    this.list.innerHTML = "";
    this.lastAuthor = null;
    this.lastTs = 0;
    for (const message of this.messages) this.appendMessage(message, { silent: true });
    if (!this.messages.length) {
      this.list.append(
        el("div", { class: "chat-empty" }, el("span", { text: "还没有消息，说点什么吧" })),
      );
    }
    this.scrollToBottom(true);
  }

  addMessage(message) {
    this.messages.push(message);
    if (this.messages.length > 250) this.messages.splice(0, this.messages.length - 250);
    const wasNearBottom = this.isNearBottom();
    this.appendMessage(message);
    if (wasNearBottom || message.memberId === this.selfId) this.scrollToBottom();
  }

  appendMessage(message, { silent = false } = {}) {
    this.list.querySelector(".chat-empty")?.remove();
    if (message.system) {
      const node = el("div", { class: "chat-sys" }, el("span", { text: message.text }));
      this.list.append(node);
      this.lastAuthor = null;
      return;
    }
    const mine = message.memberId === this.selfId;
    const grouped =
      this.lastAuthor === message.memberId && message.ts - this.lastTs < 3 * 60 * 1000;
    const node = el("div", { class: `chat-msg ${mine ? "mine" : ""} ${grouped ? "grouped" : ""}` });
    if (!grouped) {
      node.append(
        el(
          "div",
          {
            class: "chat-avatar",
            style: { backgroundColor: message.color || "#c084fc" },
            "aria-hidden": "true",
            text: initials(message.name),
          },
        ),
      );
    } else {
      node.append(el("div", { class: "chat-avatar-spacer" }));
    }
    const imageUrl = typeof message.image === "string" && UPLOAD_RE.test(message.image) ? message.image : "";
    const bubble = el(
      "div",
      { class: "chat-bubble-wrap" },
      grouped
        ? null
        : el(
            "div",
            { class: "chat-meta" },
            el("span", { class: "chat-name", text: message.name }),
            el("span", { class: "chat-time", text: chatTime(message.ts) }),
          ),
      el(
        "div",
        { class: `chat-bubble ${imageUrl && !message.text ? "image-only" : ""}` },
        imageUrl
          ? el(
              "div",
              { class: "chat-image" },
              el("img", {
                class: "chat-image-img",
                src: imageUrl,
                alt: "图片",
                loading: "lazy",
                decoding: "async",
                onClick: (event) => {
                  event.stopPropagation();
                  openChatImage(imageUrl);
                },
              }),
            )
          : null,
        message.text ? el("div", { class: "chat-text", text: message.text }) : null,
      ),
    );
    node.append(bubble);
    this.list.append(node);
    this.lastAuthor = message.memberId;
    this.lastTs = message.ts;
    if (!silent) this.trimList();
  }

  trimList() {
    while (this.list.children.length > 260) this.list.firstElementChild?.remove();
  }

  isNearBottom() {
    const node = this.list;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  scrollToBottom(immediate = false) {
    const node = this.list;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    requestAnimationFrame(() => {
      // 距离远或显式 immediate 时直接跳：smooth 动画被连续消息不断重启，
      // 会永远停在中途，新消息卡在视野外（退出全屏后看不到刚发的）。
      const behavior = immediate || distance > 240 ? "auto" : "smooth";
      node.scrollTo({ top: node.scrollHeight, behavior });
    });
  }

  setSelf({ id, name }) {
    this.selfId = id;
    this.selfName = name;
  }

  setTyping(memberId, name, typing) {
    if (typing) this.typingMembers.set(memberId, { name, until: Date.now() + 3500 });
    else this.typingMembers.delete(memberId);
    this.renderTyping();
    clearTimeout(this.typingExpireTimer);
    if (this.typingMembers.size) {
      this.typingExpireTimer = setTimeout(() => {
        this.typingMembers.clear();
        this.renderTyping();
      }, 4000);
    }
  }

  renderTyping() {
    const now = Date.now();
    for (const [id, item] of this.typingMembers) {
      if (item.until <= now) this.typingMembers.delete(id);
    }
    const names = [...this.typingMembers.values()].map((item) => item.name);
    if (!names.length) {
      this.typing.innerHTML = "";
      return;
    }
    const label = names.length === 1 ? `${names[0]} 正在输入` : `${names.slice(0, 2).join("、")} 正在输入`;
    this.typing.innerHTML = `${label}<span class="dots"><i></i><i></i><i></i></span>`;
  }

  setDisabled(disabled) {
    this.input.disabled = disabled;
    this.sendButton.disabled = disabled;
    this.imageButton.disabled = disabled;
    this.fileInput.disabled = disabled;
    this.input.placeholder = disabled ? "连接中…" : "说点什么…";
  }

  focus() {
    this.input.focus();
  }
}

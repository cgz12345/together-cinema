import { api, ApiError, getAccessCode, setAccessCode } from "./api.js";
import { RoomSocket } from "./ws.js";
import { Player } from "./player.js";
import { VoiceChat } from "./voice.js";
import { ChatView } from "./chat.js";
import {
  el,
  icon,
  iconButton,
  toast,
  openModal,
  confirmDialog,
  copyText,
  formatTime,
  formatDuration,
  initials,
  safeImageUrl,
} from "./ui.js";
import { clamp, parseHash, navigate } from "./utils.js";

const DIRECT_URL_RE = /\.(m3u8|mp4|flv|webm|mkv|mov|m4v)(?:$|[?#])/i;
const NAME_KEY = "wp.name";
const RECENT_KEY = "wp.recentRooms";
const VOLUME_KEY = "wp.volume";
const MUTED_KEY = "wp.muted";

const state = {
  view: "home",
  code: "",
  me: null,
  voice: null,
  playlist: null,
  isHost: false,
  hostId: null,
  hostOnline: false,
  video: null,
  playback: { playing: false, position: 0, rate: 1 },
  settings: { autoWait: true, controlMode: "shared" },
  members: [],
  ws: null,
  player: null,
  chat: null,
  memberToken: "",
  hostToken: "",
  loadedVideoId: null,
  levels: [],
  currentLevel: -1,
  connection: "closed",
  dragging: false,
  fsChatCollapsed: false,
  fsChatUnread: 0,
  localBuffering: false,
  bufferOnTimer: null,
  bufferOffTimer: null,
  bufferSent: false,
  lastSyncAt: 0,
  lastSyncText: "",
  unread: 0,
  heartbeatTimer: null,
  reconnecting: false,
  accessPromptOpen: false,
};

const refs = {};

function appRoot() {
  return document.getElementById("app");
}

function storedName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // ignore
  }
}

function isTabVisible() {
  return document.visibilityState === "visible";
}

function setDocumentTitle(base) {
  const prefix = state.unread > 0 && !isTabVisible() ? `(${state.unread}) ` : "";
  document.title = `${prefix}${base}`;
}

function clearUnread() {
  state.unread = 0;
  setDocumentTitle(state.video?.title ? `${state.video.title} · 两人放映室` : "两人放映室 · 异地同步看片");
}

async function withAccess(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.code === "invalid_access_code")) {
      const code = await promptAccessCode({ message: error.message });
      if (!code) throw error;
      return await fn();
    }
    throw error;
  }
}

async function ensureAccess() {
  const existing = getAccessCode();
  try {
    await api.checkAccess();
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.code === "invalid_access_code")) {
      const code = await promptAccessCode({ message: existing ? "通行码已失效，请重新输入" : undefined });
      if (!code) return false;
      return true;
    }
    toast(error.message || "无法连接服务器", { type: "error" });
    return false;
  }
}

function promptAccessCode({ message = "这是私人放映室，输入房主给你的通行码。" } = {}) {
  if (state.accessPromptOpen) return Promise.resolve(null);
  state.accessPromptOpen = true;
  return new Promise((resolve) => {
    let resolved = false;
    const input = el("input", {
      class: "input",
      type: "password",
      placeholder: "通行码",
      autocomplete: "current-password",
      maxlength: "128",
    });
    const errorNode = el("p", { class: "form-error" });
    const body = el(
      "div",
      { class: "form-stack" },
      el("p", { class: "modal-text", text: message }),
      input,
      errorNode,
    );
    const modal = openModal({
      title: "输入通行码",
      body,
      actions: [
        {
          label: "进入",
          kind: "primary",
          keepOpen: true,
          onClick: async ({ button, close }) => {
            const value = input.value.trim();
            if (!value) {
              errorNode.textContent = "请输入通行码";
              return false;
            }
            button.disabled = true;
            errorNode.textContent = "";
            setAccessCode(value);
            try {
              await api.checkAccess();
              resolved = true;
              close();
              resolve(value);
            } catch (error) {
              setAccessCode("");
              errorNode.textContent = error.message || "通行码不正确";
              button.disabled = false;
            }
            return false;
          },
        },
      ],
      closable: true,
      onClose: () => {
        state.accessPromptOpen = false;
        if (!resolved) resolve(null);
      },
    });
    if (!modal) {
      state.accessPromptOpen = false;
      resolve(null);
      return;
    }
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        modal.footer.querySelector(".btn-primary")?.click();
      }
    });
    setTimeout(() => input.focus(), 80);
  });
}

function promptName() {
  return new Promise((resolve) => {
    let resolved = false;
    const input = el("input", {
      class: "input",
      type: "text",
      placeholder: "例如：小熊 / 阿梨",
      maxlength: "24",
      value: storedName(),
      autocomplete: "nickname",
    });
    const errorNode = el("p", { class: "form-error" });
    const modal = openModal({
      title: "怎么称呼你？",
      body: el(
        "div",
        { class: "form-stack" },
        el("p", { class: "modal-text", text: "这个名字会显示在放映室和聊天里。" }),
        input,
        errorNode,
      ),
      actions: [
        {
          label: "进入放映室",
          kind: "primary",
          keepOpen: true,
          onClick: ({ close }) => {
            const value = input.value.trim();
            if (!value) {
              errorNode.textContent = "先给自己起个名字吧";
              return false;
            }
            saveName(value);
            resolved = true;
            close();
            resolve(value);
            return false;
          },
        },
      ],
      closable: true,
      onClose: () => {
        if (!resolved) resolve(null);
      },
    });
    if (!modal) {
      resolve(null);
      return;
    }
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        modal.footer.querySelector(".btn-primary")?.click();
      }
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 80);
  });
}

async function getSelfName() {
  const name = storedName();
  if (name) return name;
  return promptName();
}

function readRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveRecent(entry) {
  const list = readRecent().filter((item) => item.code !== entry.code);
  list.unshift({ ...entry, ts: Date.now() });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    // ignore
  }
}

function getHostToken(code) {
  try {
    return localStorage.getItem(`wp.host.${code}`) || "";
  } catch {
    return "";
  }
}

function setHostToken(code, token) {
  try {
    localStorage.setItem(`wp.host.${code}`, token);
  } catch {
    // ignore
  }
}

function getMemberToken(code) {
  try {
    return sessionStorage.getItem(`wp.member.${code}`) || "";
  } catch {
    return "";
  }
}

function setMemberToken(code, token) {
  try {
    sessionStorage.setItem(`wp.member.${code}`, token);
  } catch {
    // ignore
  }
}

function renderLoading(message = "正在进入放映室…") {
  const app = appRoot();
  app.className = "app boot-app";
  app.innerHTML = "";
  app.append(
    el(
      "div",
      { class: "boot-card" },
      el("div", { class: "brand-mark", html: icon("film") }),
      el("div", { class: "spinner" }),
      el("p", { class: "boot-text", text: message }),
    ),
  );
}

function renderFatal(message, detail = "") {
  const app = appRoot();
  app.className = "app boot-app";
  app.innerHTML = "";
  app.append(
    el(
      "div",
      { class: "boot-card" },
      el("div", { class: "brand-mark", html: icon("film") }),
      el("h1", { class: "boot-title", text: "进不去这间放映室" }),
      el("p", { class: "boot-text", text: message }),
      detail ? el("p", { class: "boot-detail", text: detail }) : null,
      el("button", {
        class: "btn btn-primary",
        type: "button",
        text: "回到首页",
        onClick: () => navigate("/"),
      }),
    ),
  );
}

function cleanupRoom() {
  if (state.voice) {
    state.voice.disable();
    state.voice = null;
  }
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
  if (state.bufferOnTimer) {
    clearTimeout(state.bufferOnTimer);
    state.bufferOnTimer = null;
  }
  if (state.bufferOffTimer) {
    clearTimeout(state.bufferOffTimer);
    state.bufferOffTimer = null;
  }
  state.bufferSent = false;
  if (state.player) {
    state.player.destroy();
    state.player = null;
  }
  state.chat = null;
  state.video = null;
  state.loadedVideoId = null;
  state.members = [];
  state.me = null;
  state.playback = { playing: false, position: 0, rate: 1 };
  state.levels = [];
  state.currentLevel = -1;
  state.localBuffering = false;
  state.lastSyncAt = 0;
  state.unread = 0;
  state.dragging = false;
  clearUnread();
}

function route() {
  const parsed = parseHash();
  if (parsed.view === "room") {
    if (state.view === "room" && state.code === parsed.code && state.ws) return;
    enterRoom(parsed.code);
  } else {
    cleanupRoom();
    state.view = "home";
    state.code = "";
    renderHome();
  }
}

window.addEventListener("hashchange", route);
document.addEventListener("visibilitychange", () => {
  if (isTabVisible()) clearUnread();
});

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function renderHome() {
  state.view = "home";
  document.title = "两人放映室 · 异地同步看片";
  const app = appRoot();
  app.className = "app home-app";
  app.innerHTML = `
    <div class="bg-orb orb-a"></div>
    <div class="bg-orb orb-b"></div>
    <div class="bg-grid"></div>
    <header class="site-head">
      <a class="brand" href="#/">
        <span class="brand-mark">${icon("film")}</span>
        <span class="brand-name">两人放映室</span>
      </a>
      <div class="site-head-actions">
        <span class="head-note">${icon("lock")} 只给受邀的人</span>
      </div>
    </header>
    <main class="home-main">
      <section class="hero">
        <div class="hero-copy">
          <div class="eyebrow">${icon("sparkles")} 异地恋的专属放映室</div>
          <h1>把链接变成<br><span class="gradient-text">两个人的同屏夜晚</span></h1>
          <p class="hero-sub">粘贴视频页或直播页链接，自动嗅探真实播放地址。同步播放、自由倍速、原画画质、实时聊天——距离很远，屏幕很近。</p>
          <div class="feature-row">
            <span class="feature-pill">${icon("monitor-play")} 原画画质</span>
            <span class="feature-pill">${icon("refresh")} 毫秒级同步</span>
            <span class="feature-pill">${icon("gauge")} 0.5×–2.5×</span>
            <span class="feature-pill">${icon("chat")} 实时聊天</span>
          </div>
          <div class="hero-footnote">${icon("shield")} 私人房间 · 链接不公开 · 不转码、不降清晰度</div>
        </div>
        <div class="hero-panel">
          <div class="hero-screen">
            <div class="hero-screen-top">
              <span class="screen-dot red"></span><span class="screen-dot yellow"></span><span class="screen-dot green"></span>
              <span class="screen-url">together.cinema / room</span>
            </div>
            <div class="hero-screen-body">
              <div class="screen-play">${icon("play")}</div>
              <div class="screen-bars"><i></i><i></i><i></i><i></i></div>
              <div class="screen-caption">今晚 21:00 · 和 TA 一起</div>
            </div>
          </div>
          <div class="create-card">
            <div class="card-title">开始一场只属于你们的放映</div>
            <label class="field-label" for="url-input">影片 / 直播链接</label>
            <div class="input-with-icon">
              ${icon("link")}
              <input id="url-input" class="input" type="url" placeholder="视频页 / 直播页 / m3u8 / mp4 直链" autocomplete="off" spellcheck="false">
            </div>
            <details class="advanced">
              <summary>需要登录？可选填 Cookie</summary>
              <textarea id="cookies-input" class="input textarea" rows="3" placeholder="Netscape 格式或 a=1; b=2（仅用于解析和播放，不落盘）"></textarea>
            </details>
            <div id="home-error" class="form-error"></div>
            <button id="btn-create-url" class="btn btn-primary btn-block" type="button">${icon("sparkles")} 解析并开播</button>
            <div class="or-line"><span>或者</span></div>
            <button id="btn-create-empty" class="btn btn-ghost btn-block" type="button">${icon("plus")} 先开一间空放映室</button>
            <button id="btn-discover" class="btn btn-ghost btn-block" type="button">${icon("search")} 找片 · 从资源站搜索</button>
            <button id="btn-live" class="btn btn-ghost btn-block" type="button">${icon("monitor-play")} 看电视 · 直播频道</button>
          </div>
        </div>
      </section>

      <section class="join-section">
        <div class="join-card">
          <div class="join-copy">
            <div class="eyebrow">${icon("users")} 已经有房间了？</div>
            <h2>加入 TA 的放映室</h2>
            <p>输入 6 位房间码，或者直接点开 TA 发来的邀请链接。</p>
          </div>
          <div class="join-form">
            <input id="code-input" class="input code-input" type="text" inputmode="text" maxlength="6" placeholder="ABC123" autocomplete="off" spellcheck="false">
            <button id="btn-join" class="btn btn-primary" type="button">${icon("arrow-right")} 进入</button>
          </div>
        </div>
        <div id="recent-rooms" class="recent-rooms"></div>
      </section>

      <section class="how-section">
        <div class="how-card">
          <span class="how-num">01</span>
          <h3>粘贴链接</h3>
          <p>支持视频页、直播页和 m3u8 / mp4 直链。服务器会嗅探页面里的真实播放地址，并代理防盗链。</p>
        </div>
        <div class="how-card">
          <span class="how-num">02</span>
          <h3>分享房间</h3>
          <p>把房间链接和通行码发给 TA。两个人打开同一个房间，就能看到同一部影片。</p>
        </div>
        <div class="how-card">
          <span class="how-num">03</span>
          <h3>一起看</h3>
          <p>播放、暂停、拖动、倍速都会实时同步；TA 缓冲时自动等你，聊天就在旁边。</p>
        </div>
      </section>
    </main>
    <footer class="site-foot">
      <span>${icon("heart")} 距离很远，屏幕很近</span>
      <div class="site-foot-actions">
        <button id="btn-change-access" class="link-btn" type="button">${icon("key")} 更换通行码</button>
      </div>
    </footer>
  `;

  const urlInput = app.querySelector("#url-input");
  const cookiesInput = app.querySelector("#cookies-input");
  const homeError = app.querySelector("#home-error");
  const btnCreateUrl = app.querySelector("#btn-create-url");
  const btnCreateEmpty = app.querySelector("#btn-create-empty");
  const codeInput = app.querySelector("#code-input");
  const btnJoin = app.querySelector("#btn-join");

  const submitUrl = () => {
    const url = urlInput.value.trim();
    if (!url) {
      homeError.textContent = "先粘贴一个影片链接";
      urlInput.focus();
      return;
    }
    homeError.textContent = "";
    // 直链直接开房，不做页面嗅探，省掉一圈等待
    if (DIRECT_URL_RE.test(url) && !cookiesInput.value.trim()) {
      createDirectRoom(url);
      return;
    }
    startResolve({ mode: "create", initialUrl: url, initialCookies: cookiesInput.value, autoStart: true });
  };

  async function createDirectRoom(url, extra = {}) {
    const name = await getSelfName();
    if (!name) return;
    btnCreateUrl.disabled = true;
    btnCreateUrl.innerHTML = `${icon("loader", "spin")} 正在开房…`;
    try {
      const result = await withAccess(() => api.createDirectRoom(name, url, extra));
      setHostToken(result.code, result.hostToken);
      setMemberToken(result.code, result.memberToken);
      saveRecent({ code: result.code, title: result.state?.video?.title || "" });
      navigate(`/r/${result.code}`);
    } catch (error) {
      homeError.textContent = error.message || "开房失败";
    } finally {
      btnCreateUrl.disabled = false;
      btnCreateUrl.innerHTML = `${icon("sparkles")} 解析并开播`;
    }
  }

  btnCreateUrl.addEventListener("click", submitUrl);
  app.querySelector("#btn-discover").addEventListener("click", () => openDiscovery({ mode: "create" }));
  app.querySelector("#btn-live").addEventListener("click", () => openLiveTV({ mode: "create" }));
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitUrl();
    }
  });
  btnCreateEmpty.addEventListener("click", async () => {
    homeError.textContent = "";
    btnCreateEmpty.disabled = true;
    btnCreateEmpty.innerHTML = `${icon("loader", "spin")} 正在开房…`;
    try {
      const name = await getSelfName();
      if (!name) {
        btnCreateEmpty.disabled = false;
        btnCreateEmpty.innerHTML = `${icon("plus")} 先开一间空放映室`;
        return;
      }
      const result = await withAccess(() => api.createRoom(name));
      setHostToken(result.code, result.hostToken);
      setMemberToken(result.code, result.memberToken);
      saveRecent({ code: result.code, title: "" });
      navigate(`/r/${result.code}`);
    } catch (error) {
      homeError.textContent = error.message || "开房失败";
      toast(error.message || "开房失败", { type: "error" });
    } finally {
      btnCreateEmpty.disabled = false;
      btnCreateEmpty.innerHTML = `${icon("plus")} 先开一间空放映室`;
    }
  });

  const join = async () => {
    const code = codeInput.value.trim().toUpperCase();
    homeError.textContent = "";
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      homeError.textContent = "请输入 6 位房间码";
      codeInput.focus();
      return;
    }
    btnJoin.disabled = true;
    btnJoin.innerHTML = `${icon("loader", "spin")} 进入中…`;
    try {
      await withAccess(() => api.getRoom(code));
      navigate(`/r/${code}`);
    } catch (error) {
      homeError.textContent = error.message || "找不到这个房间";
      toast(error.message || "找不到这个房间", { type: "error" });
    } finally {
      btnJoin.disabled = false;
      btnJoin.innerHTML = `${icon("arrow-right")} 进入`;
    }
  };
  btnJoin.addEventListener("click", join);
  codeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      join();
    }
  });
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  });

  app.querySelector("#btn-change-access").addEventListener("click", () => {
    promptAccessCode({ message: "输入新的通行码。留空不会清除，直接关闭即可。" }).then((value) => {
      if (value) toast("通行码已更新", { type: "success" });
    });
  });

  renderRecent();
}

function renderRecent() {
  const root = document.querySelector("#recent-rooms");
  if (!root) return;
  const list = readRecent();
  root.innerHTML = "";
  if (!list.length) return;
  root.append(el("div", { class: "recent-label", text: "最近的放映室" }));
  const wrap = el("div", { class: "recent-list" });
  for (const item of list.slice(0, 6)) {
    const button = el(
      "button",
      { class: "recent-item", type: "button" },
      el("span", { class: "recent-icon", html: icon("film") }),
      el(
        "span",
        { class: "recent-main" },
        el("span", { class: "recent-title", text: item.title || "未命名放映室" }),
        el("span", { class: "recent-meta", text: `${item.code} · ${timeAgo(item.ts)}` }),
      ),
      el("span", { class: "recent-arrow", html: icon("chevron-right") }),
    );
    button.addEventListener("click", () => navigate(`/r/${item.code}`));
    wrap.append(button);
  }
  root.append(wrap);
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// ---------------------------------------------------------------------------
// Discovery / resource-site search
// ---------------------------------------------------------------------------

function openSourceManager(onUpdated) {
  const listNode = el("div", { class: "source-list" });
  const nameInput = el("input", {
    class: "input",
    placeholder: "片源名称，例如：量子资源",
    maxlength: "40",
    autocomplete: "off",
  });
  const apiInput = el("input", {
    class: "input",
    type: "url",
    placeholder: "https://.../api.php/provide/vod/",
    autocomplete: "off",
    spellcheck: "false",
  });
  const errorNode = el("p", { class: "form-error" });
  const addButton = el("button", {
    class: "btn btn-primary",
    type: "button",
    html: `${icon("plus")} 添加片源`,
  });
  const body = el(
    "div",
    { class: "source-manager" },
    el("p", {
      class: "modal-text",
      text: "添加苹果 CMS / MacCMS 的 JSON 采集接口。片源里的播放地址会走现有解析和代理，不会直接暴露给浏览器。",
    }),
    listNode,
    el(
      "div",
      { class: "source-add" },
      nameInput,
      apiInput,
      addButton,
      errorNode,
    ),
    el("p", {
      class: "settings-hint",
      text: "只添加你有权使用的资源站；不内置来源不明的站点。",
    }),
  );
  const modal = openModal({ title: "片源管理", body, wide: true, actions: [{ label: "关闭", kind: "ghost" }] });
  if (!modal) return;

  const render = (sources) => {
    listNode.innerHTML = "";
    if (!sources.length) {
      listNode.append(
        el("p", { class: "modal-text", text: "还没有片源。添加接口后就能在“找片”里搜索。" }),
      );
      return;
    }
    for (const source of sources) {
      const row = el(
        "div",
        { class: "source-row" },
        el(
          "div",
          { class: "source-row-main" },
          el("span", { class: "source-row-name", text: source.name }),
          el("span", { class: "source-row-api", text: source.api, title: source.api }),
        ),
      );
      const remove = el("button", {
        class: "icon-btn source-delete",
        type: "button",
        "aria-label": `删除 ${source.name}`,
        title: "删除",
        html: icon("x"),
      });
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          const data = await withAccess(() => api.deleteDiscoverSource(source.id));
          render(data.sources || []);
          onUpdated?.();
          toast("片源已删除", { type: "success" });
        } catch (error) {
          toast(error.message || "删除失败", { type: "error" });
          remove.disabled = false;
        }
      });
      row.append(remove);
      listNode.append(row);
    }
  };

  const load = async () => {
    listNode.innerHTML = "";
    listNode.append(el("div", { class: "discover-status", text: "正在读取片源…" }));
    try {
      const data = await withAccess(() => api.discoverSources());
      render(data.sources || []);
    } catch (error) {
      listNode.innerHTML = "";
      listNode.append(el("p", { class: "discover-status discover-error", text: error.message || "读取片源失败" }));
    }
  };

  addButton.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const apiUrl = apiInput.value.trim();
    if (!name) {
      errorNode.textContent = "请填写片源名称";
      nameInput.focus();
      return;
    }
    if (!/^https?:\/\//i.test(apiUrl)) {
      errorNode.textContent = "请输入 http(s) 开头的接口地址";
      apiInput.focus();
      return;
    }
    errorNode.textContent = "";
    addButton.disabled = true;
    addButton.innerHTML = `${icon("loader", "spin")} 添加中…`;
    try {
      const data = await withAccess(() => api.addDiscoverSource(name, apiUrl));
      render(data.sources || []);
      nameInput.value = "";
      apiInput.value = "";
      onUpdated?.();
      toast("片源已添加", { type: "success" });
    } catch (error) {
      errorNode.textContent = error.message || "添加失败";
    } finally {
      addButton.disabled = false;
      addButton.innerHTML = `${icon("plus")} 添加片源`;
    }
  });

  apiInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addButton.click();
    }
  });
  load();
}

function openDiscovery({ mode = "create" } = {}) {
  const input = el("input", {
    class: "input",
    type: "search",
    maxlength: "60",
    placeholder: "输入片名或演员，例如：庆余年",
    autocomplete: "off",
  });
  const searchButton = el("button", {
    class: "btn btn-primary",
    type: "button",
    html: `${icon("search")} 搜索`,
  });
  const statusNode = el("div", { class: "discover-status" });
  const resultsNode = el("div", { class: "discover-results" });
  const cookieInput = el("textarea", {
    class: "input textarea",
    rows: "2",
    placeholder: "Netscape 格式，或 a=1; b=2",
  });
  const cookieDetails = el(
    "details",
    { class: "advanced" },
    el("summary", { text: "需要登录的源？可选填 Cookie" }),
    cookieInput,
  );
  const manageButton = el("button", {
    class: "link-btn",
    type: "button",
    html: `${icon("settings")} 片源管理`,
  });
  const body = el(
    "div",
    { class: "discover" },
    el("div", { class: "discover-search" }, input, searchButton),
    el(
      "div",
      { class: "discover-manage-row" },
      el("p", {
        class: "discover-hint",
        text: "按片名聚合多个源，结果按相关性排序；点一集就会推送到房间。",
      }),
      manageButton,
    ),
    cookieDetails,
    statusNode,
    resultsNode,
  );
  const modal = openModal({
    title: "找片",
    body,
    wide: true,
    actions: [{ label: "关闭", kind: "ghost" }],
  });
  if (!modal) return;

  let sources = [];
  let searching = false;

  const setStatus = (text, isError = false) => {
    statusNode.textContent = text || "";
    statusNode.className = `discover-status ${isError ? "discover-error" : ""}`;
  };

  const normalizeTitle = (title) =>
    String(title || "").toLowerCase().replace(/\s+/g, "").replace(/[·:：\-—_]/g, "");

  const buildGroups = (list) => {
    const map = new Map();
    for (const source of list) {
      if (!source.ok) continue;
      for (const item of source.results) {
        const key = normalizeTitle(item.title);
        if (!key) continue;
        let group = map.get(key);
        if (!group) {
          group = {
            key,
            title: item.title,
            poster: item.poster,
            year: item.year,
            remarks: item.remarks,
            entries: [],
          };
          map.set(key, group);
        }
        group.entries.push({ sourceName: source.name, item });
        if (!group.poster && item.poster) group.poster = item.poster;
        if (!group.year && item.year) group.year = item.year;
        if (!group.remarks && item.remarks) group.remarks = item.remarks;
      }
    }
    return [...map.values()];
  };

  const groupEpisodeCount = (group) =>
    Math.max(0, ...group.entries.map((entry) => entry.item.episodes.length));

  const scoreGroup = (group, query) => {
    const q = String(query || "").toLowerCase().replace(/\s+/g, "");
    const t = group.title.toLowerCase().replace(/\s+/g, "");
    let score = 0;
    if (t === q) score += 120;
    else if (t.startsWith(q)) score += 70;
    else if (t.includes(q)) score += 35;
    if (/解说|预告|花絮|片段|混剪|reaction|cut/i.test(group.title)) score -= 80;
    score += Math.min(group.entries.length, 6) * 8;
    score += Math.min(groupEpisodeCount(group), 120) * 0.12;
    if (group.entries.some((entry) => entry.item.episodes.some((episode) => /\.m3u8/i.test(episode.url)))) {
      score += 25;
    }
    return score;
  };

  const renderAggregated = (list) => {
    resultsNode.innerHTML = "";
    const errors = list.filter((source) => !source.ok);
    const groups = buildGroups(list).sort((a, b) => scoreGroup(b, input.value) - scoreGroup(a, input.value));
    if (errors.length) {
      resultsNode.append(
        el("div", {
          class: "discover-source-error",
          text: `部分源失败：${errors.map((source) => source.name).join("、")}`,
        }),
      );
    }
    if (!groups.length) {
      setStatus("没有找到结果，换个关键词，或者检查资源站是否可用");
      return;
    }
    setStatus(`找到 ${groups.length} 部影片，按相关性排序`);
    const grid = el("div", { class: "discover-grid" });
    for (const group of groups) {
      const poster = safeImageUrl(group.poster);
      const card = el(
        "button",
        { class: "discover-card", type: "button" },
        poster
          ? el("img", {
              class: "discover-poster",
              src: poster,
              alt: "",
              loading: "lazy",
              referrerpolicy: "no-referrer",
            })
          : el("span", { class: "discover-poster placeholder", html: icon("film") }),
        el(
          "span",
          { class: "discover-info" },
          el("span", { class: "discover-name", text: group.title }),
          el("span", {
            class: "discover-meta",
            text: [
              group.year,
              group.remarks,
              `${group.entries.length} 个源`,
              `${groupEpisodeCount(group)} 集`,
            ]
              .filter(Boolean)
              .join(" · "),
          }),
          el("span", {
            class: "discover-meta",
            text: group.entries.map((entry) => entry.sourceName).join(" / "),
          }),
        ),
      );
      card.addEventListener("click", () => renderGroupEpisodes(group));
      grid.append(card);
    }
    resultsNode.append(grid);
  };

  const renderGroupEpisodes = (group, selectedEntry = null) => {
    resultsNode.innerHTML = "";
    const back = el("button", {
      class: "btn btn-ghost btn-sm",
      type: "button",
      html: `${icon("arrow-left")} 返回搜索结果`,
    });
    back.addEventListener("click", () => renderAggregated(sources));
    const head = el(
      "div",
      { class: "discover-episode-head" },
      safeImageUrl(group.poster)
        ? el("img", {
            class: "discover-poster small",
            src: safeImageUrl(group.poster),
            alt: "",
            referrerpolicy: "no-referrer",
          })
        : el("span", { class: "discover-poster small placeholder", html: icon("film") }),
      el(
        "div",
        { class: "discover-episode-info" },
        el("div", { class: "discover-episode-title", text: group.title }),
        el("div", {
          class: "discover-meta",
          text: [group.year, group.remarks, `${group.entries.length} 个源`].filter(Boolean).join(" · "),
        }),
      ),
    );

    const preferredSources = new Set(["魔都资源", "ikun资源", "360资源", "无尽资源", "百度资源"]);
    const sortedEntries = [...group.entries].sort((a, b) => {
      const aPreferred = preferredSources.has(a.sourceName) ? 0 : 1;
      const bPreferred = preferredSources.has(b.sourceName) ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      const aDirect = a.item.episodes.some((episode) => /\.m3u8/i.test(episode.url)) ? 1 : 0;
      const bDirect = b.item.episodes.some((episode) => /\.m3u8/i.test(episode.url)) ? 1 : 0;
      if (aDirect !== bDirect) return bDirect - aDirect;
      return b.item.episodes.length - a.item.episodes.length;
    });
    const entry = selectedEntry || sortedEntries[0];
    const picker = el("div", { class: "source-picker" });
    for (const candidate of sortedEntries) {
      const direct = candidate.item.episodes.some((episode) => /\.m3u8/i.test(episode.url));
      const chip = el(
        "button",
        {
          class: `source-chip ${candidate === entry ? "active" : ""}`,
          type: "button",
          title: candidate.item.title,
        },
        el("span", { text: candidate.sourceName }),
        el("span", {
          class: "source-chip-meta",
          text: `${candidate.item.episodes.length} 集${direct ? " · 直链" : ""}`,
        }),
      );
      chip.addEventListener("click", () => renderGroupEpisodes(group, candidate));
      picker.append(chip);
    }

    const list = el("div", { class: "episode-list" });
    for (const episode of entry.item.episodes) {
      const button = el("button", {
        class: "episode-chip",
        type: "button",
        text: episode.name,
        title: `${entry.sourceName} · ${episode.url}`,
      });
      button.addEventListener("click", () => {
        modal.close();
        const episodes = entry.item.episodes.filter((item) => /^https?:\/\//i.test(item.url));
        startResolve({
          mode,
          initialUrl: episode.url,
          initialCookies: cookieInput.value,
          autoStart: true,
          preferredTitle: group.title,
          preferredPoster: group.poster,
          playlist: episodes.map((item) => ({ title: item.name, url: item.url })),
          playlistIndex: Math.max(
            0,
            episodes.findIndex((item) => item.url === episode.url),
          ),
        });
      });
      list.append(button);
    }
    resultsNode.append(
      back,
      head,
      el("div", { class: "episode-hint", text: "选择一个片源线路，再点一集推送到房间。" }),
      picker,
      list,
    );
  };

  const doSearch = async () => {
    if (searching) return;
    const query = input.value.trim();
    if (!query) {
      setStatus("先输入片名或演员", true);
      input.focus();
      return;
    }
    searching = true;
    searchButton.disabled = true;
    searchButton.innerHTML = `${icon("loader", "spin")} 搜索中…`;
    resultsNode.innerHTML = "";
    setStatus("正在搜索资源站…");
    try {
      const data = await withAccess(() => api.discoverSearch(query));
      sources = Array.isArray(data.sources) ? data.sources : [];
      renderAggregated(sources);
    } catch (error) {
      setStatus(error.message || "搜索失败", true);
    } finally {
      searching = false;
      searchButton.disabled = false;
      searchButton.innerHTML = `${icon("search")} 搜索`;
    }
  };

  searchButton.addEventListener("click", doSearch);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      doSearch();
    }
  });
  manageButton.addEventListener("click", () =>
    openSourceManager(() => {
      resultsNode.innerHTML = "";
      setStatus("片源已更新，重新搜索试试");
    }),
  );
  setTimeout(() => input.focus(), 80);
}

// ---------------------------------------------------------------------------
// 直播：频道列表 + 导入（粘贴列表 / 列表链接 / 单个频道）
// ---------------------------------------------------------------------------

/** 频道里解析出的 UA/Referer 传给服务端，代理转发和 sniff 时用。 */
function liveHeadersFor(channel) {
  const headers = {};
  if (channel?.ua) headers["user-agent"] = channel.ua;
  if (channel?.referer) headers.referer = channel.referer;
  return headers;
}

/** 从任意地方（首页/房间里）用直链开一间直播房。 */
async function openDirectRoom(url, extra = {}) {
  const name = await getSelfName();
  if (!name) return false;
  try {
    const result = await withAccess(() => api.createDirectRoom(name, url, extra));
    setHostToken(result.code, result.hostToken);
    setMemberToken(result.code, result.memberToken);
    saveRecent({ code: result.code, title: result.state?.video?.title || "" });
    navigate(`/r/${result.code}`);
    return true;
  } catch (error) {
    toast(error.message || "开房失败", { type: "error" });
    return false;
  }
}

function openLiveTV({ mode = "create", onPicked = null } = {}) {
  const input = el("input", {
    class: "input",
    type: "search",
    maxlength: "40",
    placeholder: "搜索频道，例如：CCTV",
    autocomplete: "off",
  });
  const importButton = el("button", {
    class: "btn btn-primary",
    type: "button",
    html: `${icon("plus")} 导入`,
  });
  const manageButton = el("button", {
    class: "link-btn",
    type: "button",
    html: `${icon("settings")} 管理直播源`,
  });
  const builtinButton = el("button", {
    class: "link-btn",
    type: "button",
    html: `${icon("sparkles")} 内置源`,
  });
  const statusNode = el("div", { class: "discover-status" });
  const channelsNode = el("div", { class: "live-channels" });
  const body = el(
    "div",
    { class: "discover" },
    el("div", { class: "discover-search" }, input, importButton),
    el(
      "div",
      { class: "discover-manage-row" },
      el("p", {
        class: "discover-hint",
        text: mode === "change" ? "点一个频道，房间里马上换台。" : "点频道就能和 TA 一起看直播；同一列表里的频道可以在房间里互相换台。",
      }),
      el("div", { class: "settings-inline" }, builtinButton, manageButton),
    ),
    statusNode,
    channelsNode,
  );
  const modal = openModal({
    title: "看电视",
    body,
    wide: true,
    actions: [{ label: "关闭", kind: "ghost" }],
  });
  if (!modal) return;

  let sources = [];

  const setStatus = (text, isError = false) => {
    statusNode.textContent = text || "";
    statusNode.className = `discover-status ${isError ? "discover-error" : ""}`;
  };

  const render = () => {
    channelsNode.innerHTML = "";
    const query = input.value.trim().toLowerCase();
    if (!sources.length) {
      channelsNode.append(
        el("p", { class: "modal-text", text: "还没有直播源。导入一个 m3u / txt 频道列表就能开始。" }),
      );
      setStatus("");
      return;
    }
    let total = 0;
    let shown = 0;
    for (const source of sources) {
      const channels = source.channels.filter((channel) =>
        !query || channel.name.toLowerCase().includes(query) || (channel.group || "").toLowerCase().includes(query),
      );
      if (!channels.length) continue;
      total += source.channels.length;
      shown += channels.length;
      const group = el(
        "div",
        { class: "live-group" },
        el(
          "div",
          { class: "live-group-head" },
          el("span", { class: "live-group-name", text: source.name }),
          el("span", { class: "live-group-count", text: `${source.channels.length} 个频道` }),
        ),
      );
      const grid = el("div", { class: "episode-list live-grid" });
      for (const channel of channels) {
        const logo = safeImageUrl(channel.logo);
        const card = el(
          "button",
          { class: "episode-chip live-chip", type: "button", title: channel.url },
          logo ? el("img", { class: "live-logo", src: logo, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : null,
          el("span", { class: "live-chip-name", text: channel.name }),
          channel.group ? el("span", { class: "live-chip-group", text: channel.group }) : null,
        );
        card.addEventListener("click", () => {
          if (mode === "change") {
            onPicked?.(channel, source);
            modal.close();
            return;
          }
          modal.close();
          const list = source.channels.map((item) => ({
            title: item.name,
            url: item.url,
            isLive: true,
            ua: item.ua || "",
            referer: item.referer || "",
          }));
          const index = Math.max(0, source.channels.findIndex((item) => item.id === channel.id));
          openDirectRoom(channel.url, {
            live: true,
            title: channel.name,
            headers: liveHeadersFor(channel),
            playlist: list,
            playlistIndex: index,
          });
        });
        grid.append(card);
      }
      group.append(grid);
      channelsNode.append(group);
    }
    if (!shown) {
      channelsNode.append(el("p", { class: "modal-text", text: "没有匹配的频道，换个关键词试试。" }));
    }
    setStatus(query ? `匹配 ${shown} 个频道` : `共 ${total} 个频道`);
  };

  const load = async () => {
    channelsNode.innerHTML = "";
    channelsNode.append(el("div", { class: "discover-status", text: "正在读取直播源…" }));
    let loadError = "";
    try {
      const data = await withAccess(() => api.liveSources());
      sources = Array.isArray(data.sources) ? data.sources : [];
      if (!sources.length) {
        // First run: fetch the built-in public TV list server-side so the
        // viewer can click a channel immediately instead of importing an m3u.
        channelsNode.innerHTML = "";
        channelsNode.append(el("div", { class: "discover-status", text: "首次使用，正在加载内置直播源…" }));
        try {
          const built = await withAccess(() => api.loadBuiltinLive());
          sources = Array.isArray(built.sources) ? built.sources : [];
        } catch (error) {
          loadError = error.message || "内置直播源加载失败，可以手动导入 m3u";
        }
      }
      render();
      if (loadError) setStatus(loadError, true);
    } catch (error) {
      channelsNode.innerHTML = "";
      channelsNode.append(
        el("p", { class: "discover-status discover-error", text: error.message || "读取直播源失败" }),
      );
    }
  };

  importButton.addEventListener("click", () =>
    openLiveImport(() => {
      load();
    }),
  );
  manageButton.addEventListener("click", () =>
    openLiveManager(() => {
      load();
    }),
  );
  builtinButton.addEventListener("click", async () => {
    builtinButton.disabled = true;
    setStatus("正在加载内置直播源…");
    try {
      const data = await withAccess(() => api.loadBuiltinLive());
      sources = Array.isArray(data.sources) ? data.sources : sources;
      render();
    } catch (error) {
      setStatus(error.message || "内置直播源加载失败，可以手动导入 m3u", true);
    } finally {
      builtinButton.disabled = false;
    }
  });
  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      render();
    }
  });
  load();
  setTimeout(() => input.focus(), 80);
}

/** 导入弹窗：粘贴列表 / 列表链接 / 单个频道三种方式。 */
function openLiveImport(onImported) {
  const nameInput = el("input", {
    class: "input",
    placeholder: "直播源名称，例如：央卫全套",
    maxlength: "40",
    autocomplete: "off",
  });
  const errorNode = el("p", { class: "form-error" });

  // 方式一：粘贴 m3u / txt 内容
  const textArea = el("textarea", {
    class: "input textarea",
    rows: "7",
    placeholder:
      "粘贴 m3u / txt 频道列表内容，例如：\n#EXTM3U\n#EXTINF:-1 group-title=\"央视\",CCTV1\nhttps://example.com/cctv1.m3u8\n也支持「频道名,地址」每行一个的纯文本",
    spellcheck: "false",
  });
  const textPanel = el(
    "div",
    { class: "live-import-panel" },
    nameInput,
    textArea,
    el("button", {
      class: "btn btn-primary btn-block",
      type: "button",
      html: `${icon("plus")} 解析并导入`,
      onclick: async (event) => {
        const button = event.currentTarget;
        const name = nameInput.value.trim();
        if (!name) {
          errorNode.textContent = "请填写直播源名称";
          nameInput.focus();
          return;
        }
        if (!textArea.value.trim()) {
          errorNode.textContent = "先粘贴频道列表内容";
          textArea.focus();
          return;
        }
        errorNode.textContent = "";
        button.disabled = true;
        button.innerHTML = `${icon("loader", "spin")} 导入中…`;
        try {
          const data = await withAccess(() =>
            api.addLiveSource({ name, text: textArea.value }),
          );
          toast(`导入成功，共 ${data.source?.channels?.length || data.sources?.length || 0} 个频道`, {
            type: "success",
          });
          onImported?.();
          textArea.value = "";
          nameInput.value = "";
        } catch (error) {
          errorNode.textContent = error.message || "导入失败";
        } finally {
          button.disabled = false;
          button.innerHTML = `${icon("plus")} 解析并导入`;
        }
      },
    }),
  );

  // 方式二：列表链接（服务端抓取解析）
  const urlNameInput = el("input", {
    class: "input",
    placeholder: "直播源名称，例如：央卫全套",
    maxlength: "40",
    autocomplete: "off",
  });
  const urlInput = el("input", {
    class: "input",
    type: "url",
    placeholder: "https://example.com/live.m3u",
    autocomplete: "off",
    spellcheck: "false",
  });
  const urlPanel = el(
    "div",
    { class: "live-import-panel" },
    urlNameInput,
    urlInput,
    el("p", {
      class: "settings-hint",
      text: "服务器会抓取这个链接并解析里面的频道，列表文件最大 2MB。",
    }),
    el("button", {
      class: "btn btn-primary btn-block",
      type: "button",
      html: `${icon("plus")} 抓取并导入`,
      onclick: async (event) => {
        const button = event.currentTarget;
        const name = urlNameInput.value.trim();
        if (!name) {
          errorNode.textContent = "请填写直播源名称";
          urlNameInput.focus();
          return;
        }
        if (!/^https?:\/\//i.test(urlInput.value.trim())) {
          errorNode.textContent = "请输入 http(s) 开头的列表链接";
          urlInput.focus();
          return;
        }
        errorNode.textContent = "";
        button.disabled = true;
        button.innerHTML = `${icon("loader", "spin")} 抓取中…`;
        try {
          const data = await withAccess(() =>
            api.addLiveSource({ name, url: urlInput.value.trim() }),
          );
          toast(`导入成功，共 ${data.source?.channels?.length || 0} 个频道`, { type: "success" });
          onImported?.();
          urlInput.value = "";
          urlNameInput.value = "";
        } catch (error) {
          errorNode.textContent = error.message || "抓取失败";
        } finally {
          button.disabled = false;
          button.innerHTML = `${icon("plus")} 抓取并导入`;
        }
      },
    }),
  );

  // 方式三：单个频道（名称 + 地址）
  const channelNameInput = el("input", {
    class: "input",
    placeholder: "频道名，例如：CCTV1",
    maxlength: "60",
    autocomplete: "off",
  });
  const channelUrlInput = el("input", {
    class: "input",
    type: "url",
    placeholder: "https://example.com/cctv1.m3u8",
    autocomplete: "off",
    spellcheck: "false",
  });
  const sourceSelect = el("select", { class: "input" });
  const singlePanel = el(
    "div",
    { class: "live-import-panel" },
    sourceSelect,
    channelNameInput,
    channelUrlInput,
    el("button", {
      class: "btn btn-primary btn-block",
      type: "button",
      html: `${icon("plus")} 添加频道`,
      onclick: async (event) => {
        const button = event.currentTarget;
        const name = channelNameInput.value.trim();
        const url = channelUrlInput.value.trim();
        if (!name) {
          errorNode.textContent = "请填写频道名";
          channelNameInput.focus();
          return;
        }
        if (!/^https?:\/\//i.test(url)) {
          errorNode.textContent = "请输入 http(s) 开头的频道地址";
          channelUrlInput.focus();
          return;
        }
        const target = sourceSelect.value;
        errorNode.textContent = "";
        button.disabled = true;
        button.innerHTML = `${icon("loader", "spin")} 添加中…`;
        try {
          if (target === "__new__") {
            const data = await withAccess(() => api.addLiveSource({ name, channels: [{ name, url }] }));
            toast(`已创建「${data.source?.name}」并添加频道`, { type: "success" });
          } else {
            await withAccess(() => api.addLiveChannel(target, { name, url }));
            toast("频道已添加", { type: "success" });
          }
          onImported?.();
          channelNameInput.value = "";
          channelUrlInput.value = "";
          refreshSourceSelect();
        } catch (error) {
          errorNode.textContent = error.message || "添加失败";
        } finally {
          button.disabled = false;
          button.innerHTML = `${icon("plus")} 添加频道`;
        }
      },
    }),
  );

  const refreshSourceSelect = async () => {
    sourceSelect.innerHTML = "";
    sourceSelect.append(el("option", { value: "__new__", text: "新建直播源（用频道名）" }));
    try {
      const data = await withAccess(() => api.liveSources());
      for (const source of data.sources || []) {
        sourceSelect.append(el("option", { value: source.id, text: `${source.name}（${source.count}）` }));
      }
    } catch {
      // 下拉拉不到就算了，用户还能新建
    }
  };

  let activePanel = "text";
  const panels = { text: textPanel, url: urlPanel, single: singlePanel };
  const tabBar = el("div", { class: "live-import-tabs" });
  const tabs = [
    { key: "text", label: "粘贴列表" },
    { key: "url", label: "列表链接" },
    { key: "single", label: "单个频道" },
  ];
  const paintTabs = () => {
    tabBar.innerHTML = "";
    for (const tab of tabs) {
      const button = el("button", {
        class: `live-import-tab ${activePanel === tab.key ? "active" : ""}`,
        type: "button",
        text: tab.label,
      });
      button.addEventListener("click", () => {
        activePanel = tab.key;
        errorNode.textContent = "";
        paintTabs();
        paintPanel();
      });
      tabBar.append(button);
    }
  };
  const paintPanel = () => {
    for (const [key, panel] of Object.entries(panels)) {
      panel.hidden = key !== activePanel;
    }
  };

  const body = el(
    "div",
    { class: "live-import" },
    tabBar,
    el("p", {
      class: "modal-text",
      text: "支持 m3u / txt 频道列表，也支持 TVBox 风格的 JSON。导入后点频道就能开播。",
    }),
    textPanel,
    urlPanel,
    singlePanel,
    errorNode,
  );
  const modal = openModal({
    title: "导入直播源",
    body,
    wide: true,
    actions: [{ label: "完成", kind: "ghost" }],
  });
  if (!modal) return;
  paintTabs();
  paintPanel();
  refreshSourceSelect();
}

/** 直播源管理：删源、删频道、往已有源里加频道。 */
function openLiveManager(onUpdated) {
  const listNode = el("div", { class: "source-list" });
  const body = el(
    "div",
    { class: "source-manager" },
    el("p", {
      class: "modal-text",
      text: "管理导入过的直播源和频道。删除频道不会影响其他源。",
    }),
    listNode,
  );
  const modal = openModal({ title: "直播源管理", body, wide: true, actions: [{ label: "关闭", kind: "ghost" }] });
  if (!modal) return;

  const render = (sources) => {
    listNode.innerHTML = "";
    if (!sources.length) {
      listNode.append(el("p", { class: "modal-text", text: "还没有导入过直播源。" }));
      return;
    }
    for (const source of sources) {
      const row = el(
        "div",
        { class: "source-row" },
        el(
          "div",
          { class: "source-row-main" },
          el("span", { class: "source-row-name", text: source.name }),
          el("span", { class: "source-row-api", text: `${source.count} 个频道` }),
        ),
      );
      const remove = el("button", {
        class: "icon-btn source-delete",
        type: "button",
        "aria-label": `删除 ${source.name}`,
        title: "删除整个直播源",
        html: icon("x"),
      });
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          const data = await withAccess(() => api.deleteLiveSource(source.id));
          render(data.sources || []);
          onUpdated?.();
          toast("直播源已删除", { type: "success" });
        } catch (error) {
          toast(error.message || "删除失败", { type: "error" });
          remove.disabled = false;
        }
      });
      row.append(remove);
      listNode.append(row);
    }
  };

  const load = async () => {
    listNode.innerHTML = "";
    listNode.append(el("div", { class: "discover-status", text: "正在读取直播源…" }));
    try {
      const data = await withAccess(() => api.liveSources());
      render(data.sources || []);
    } catch (error) {
      listNode.innerHTML = "";
      listNode.append(el("p", { class: "discover-status discover-error", text: error.message || "读取失败" }));
    }
  };

  load();
}

// ---------------------------------------------------------------------------
// Resolve flow
// ---------------------------------------------------------------------------

function startResolve({
  mode = "create",
  initialUrl = "",
  initialCookies = "",
  autoStart = false,
  preferredTitle = "",
  preferredPoster = "",
  playlist = null,
  playlistIndex = 0,
} = {}) {
  const body = el("div", { class: "resolve-body" });
  const urlInput = el("input", {
    class: "input",
    type: "url",
    placeholder: "粘贴视频页链接，或 .m3u8 / .mp4 直链",
    value: initialUrl,
    autocomplete: "off",
    spellcheck: "false",
  });
  const cookieInput = el("textarea", {
    class: "input textarea",
    rows: "3",
    placeholder: "可选：Netscape 格式或 a=1; b=2（只用于解析和播放，不落盘）",
    text: initialCookies,
  });
  const errorNode = el("div", { class: "form-error" });
  const statusNode = el("div", { class: "resolve-status", hidden: true });
  const resultsNode = el("div", { class: "resolve-results" });
  const cookieDetails = el(
    "details",
    { class: "advanced" },
    el("summary", { text: "需要登录的站点？填 Cookie" }),
    cookieInput,
  );
  const inputWrap = el("div", { class: "input-with-icon", html: icon("link") });
  inputWrap.append(urlInput);
  const form = el(
    "div",
    { class: "resolve-form" },
    el("label", { class: "field-label", text: "影片链接" }),
    inputWrap,
    cookieDetails,
    errorNode,
    statusNode,
    resultsNode,
  );
  body.append(form);

  let closed = false;
  let resolvedToken = "";
  let selectedCandidate = "";
  let busy = false;
  let pollTimer = null;
  let consoleEl = null;
  let consoleLog = null;
  let consoleElapsed = null;
  let logCount = 0;

  const modal = openModal({
    title: mode === "create" ? "解析链接并开播" : "换一部影片",
    body,
    wide: true,
    closable: true,
    onClose: () => {
      closed = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    },
  });
  if (!modal) return;

  // 把嗅探阶段包装成命令行，看着像在跑脚本
  const STAGE_CMD = {
    start: "sniff",
    check: "head",
    page: "curl -sL",
    fetch: "curl -sL",
    direct: "ffprobe",
    probe: "probe",
    browser: "playwright",
    ytdlp: "yt-dlp -j",
    parse: "grep m3u8",
    merge: "ffmpeg -c copy",
    error: "exit",
  };

  function appendConsoleLine(stage, message, elapsed) {
    if (!consoleLog) return;
    consoleLog.querySelector(".console-typing")?.remove();
    const isError = stage === "error";
    const line = el("div", { class: `console-line ${isError ? "console-error" : ""}` });
    if (Number.isFinite(elapsed) && elapsed >= 100) {
      line.append(el("span", { class: "console-time", text: `${(elapsed / 1000).toFixed(1)}s` }));
    }
    line.append(el("span", { class: "console-prompt", text: isError ? "✗" : "❯" }));
    const cmd = STAGE_CMD[stage];
    if (cmd) line.append(el("span", { class: "console-cmd", text: cmd }));
    line.append(el("span", { class: "console-out", text: message }));
    consoleLog.append(line);
    appendTypingLine();
    consoleLog.scrollTop = consoleLog.scrollHeight;
  }

  function appendConsoleDone(text, ms) {
    if (!consoleLog) return;
    const line = el("div", { class: "console-line console-done" });
    line.append(el("span", { class: "console-prompt", text: "✓" }));
    line.append(el("span", { class: "console-out", text: `${text} · ${(ms / 1000).toFixed(1)}s` }));
    consoleLog.append(line);
    consoleLog.scrollTop = consoleLog.scrollHeight;
  }

  function appendTypingLine() {
    if (!consoleLog) return;
    const line = el("div", { class: "console-line console-typing" });
    line.append(el("span", { class: "console-prompt", text: "❯" }));
    line.append(el("span", { class: "console-cursor", text: "▊" }));
    consoleLog.append(line);
  }

  function buildConsole() {
    statusNode.hidden = false;
    statusNode.innerHTML = "";
    consoleLog = el("pre", { class: "console-log" });
    consoleElapsed = el("span", { class: "console-elapsed", text: "0.0s" });
    consoleEl = el(
      "details",
      { class: "resolve-console", open: "" },
      el(
        "summary",
        { class: "console-head" },
        el("span", { class: "console-title" }, el("span", { class: "spinner spinner-xs" }), "嗅探过程"),
        consoleElapsed,
      ),
      consoleLog,
    );
    statusNode.append(consoleEl);
    logCount = 0;
    appendConsoleLine("start", "等待任务启动…");
  }

  function setBusy(value) {
    busy = value;
    urlInput.disabled = value;
    cookieInput.disabled = value;
    parseButton.disabled = value;
    parseButton.innerHTML = value ? `${icon("loader", "spin")} 解析中…` : `${icon("search")} 开始解析`;
    if (value) {
      buildConsole();
    } else if (consoleEl) {
      consoleEl.querySelector(".spinner")?.remove();
      consoleLog?.querySelector(".console-typing")?.remove();
      // 结果出来后把日志收起来，别让它抢走注意力
      setTimeout(() => consoleEl?.removeAttribute("open"), 600);
    }
  }

  function renderJobLogs(logs) {
    if (!consoleLog) return;
    for (let index = logCount; index < logs.length; index += 1) {
      const item = logs[index] || {};
      appendConsoleLine(item.stage, item.message, item.t);
    }
    logCount = logs.length;
  }

  function showResolveError(error) {
    const message = error?.message || "解析失败";
    errorNode.textContent = message;
    appendConsoleLine("error", message, undefined);
    const hints = Array.isArray(error?.hints) ? error.hints : [];
    if (hints.length) {
      const list = el("ul", { class: "hint-list" });
      for (const hint of hints) list.append(el("li", { text: hint }));
      resultsNode.append(list);
    }
    resultsNode.append(
      el(
        "div",
        { class: "resolve-tips" },
        el("p", { text: "可以试试：" }),
        el("ul", {}, [
          el("li", { text: "确认链接在浏览器里能直接播放（会员/登录内容需要填 Cookie）" }),
          el("li", { text: "直接粘贴 .m3u8 或 .mp4 直链，跳过页面嗅探" }),
          el("li", { text: "DRM 加密（Netflix 等）无法播放，这是版权保护机制" }),
        ]),
      ),
    );
  }

  async function pollResolveJob(jobId) {
    if (closed) return;
    let data;
    try {
      data = await withAccess(() => api.getResolveJob(jobId));
    } catch (error) {
      if (closed) return;
      setBusy(false);
      parseButton.innerHTML = `${icon("search")} 再试一次`;
      showResolveError(error);
      return;
    }
    if (closed) return;
    renderJobLogs(data.logs || []);
    if (consoleElapsed) consoleElapsed.textContent = `${(data.elapsedMs / 1000).toFixed(1)}s`;
    if (data.status === "done") {
      setBusy(false);
      resolvedToken = data.result.token;
      appendConsoleDone(
        `找到 ${data.result.candidates?.length || 0} 个播放源`,
        data.elapsedMs,
      );
      renderResolveResults(data.result);
      parseButton.innerHTML = `${icon("refresh")} 重新解析`;
      return;
    }
    if (data.status === "error") {
      setBusy(false);
      parseButton.innerHTML = `${icon("search")} 再试一次`;
      showResolveError(data.error || {});
      return;
    }
    pollTimer = setTimeout(() => pollResolveJob(jobId), 600);
  }

  const parseButton = el("button", {
    class: "btn btn-primary",
    type: "button",
    html: `${icon("search")} 开始解析`,
  });
  parseButton.addEventListener("click", async () => {
    if (busy) return;
    const url = urlInput.value.trim();
    if (!url) {
      errorNode.textContent = "先粘贴一个链接";
      urlInput.focus();
      return;
    }
    errorNode.textContent = "";
    resultsNode.innerHTML = "";
    resolvedToken = "";
    selectedCandidate = "";
    setBusy(true);
    try {
      const job = await withAccess(() => api.startResolveJob(url, cookieInput.value));
      if (closed) return;
      await pollResolveJob(job.jobId);
    } catch (error) {
      if (closed) return;
      setBusy(false);
      parseButton.innerHTML = `${icon("search")} 再试一次`;
      showResolveError(error);
    }
  });

  function renderResolveResults(result) {
    resultsNode.innerHTML = "";
    const header = el(
      "div",
      { class: "resolve-result-head" },
      result.poster
        ? el("img", {
            class: "resolve-poster",
            src: safeImageUrl(result.poster),
            alt: "",
            referrerpolicy: "no-referrer",
            loading: "lazy",
          })
        : el("div", { class: "resolve-poster placeholder", html: icon("film") }),
      el(
        "div",
        { class: "resolve-result-info" },
        el("h4", { text: result.title || "未命名影片" }),
        el(
          "div",
          { class: "resolve-meta" },
          result.duration ? el("span", { text: formatDuration(result.duration) }) : null,
          el("span", { text: `${result.candidates.length} 个播放源` }),
          result.isLive ? el("span", { class: "badge-inline", text: "直播" }) : null,
        ),
        result.note ? el("p", { class: "resolve-note", text: result.note }) : null,
      ),
    );

    const options = el("div", { class: "source-options", role: "radiogroup", "aria-label": "播放源" });
    let index = 0;
    for (const candidate of result.candidates) {
      const input = el("input", {
        type: "radio",
        name: "source",
        value: candidate.id,
        checked: candidate.recommended || false,
      });
      input.addEventListener("change", () => {
        selectedCandidate = candidate.id;
        confirmButton.disabled = false;
      });
      if (candidate.recommended) selectedCandidate = candidate.id;
      const disabled = candidate.kind === "merge";
      if (disabled) input.disabled = true;
      const kindLabel =
        candidate.kind === "hls" ? "M3U8" : candidate.kind === "file" ? mediaExtLabel(candidate.url) : "合并";
      const copyButton = el("button", {
        class: "source-copy",
        type: "button",
        html: icon("copy"),
        title: "复制播放地址",
        "aria-label": "复制播放地址",
      });
      copyButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!candidate.url) return;
        const ok = await copyText(candidate.url);
        toast(ok ? "播放地址已复制" : "复制失败", { type: ok ? "success" : "error" });
      });
      const option = el(
        "label",
        { class: `source-option ${candidate.recommended ? "recommended" : ""} ${disabled ? "disabled" : ""}` },
        input,
        el("span", { class: "source-index", text: String(index + 1) }),
        el(
          "span",
          { class: "source-main" },
          el(
            "span",
            { class: "source-label" },
            el("span", { class: "source-kind", text: kindLabel }),
            el("span", { text: candidate.label }),
            candidate.recommended ? el("span", { class: "pill", text: "推荐" }) : null,
            candidate.isLive ? el("span", { class: "pill pill-live", text: "直播" }) : null,
          ),
          candidate.url ? el("span", { class: "source-url", text: candidate.url }) : null,
          el(
            "span",
            { class: "source-sub" },
            [
              candidate.kind === "hls" ? "HLS" : candidate.kind === "file" ? "直连文件" : "需要合并",
              candidate.height ? `${candidate.height}P` : null,
              candidate.note || null,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ),
        candidate.url ? copyButton : null,
        el("span", { class: "source-check", html: icon("check") }),
      );
      options.append(option);
      index += 1;
    }

    if (!result.candidates.length) {
      resultsNode.append(el("p", { class: "form-error", text: "没有找到可播放的源" }));
      return;
    }

    resultsNode.append(
      header,
      el(
        "div",
        { class: "source-title" },
        el("span", { class: "source-dot" }),
        el("span", { text: `已发现 ${result.candidates.length} 个播放源` }),
      ),
      options,
    );

    modal.footer.innerHTML = "";
    const cancel = el("button", { class: "btn btn-ghost", type: "button", text: "取消" });
    cancel.addEventListener("click", () => modal.close());
    confirmButton = el("button", {
      class: "btn btn-primary",
      type: "button",
      html: `${icon("play")} ${mode === "create" ? "用这个源开播" : "换成这部"}`,
      disabled: !selectedCandidate,
    });
    confirmButton.addEventListener("click", confirmResolve);
    modal.footer.append(cancel, parseButton, confirmButton);
  }

  let confirmButton = null;

  async function confirmResolve() {
    if (!resolvedToken || !selectedCandidate) return;
    confirmButton.disabled = true;
    confirmButton.innerHTML = `${icon("loader", "spin")} 正在准备…`;
    try {
      if (mode === "change") {
        if (
          !state.ws?.send("setVideo", {
            token: resolvedToken,
            candidateId: selectedCandidate,
            title: preferredTitle,
            poster: preferredPoster,
          })
        ) {
          throw new Error("连接已断开，请稍后重试");
        }
        toast("正在切换影片…", { type: "success" });
        closed = true;
        modal.close();
        return;
      }
      const name = await getSelfName();
      if (!name) {
        confirmButton.disabled = false;
        confirmButton.innerHTML = `${icon("play")} 用这个源开播`;
        return;
      }
      const result = await withAccess(() =>
        api.createRoom(name, resolvedToken, selectedCandidate, {
          title: preferredTitle,
          poster: preferredPoster,
          playlist: playlist || undefined,
          playlistIndex,
        }),
      );
      setHostToken(result.code, result.hostToken);
      setMemberToken(result.code, result.memberToken);
      saveRecent({ code: result.code, title: result.state?.video?.title || "" });
      closed = true;
      modal.close();
      navigate(`/r/${result.code}`);
    } catch (error) {
      toast(error.message || "开播失败", { type: "error" });
      confirmButton.disabled = false;
      confirmButton.innerHTML = `${icon("play")} ${mode === "create" ? "用这个源开播" : "换成这部"}`;
    }
  }

  modal.footer.innerHTML = "";
  const cancel = el("button", { class: "btn btn-ghost", type: "button", text: "取消" });
  cancel.addEventListener("click", () => modal.close());
  modal.footer.append(cancel, parseButton);

  if (autoStart) setTimeout(() => parseButton.click(), 60);
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

async function enterRoom(code) {
  cleanupRoom();
  state.view = "room";
  state.code = code;
  renderLoading("正在进入放映室…");
  const accessOk = await ensureAccess();
  if (!accessOk) {
    navigate("/");
    return;
  }
  let roomInfo;
  try {
    roomInfo = await withAccess(() => api.getRoom(code));
  } catch (error) {
    renderFatal(error.message || "房间不存在或已过期", "让 TA 重新发一次邀请链接吧。");
    return;
  }
  const name = await getSelfName();
  if (!name) {
    navigate("/");
    return;
  }
  let joined;
  try {
    joined = await withAccess(() =>
      api.joinRoom(code, {
        name,
        hostToken: getHostToken(code),
        memberToken: getMemberToken(code),
      }),
    );
  } catch (error) {
    renderFatal(error.message || "加入房间失败");
    return;
  }
  setMemberToken(code, joined.memberToken);
  state.memberToken = joined.memberToken;
  state.hostToken = getHostToken(code);
  state.view = "room";
  renderRoomShell();
  applyRoomState(joined.state, { initial: true });
  saveRecent({ code, title: joined.state?.video?.title || roomInfo.title || "" });
  connectSocket();
}

function connectSocket() {
  if (!state.code || !state.memberToken) return;
  state.ws = new RoomSocket({
    code: state.code,
    token: state.memberToken,
    onMessage: handleSocketMessage,
    onStatus: handleSocketStatus,
    onAuthLost: rejoinRoom,
    // The server clears member.voice when the socket drops. If the mic was
    // already on, announce it again after a reconnect and re-negotiate peers.
    onOpen: () => {
      if (state.voice?.enabled) state.ws?.send("voiceOn", {});
    },
  });
  state.ws.connect();
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = setInterval(() => {
    if (!state.ws || !state.player || !state.isHost) return;
    const video = refs.video;
    if (!video || !state.video) return;
    state.ws.send("heartbeat", { position: video.currentTime, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
  }, 2000);
}

async function rejoinRoom() {
  if (state.reconnecting || state.view !== "room") return;
  state.reconnecting = true;
  try {
    const name = storedName() || "访客";
    const joined = await withAccess(() =>
      api.joinRoom(state.code, { name, hostToken: getHostToken(state.code) }),
    );
    setMemberToken(state.code, joined.memberToken);
    state.memberToken = joined.memberToken;
    state.ws?.close();
    state.ws = null;
    applyRoomState(joined.state, { initial: true });
    connectSocket();
  } catch (error) {
    toast("重新加入房间失败，请刷新页面", { type: "error", duration: 5000 });
  } finally {
    state.reconnecting = false;
  }
}

function handleSocketStatus(status) {
  state.connection = status;
  const dot = refs.connDot;
  const text = refs.connText;
  if (status === "open") {
    state.chat?.setDisabled(false);
    // 重连后服务端可能还留着旧的「缓冲中」标记（断线期间的恢复上报丢了），
    // 本地既然没在缓冲，主动补发一次 false，对方不用等 12 秒兜底。
    if (state.bufferSent) {
      state.bufferSent = false;
      if (state.bufferOnTimer) {
        clearTimeout(state.bufferOnTimer);
        state.bufferOnTimer = null;
      }
      if (state.bufferOffTimer) {
        clearTimeout(state.bufferOffTimer);
        state.bufferOffTimer = null;
      }
      state.ws?.send("buffering", { buffering: false });
    }
  } else state.chat?.setDisabled(true);
  if (!dot || !text) return;
  dot.className = `conn-dot ${status}`;
  if (status === "open") text.textContent = "已连接";
  else if (status === "connecting") text.textContent = "连接中";
  else if (status === "reconnecting") text.textContent = "重连中";
  else if (status === "replaced") {
    text.textContent = "已在其他窗口打开";
    toast("这个房间已在另一个窗口打开", { type: "info" });
  } else text.textContent = "已断开";
  updateSyncBadge();
}

function handleSocketMessage(message) {
  switch (message.type) {
    case "init":
      applyRoomState(message.state, { initial: true });
      // 房间无人时会休眠：进度定格、聊天留存。回来时提示一句从哪儿接着看。
      if (message.state?.wokeAt && Date.now() - message.state.wokeAt < 15000) {
        const resumeAt = Number(message.state?.playback?.position) || 0;
        if (resumeAt > 5) {
          toast(`已恢复上次的进度 ${formatTime(resumeAt)}，点播放继续`, { duration: 5200 });
        }
      }
      break;
    case "playback":
      if (message.action === "video") break;
      state.playback = {
        playing: Boolean(message.playing),
        position: Number(message.position) || 0,
        rate: Number(message.rate) || 1,
        // 消息里的时间是发送那一刻的位置，得记下发车时间才能补上网络延迟。
        at: Number(message.at) || Date.now(),
        // auto-wait 的暂停只翻状态不跳位置，见 player.applyPlayback
        reason: typeof message.reason === "string" ? message.reason : "",
      };
      state.player?.applyPlayback(state.playback);
      updatePlaybackUI();
      break;
    case "subtitle":
      applySubtitle(message.subtitle);
      break;
    case "voicePeers":
      ensureVoice().handlePeers(message.peers || []);
      break;
    case "voiceSignal":
      ensureVoice().handleSignal({ from: message.from, data: message.data });
      break;
    case "voiceState":
      ensureVoice().handleState({ memberId: message.memberId, on: Boolean(message.on) });
      break;
    case "sync":
      state.playback = {
        playing: Boolean(message.playing),
        position: Number(message.position) || 0,
        rate: Number(message.rate) || 1,
        at: Number(message.at) || Date.now(),
      };
      state.lastSyncAt = Date.now();
      if (!state.localBuffering && !state.dragging) {
        state.player?.applySync(state.playback, { force: Boolean(message.requested) });
      }
      updateSyncBadge();
      break;
    case "video":
      // 无论新片子有没有剧集列表，都重置状态：否则上一部的选集按钮
      // 会残留着，点开还是旧列表。
      state.playlist = message.playlist || null;
      updatePlaylistUI();
      handleVideoChange(message.video);
      break;
    case "members":
      state.members = message.members || [];
      state.hostId = message.hostId;
      state.hostOnline = Boolean(message.hostOnline);
      const me = state.members.find((member) => member.id === state.me?.id);
      if (me) {
        state.me = { ...state.me, ...me };
        state.isHost = Boolean(me.isHost);
      }
      state.chat?.setOnlineCount(state.members.filter((member) => member.online).length);
      updateMembersUI();
      updatePartnerStatus();
      updatePermissions();
      break;
    case "chat":
      if (message.message) {
        const msg = message.message;
        state.chat?.addMessage(msg);
        // 默认把聊天消息飘成弹幕（白色/适中）；系统消息不飘
        if (msg && !msg.system && msg.text) {
          pushDanmaku(msg.text, msg.name, Boolean(msg.mine || msg.memberId === state.me?.id));
        }
        if (isFullscreenActive()) {
          if (state.fsChatCollapsed) {
            state.fsChatUnread = (state.fsChatUnread || 0) + 1;
            updateUnreadBadge();
          } else {
            renderFullscreenChat();
          }
        }
        if (!isTabVisible()) {
          state.unread += 1;
          setDocumentTitle(state.video?.title ? `${state.video.title} · 两人放映室` : "两人放映室 · 异地同步看片");
        }
      }
      break;
    case "typing":
      state.chat?.setTyping(message.memberId, message.name, message.typing);
      break;
    case "settings":
      state.settings = message.settings || state.settings;
      updateSettingsUI();
      updatePermissions();
      break;
    case "controlRequest":
      // 只有主持人才该收到。弹出批准/拒绝。
      if (!state.isHost) break;
      showControlRequestPrompt({
        fromId: message.fromId,
        fromName: message.fromName || "对方",
        action: message.action,
        position: Number(message.position) || 0,
        rate: Number(message.rate) || 1,
      });
      break;
    case "controlResponse":
      if (message.approved) {
        toast(`${message.by || "主持人"} 已同意你的请求`, { type: "success" });
      } else if (message.reason === "host_offline") {
        toast("主持人不在，暂时没法批准", { type: "error" });
      } else {
        toast(`${message.by || "主持人"} 拒绝了你的请求`, { type: "info" });
      }
      break;
    case "error":
      toast(message.message || "操作失败", { type: "error" });
      break;
    case "pong":
      // 用往返时间校正本机时钟，避免两端时间差被算成播放进度差
      state.player?.setClockOffset(state.ws?.clockOffset || 0);
      break;
    default:
      break;
  }
}

function handleVideoChange(video) {
  state.video = video;
  state.playback = { playing: false, position: 0, rate: 1 };
  if (!video) {
    state.player?.load(null);
    state.loadedVideoId = null;
    updateNowPlaying();
    return;
  }
  state.loadedVideoId = video.id;
  state.player?.load(video);
  updateNowPlaying();
  updatePlaybackUI();
  renderRoomTitle();
  toast(`已切换到《${video.title}》`, { type: "success" });
}

function applyRoomState(roomState, { initial = false } = {}) {
  if (!roomState) return;
  state.me = roomState.you;
  state.isHost = Boolean(roomState.you?.isHost);
  state.members = roomState.members || [];
  state.hostId = roomState.hostId;
  state.iceServers = roomState.iceServers || null;
  state.hostOnline = Boolean(roomState.hostOnline);
  state.settings = roomState.settings || state.settings;
  state.playback = roomState.playback || state.playback;
  state.lastSyncAt = Date.now();
  state.video = roomState.video;
  state.playlist = roomState.playlist || null;
  applySubtitle(roomState.subtitle || null);
  updatePlaylistUI();
  state.chat?.setSelf({ id: roomState.you.id, name: roomState.you.name });
  state.chat?.setMessages(roomState.chat || []);
  state.chat?.setOnlineCount(state.members.filter((member) => member.online).length);

  updateRoomHeader();
  updateMembersUI();
  updatePartnerStatus();
  updateSettingsUI();
  updatePermissions();

  if (roomState.video) {
    if (state.loadedVideoId !== roomState.video.id) {
      state.loadedVideoId = roomState.video.id;
      state.player?.load(roomState.video);
    }
    updateNowPlaying();
    updatePlaybackUI();
    state.player?.applyPlayback(state.playback, { initial: true });
  } else {
    state.loadedVideoId = null;
    state.player?.load(null);
    updateNowPlaying();
    updatePlaybackUI();
  }
  renderRoomTitle();
  if (initial) clearUnread();
}

function renderRoomShell() {
  const app = appRoot();
  app.className = "app room-app";
  app.innerHTML = `
    <header class="room-head">
      <button class="icon-btn" id="btn-back" type="button" aria-label="返回首页" title="返回首页">${icon("arrow-left")}</button>
      <div class="room-head-copy">
        <div class="room-name" id="room-title">放映室</div>
        <div class="room-meta">
          <span id="conn-dot" class="conn-dot closed"></span>
          <span id="conn-text">连接中</span>
          <span class="meta-sep">·</span>
          <button id="room-code" class="code-chip" type="button" title="复制房间码">------</button>
          <span class="meta-sep">·</span>
          <span id="online-count">0 人在线</span>
        </div>
      </div>
      <div class="room-head-actions">
        <div class="member-stack" id="member-stack"></div>
        <button class="btn btn-ghost btn-sm invite-btn" id="btn-invite" type="button" aria-label="邀请 TA">${icon("link")} <span>邀请 TA</span></button>
        <button class="icon-btn" id="btn-settings" type="button" aria-label="设置" title="设置">${icon("settings")}</button>
      </div>
    </header>
    <main class="room-main">
      <section class="stage-section">
        <div class="stage" id="stage">
          <video id="video" playsinline preload="metadata"></video>
          <div class="stage-empty" id="stage-empty">
            <div class="empty-icon">${icon("film")}</div>
            <h2>今晚看点什么？</h2>
            <p id="empty-copy">主持人添加影片后，就能一起开始。</p>
            <button class="btn btn-primary" id="btn-empty-add" type="button">${icon("plus")} 添加影片</button>
          </div>
          <div class="stage-overlay" id="stage-overlay" hidden>
            <button class="big-play" id="btn-big-play" type="button" aria-label="播放">${icon("play")}</button>
            <p id="overlay-text">点击加入同步播放</p>
          </div>
          <div class="stage-loading" id="stage-loading" hidden>
            <span class="spinner"></span><span>正在加载视频…</span>
          </div>
          <div class="stage-badges">
            <div class="badge" id="sync-badge"><span class="badge-dot"></span><span id="sync-text">未开始</span></div>
            <div class="badge badge-warn" id="buffer-badge" hidden><span class="badge-dot"></span><span id="buffer-text">TA 正在缓冲…</span></div>
            <div class="badge badge-live" id="live-badge" hidden>直播</div>
          </div>
          <div class="controls" id="controls">
            <div class="seek-wrap">
              <div class="seek-buffer" id="seek-buffer"></div>
              <input id="seek" class="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度">
            </div>
            <div class="control-row">
              <button class="icon-btn" id="btn-play" type="button" aria-label="播放/暂停">${icon("play")}</button>
              <button class="icon-btn hide-sm" id="btn-back10" type="button" aria-label="后退 10 秒" title="后退 10 秒">${icon("back10")}</button>
              <button class="icon-btn hide-sm" id="btn-fwd10" type="button" aria-label="前进 10 秒" title="前进 10 秒">${icon("forward10")}</button>
              <div class="time"><span id="time-current">0:00</span><span class="time-sep">/</span><span id="time-total">0:00</span></div>
              <div class="control-spacer"></div>
              <button class="text-btn" id="btn-quality" type="button">画质</button>
              <button class="text-btn" id="btn-speed" type="button">1×</button>
              <div class="volume-wrap hide-sm">
                <button class="icon-btn" id="btn-mute" type="button" aria-label="静音">${icon("volume")}</button>
                <input id="volume" class="volume" type="range" min="0" max="100" value="80" aria-label="音量">
              </div>
              <button class="icon-btn hide-sm" id="btn-pip" type="button" aria-label="画中画" title="画中画">${icon("pip")}</button>
              <button class="icon-btn" id="btn-fullscreen" type="button" aria-label="全屏" title="全屏">${icon("maximize")}</button>
            </div>
          </div>
          <div class="danmaku-layer" id="danmaku-layer" aria-hidden="true"></div>
          <div class="fs-chat" id="fs-chat" hidden>
            <div class="fs-chat-head">
              <span>放映室</span>
              <span class="fs-chat-count" id="fs-chat-count"></span>
              <button class="fs-chat-mini" id="fs-chat-collapse" type="button" aria-label="收起聊天" title="收起聊天">${icon("x")}</button>
            </div>
            <div class="fs-chat-list" id="fs-chat-list"></div>
            <form class="fs-chat-form" id="fs-chat-form">
              <input id="fs-chat-input" class="input" type="text" placeholder="说点什么…" autocomplete="off" maxlength="800" />
              <button class="btn btn-primary btn-sm" type="submit">发送</button>
            </form>
          </div>
          <button class="fs-chat-bubble" id="fs-chat-bubble" type="button" aria-label="打开聊天" hidden>
            ${icon("chat")}<span class="fs-chat-unread" id="fs-chat-unread" hidden></span>
          </button>
        </div>
        <div class="under-stage">
          <div class="now-playing">
            <div class="now-label">${icon("monitor-play")} 正在放映</div>
            <div class="now-title" id="now-title">还没有影片</div>
            <div class="now-meta" id="now-meta">把链接粘贴进来，自动嗅探高清播放地址</div>
          </div>
          <div class="under-actions">
            <button class="btn btn-ghost btn-sm" id="btn-skip-intro" type="button">${icon("refresh")} 同步</button>
            <button class="btn btn-ghost btn-sm" id="btn-discover-room" type="button">${icon("search")} 找片</button>
            <button class="btn btn-ghost btn-sm" id="btn-live-room" type="button">${icon("monitor-play")} 看电视</button>
            <button class="btn btn-ghost btn-sm" id="btn-add-video" type="button">${icon("plus")} 添加影片</button>
            <button class="btn btn-ghost btn-sm" id="btn-next-episode" type="button" hidden>${icon("film")} 选集</button>
            <input type="file" id="subtitle-input" accept=".srt,.vtt,text/vtt" hidden>
            <button class="btn btn-ghost btn-sm" id="btn-claim-host" type="button" hidden>${icon("crown")} 接管主持</button>
          </div>
        </div>
      </section>
      <aside class="chat-panel" id="chat-panel"></aside>
    </main>
    <div class="room-foot-note">${icon("shield")} 私人放映室 · 房间码只分享给 TA</div>
  `;

  refs.app = app;
  refs.video = app.querySelector("#video");
  refs.stage = app.querySelector("#stage");
  refs.fsChat = app.querySelector("#fs-chat");
  refs.fsChatList = app.querySelector("#fs-chat-list");
  refs.fsChatForm = app.querySelector("#fs-chat-form");
  refs.fsChatInput = app.querySelector("#fs-chat-input");
  refs.fsChatCount = app.querySelector("#fs-chat-count");
  refs.fsChatBubble = app.querySelector("#fs-chat-bubble");
  refs.fsChatUnread = app.querySelector("#fs-chat-unread");
  refs.danmaku = app.querySelector("#danmaku-layer");
  refs.fsChatCollapse = app.querySelector("#fs-chat-collapse");
  refs.controls = app.querySelector("#controls");
  refs.stageEmpty = app.querySelector("#stage-empty");
  refs.emptyCopy = app.querySelector("#empty-copy");
  refs.btnEmptyAdd = app.querySelector("#btn-empty-add");
  refs.stageOverlay = app.querySelector("#stage-overlay");
  refs.overlayText = app.querySelector("#overlay-text");
  refs.btnBigPlay = app.querySelector("#btn-big-play");
  refs.stageLoading = app.querySelector("#stage-loading");
  refs.syncBadge = app.querySelector("#sync-badge");
  refs.syncText = app.querySelector("#sync-text");
  refs.bufferBadge = app.querySelector("#buffer-badge");
  refs.bufferText = app.querySelector("#buffer-text");
  refs.liveBadge = app.querySelector("#live-badge");
  refs.seek = app.querySelector("#seek");
  refs.seekBuffer = app.querySelector("#seek-buffer");
  refs.btnPlay = app.querySelector("#btn-play");
  refs.btnBack10 = app.querySelector("#btn-back10");
  refs.btnFwd10 = app.querySelector("#btn-fwd10");
  refs.timeCurrent = app.querySelector("#time-current");
  refs.timeTotal = app.querySelector("#time-total");
  refs.btnQuality = app.querySelector("#btn-quality");
  refs.btnSpeed = app.querySelector("#btn-speed");
  refs.btnMute = app.querySelector("#btn-mute");
  refs.volume = app.querySelector("#volume");
  refs.btnPip = app.querySelector("#btn-pip");
  refs.btnFullscreen = app.querySelector("#btn-fullscreen");
  refs.nowTitle = app.querySelector("#now-title");
  refs.nowMeta = app.querySelector("#now-meta");
  refs.btnAddVideo = app.querySelector("#btn-add-video");
  refs.btnNextEpisode = app.querySelector("#btn-next-episode");
  refs.subtitleInput = app.querySelector("#subtitle-input");
  refs.btnSkipIntro = app.querySelector("#btn-skip-intro");
  refs.btnDiscoverRoom = app.querySelector("#btn-discover-room");
  refs.btnLiveRoom = app.querySelector("#btn-live-room");
  refs.btnClaimHost = app.querySelector("#btn-claim-host");
  refs.roomTitle = app.querySelector("#room-title");
  refs.roomCode = app.querySelector("#room-code");
  refs.onlineCount = app.querySelector("#online-count");
  refs.memberStack = app.querySelector("#member-stack");
  refs.connDot = app.querySelector("#conn-dot");
  refs.connText = app.querySelector("#conn-text");
  refs.chatPanel = app.querySelector("#chat-panel");
  refs.btnInvite = app.querySelector("#btn-invite");
  refs.btnSettings = app.querySelector("#btn-settings");
  refs.btnBack = app.querySelector("#btn-back");

  state.chat = new ChatView({
    root: refs.chatPanel,
    onSend: sendChat,
    onTyping: sendTyping,
    onImage: sendImage,
  });
  state.chat.setDisabled(true);

  // 连麦按钮放在聊天输入框旁边，跟"发图片/表情"并排，不再占播放器控件的位置
  refs.btnMic = el("button", {
    class: "icon-btn chat-emoji-btn chat-mic-btn",
    id: "btn-mic",
    type: "button",
    "aria-label": "连麦",
    title: "连麦",
    html: icon("mic-off"),
  });
  refs.btnMic.addEventListener("click", toggleVoice);
  state.chat.form?.insertBefore(refs.btnMic, state.chat.imageButton || null);

  state.player = new Player(refs.video, {
    onBrowserTakeover: () => {
      toast("浏览器接管了播放器。可在浏览器设置里关掉“网页视频播放”，或用 Chrome 打开", {
        type: "error",
        duration: 8000,
      });
    },
    onPaintFallback: () => {
      toast("你的浏览器限制了这个画法，已切回普通播放。要边看边聊，建议关掉浏览器的“网页视频播放”", {
        type: "info",
        duration: 8000,
      });
    },
    onTime: handleTimeUpdate,
    onDuration: () => updatePlaybackUI(),
    onLevels: (levels, current) => {
      state.levels = levels || [];
      state.currentLevel = current;
      updateQualityButton();
    },
    onLevel: (level, current) => {
      state.currentLevel = current;
      updateQualityButton();
    },
    onBuffering: handleLocalBuffering,
    onPlaying: () => {
      refs.stageLoading.hidden = true;
    },
    onPauseState: (playing) => {
      updatePlayButton();
      if (playing) refs.stageLoading.hidden = true;
    },
    onRateChange: (rate) => {
      updateSpeedButton();
    },
    onAutoplayBlocked: () => {
      showStageOverlay("点击加入同步播放");
    },
    onError: (message) => {
      refs.stageLoading.hidden = true;
      showStageOverlay(message, { showPlay: false });
      toast(message, { type: "error", duration: 5000 });
    },
    onTransientError: (message) => {
      toast(message, { type: "info" });
    },
    onEnded: () => {
      state.ws?.send("ended", {});
      // 有剧集列表时，主持人播完自动接下一集
      if (!state.playlist || !state.isHost) return;
      if (state.playlist.index + 1 >= state.playlist.total) return;
      state.ws?.send("nextEpisode", {});
    },
    onVolumeChange: () => updateVolumeUI(),
  });

  const rawVolume = localStorage.getItem(VOLUME_KEY);
  const savedVolume = rawVolume === null ? 0.8 : Number(rawVolume);
  const muted = localStorage.getItem(MUTED_KEY) === "1";
  const volume = Number.isFinite(savedVolume) ? clamp(savedVolume, 0, 1) : 0.8;
  refs.volume.value = String(Math.round(volume * 100));
  state.player.setVolume(volume, muted);
  state.player.setClockOffset(state.ws?.clockOffset || 0);

  bindRoomControls();
  updateVolumeUI();
  setupWakeLock();
}

// 屏幕常亮：小米浏览器长时间播 HLS 容易息屏，用 Wake Lock 顶住。
// 这个锁在页面切到后台 / 进入画中画时会被浏览器自动收回，所以每次回到前台、
// 每次开播、每次退出 PiP 都要重新申请一次。
let wakeLockObj = null;
let wakeLockWant = false;

async function acquireWakeLock() {
  if (!wakeLockWant) return;
  if (wakeLockObj || !("wakeLock" in navigator)) return;
  try {
    wakeLockObj = await navigator.wakeLock.request("screen");
    wakeLockObj.addEventListener("release", () => {
      wakeLockObj = null;
    });
  } catch {
    wakeLockObj = null;
  }
}

function setupWakeLock() {
  if (!("wakeLock" in navigator)) return;
  wakeLockWant = true;
  acquireWakeLock();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") acquireWakeLock();
    else wakeLockObj = null;
  });
  refs.video?.addEventListener("play", acquireWakeLock);
  document.addEventListener("exitpictureinpicture", acquireWakeLock);
}

function bindRoomControls() {
  refs.btnBack.addEventListener("click", leaveRoom);
  refs.roomCode.addEventListener("click", async (event) => {
    event.stopPropagation();
    const ok = await copyText(state.code);
    toast(ok ? `房间码 ${state.code} 已复制` : "复制失败，请长按选择", {
      type: ok ? "success" : "error",
    });
  });
  refs.btnSettings.addEventListener("click", openSettings);
  refs.btnInvite.addEventListener("click", invite);
  refs.memberStack.addEventListener("click", openMembers);
  refs.btnAddVideo.addEventListener("click", () => {
    if (!state.isHost) {
      toast("只有主持人可以添加或更换影片", { type: "info" });
      return;
    }
    startResolve({ mode: state.video ? "change" : "change" });
  });
  refs.btnEmptyAdd.addEventListener("click", () => {
    if (!state.isHost) {
      toast("等主持人添加影片吧", { type: "info" });
      return;
    }
    startResolve({ mode: "change" });
  });
  refs.btnSkipIntro.addEventListener("click", () => {
    if (!state.ws?.send("requestSync", {})) {
      toast("连接已断开，稍后再试", { type: "error" });
      return;
    }
    toast("已对齐到同一进度", { type: "success" });
  });
  refs.btnDiscoverRoom.addEventListener("click", () => {
    if (!state.isHost) {
      toast("只有主持人可以找片和换片", { type: "info" });
      return;
    }
    openDiscovery({ mode: "change" });
  });
  refs.btnLiveRoom.addEventListener("click", () => {
    if (!state.isHost) {
      toast("只有主持人可以换直播频道", { type: "info" });
      return;
    }
    openLiveTV({
      mode: "change",
      onPicked: (channel, source) => {
        const list = source.channels.map((item) => ({
          title: item.name,
          url: item.url,
          isLive: true,
          ua: item.ua || "",
          referer: item.referer || "",
        }));
        const ok = state.ws?.send("playDirect", {
          url: channel.url,
          title: channel.name,
          isLive: true,
          ua: channel.ua || "",
          referer: channel.referer || "",
          playlist: list,
        });
        if (!ok) toast("连接已断开，切换没有生效", { type: "error" });
      },
    });
  });
  refs.btnClaimHost.addEventListener("click", () => {
    state.ws?.send("claimHost", {});
  });
  refs.btnPlay.addEventListener("click", togglePlay);
  refs.btnBigPlay.addEventListener("click", async () => {
    if (!state.video) {
      if (state.isHost) startResolve({ mode: "change" });
      return;
    }
    refs.stageOverlay.hidden = true;
    state.player?.forcePlay?.();
  });
  refs.btnBack10.addEventListener("click", () => nudgeSeek(-10));
  refs.btnFwd10.addEventListener("click", () => nudgeSeek(10));
  refs.btnMute.addEventListener("click", () => {
    const video = refs.video;
    const muted = !video.muted;
    video.muted = muted;
    try {
      localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
    } catch {
      // ignore
    }
    updateVolumeUI();
  });
  refs.volume.addEventListener("input", () => {
    const value = Number(refs.volume.value) / 100;
    refs.video.muted = false;
    state.player.setVolume(value, false);
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
      localStorage.setItem(MUTED_KEY, "0");
    } catch {
      // ignore
    }
    updateVolumeUI();
  });
  refs.btnNextEpisode?.addEventListener("click", openEpisodeMenu);
  refs.subtitleInput?.addEventListener("change", async () => {
    const file = refs.subtitleInput.files?.[0];
    refs.subtitleInput.value = "";
    if (file) await loadSubtitleFile(file);
  });
  bindStageGestures();
  refs.btnPip.addEventListener("click", togglePictureInPicture);
  refs.btnFullscreen.addEventListener("click", toggleFullscreen);
  refs.btnQuality.addEventListener("click", openQualityMenu);
  refs.btnSpeed.addEventListener("click", openSpeedMenu);

  refs.seek.addEventListener("input", () => {
    if (!state.video) return;
    if (!canControl()) return;
    state.dragging = true;
    state.player.beginSeek();
    const duration = refs.video.duration || state.video.duration || 0;
    if (duration) refs.timeCurrent.textContent = formatTime((Number(refs.seek.value) / 1000) * duration);
  });
  refs.seek.addEventListener("change", () => {
    if (!state.video) return;
    state.dragging = false;
    const duration = refs.video.duration || state.video.duration || 0;
    const target = (Number(refs.seek.value) / 1000) * duration;
    if (needsRequest()) {
      requestControl("seek", { position: target });
      updatePlaybackUI();
      return;
    }
    state.player.endSeek(target);
    if (canControl()) state.ws?.send("seek", { position: target, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
    updatePlaybackUI();
  });

  document.addEventListener("fullscreenchange", syncFullscreenChat);
  refs.fsChatCollapse?.addEventListener("click", () => setFsChatCollapsed(true));
  refs.fsChatBubble?.addEventListener("click", () => setFsChatCollapsed(false));
  refs.fsChatForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = refs.fsChatInput.value.trim();
    if (!text) return;
    if (!state.ws?.send("chat", { text })) {
      toast("连接已断开，稍后再试", { type: "error" });
      return;
    }
    refs.fsChatInput.value = "";
  });

  refs.stage.addEventListener("click", (event) => {
    if (event.target.closest(".controls, .badge, button, input, .fs-chat, .fs-chat-bubble")) return;
    if (!state.video) return;
    if (!refs.stageOverlay.hidden) return;
    // 点画面只切控件显隐，不暂停。误触一下就把片子停掉太烦人。
    if (isFullscreenActive()) toggleStageControls();
  });

  // 鼠标/手指一动就把控件唤回来，停 3 秒不动再自动收起。
  // 不全屏时也一样：进度条不该一直占着画面。
  refs.stage.addEventListener("pointermove", () => {
    if (state.video) showStageControls();
  });
  refs.stage.addEventListener("pointerleave", (event) => {
    // 触摸抬起来时浏览器也会派发 pointerleave（指针不存在了），这时候
    // 立刻收控件会让紧接着合成的 click 落空——用户点播放/全屏按钮没反应。
    // 触摸场景交给 3.2s 不动定时器去收，鼠标划出画面才立即收。
    if (event.pointerType === "touch") return;
    if (state.video && !refs.video?.paused) hideStageControls();
  });

  refs.controls.addEventListener("pointerdown", () => showStageControls());
  refs.video.addEventListener("play", () => showStageControls());
  refs.video.addEventListener("pause", () => showStageControls({ keep: true }));

  refs.stage.addEventListener("dblclick", (event) => {
    if (event.target.closest(".controls, .badge, button, input")) return;
    toggleFullscreen();
  });

  refs.video.addEventListener("waiting", () => {
    if (state.video) refs.stageLoading.hidden = false;
  });
  refs.video.addEventListener("playing", () => {
    refs.stageLoading.hidden = true;
    refs.stageOverlay.hidden = true;
  });
  refs.video.addEventListener("canplay", () => {
    refs.stageLoading.hidden = true;
  });
}

function renderFullscreenChat() {
  const list = refs.fsChatList;
  if (!list) return;
  const messages = (state.chat?.messages || []).slice(-40);
  list.innerHTML = "";
  for (const message of messages) {
    if (message.system) {
      list.append(el("div", { class: "fs-msg fs-sys", text: message.text }));
      continue;
    }
    const row = el("div", { class: "fs-msg" });
    row.append(
      el("span", { class: "fs-name", text: message.name, style: `color:${message.color || "#fff"}` }),
    );
    row.append(el("span", { class: "fs-text", text: message.text || "[图片]" }));
    list.append(row);
  }
  if (refs.fsChatCount) {
    const online = (state.members || []).filter((member) => member.online).length;
    refs.fsChatCount.textContent = `${online} 人在线`;
  }
  list.scrollTop = list.scrollHeight;
}

function ensureVoice() {
  if (state.voice) return state.voice;
  state.voice = new VoiceChat({
    selfId: state.me?.id || "",
    iceServers: state.iceServers,
    send: (type, data) => state.ws?.send(type, data),
    onState: (enabled, peers) => {
      if (!refs.btnMic) return;
      refs.btnMic.classList.toggle("mic-on", enabled);
      refs.btnMic.innerHTML = icon(enabled ? "mic" : "mic-off");
      refs.btnMic.title = enabled
        ? peers > 0
          ? `连麦中 · ${peers + 1} 人在麦上`
          : "连麦中（等对方开麦）"
        : "连麦";
    },
    onError: (message) => toast(message, { type: "error", duration: 4000 }),
  });
  return state.voice;
}

async function toggleVoice() {
  const voice = ensureVoice();
  if (voice.enabled) {
    voice.disable();
    toast("已关闭麦克风", { type: "info", duration: 2000 });
    return;
  }
  await voice.enable();
  if (voice.enabled) {
    toast("麦克风已打开，对方开麦后就能通话。建议戴耳机，避免外放啸叫", {
      type: "success",
      duration: 4500,
    });
  }
}

// 主持人收到的「观众想控制播放」申请弹窗。同意后由主持人代为执行并广播。
let pendingRequest = null;

function ensureControlRequestEl() {
  let box = refs.app?.querySelector("#ctrl-req");
  if (box) return box;
  box = el("div", { class: "ctrl-req", id: "ctrl-req", hidden: true });
  box.innerHTML = `
    <div class="ctrl-req-card">
      <div class="ctrl-req-text" id="ctrl-req-text"></div>
      <div class="ctrl-req-actions">
        <button class="btn btn-primary btn-sm" id="ctrl-req-ok" type="button">同意</button>
        <button class="btn btn-ghost btn-sm" id="ctrl-req-no" type="button">拒绝</button>
      </div>
    </div>`;
  refs.app?.append(box);
  return box;
}

function showControlRequestPrompt(req) {
  pendingRequest = req;
  const box = ensureControlRequestEl();
  const labels = {
    play: "播放",
    pause: "暂停",
    seek: `跳到 ${formatTime(req.position)}`,
    rate: `调到 ${req.rate}×`,
  };
  box.querySelector("#ctrl-req-text").textContent = `${req.fromName} 想${labels[req.action] || "控制播放"}`;
  box.hidden = false;
  box.querySelector("#ctrl-req-ok").onclick = () => resolveControlRequest(true);
  box.querySelector("#ctrl-req-no").onclick = () => resolveControlRequest(false);
}

function resolveControlRequest(approved) {
  const req = pendingRequest;
  pendingRequest = null;
  const box = refs.app?.querySelector("#ctrl-req");
  if (box) box.hidden = true;
  if (!req) return;
  if (approved) {
    if (req.action === "play") doPlay(req.position);
    else if (req.action === "pause") doPause(req.position);
    else if (req.action === "seek") doSeek(req.position);
    else if (req.action === "rate") doRate(req.rate);
  }
  state.ws?.send("controlResponse", { to: req.fromId, approved, action: req.action });
}

// 手机上的手势：左边上下滑调亮度，右边上下滑调音量，横向滑快进
let gestureHudTimer = 0;
let stageBrightness = 1;

function showGestureHud(text) {
  const stage = refs.stage;
  if (!stage) return;
  let hud = stage.querySelector(".gesture-hud");
  if (!hud) {
    hud = el("div", { class: "gesture-hud" });
    stage.append(hud);
  }
  hud.textContent = text;
  hud.classList.add("show");
  clearTimeout(gestureHudTimer);
  gestureHudTimer = setTimeout(() => hud?.classList.remove("show"), 900);
}

function setStageBrightness(value) {
  const next = clamp(value, 0.25, 1);
  stageBrightness = next;
  refs.stage?.style.setProperty("--brightness", String(next));
}

function bindStageGestures() {
  const stage = refs.stage;
  if (!stage) return;
  let start = null;

  stage.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) return;
      if (event.target.closest(".controls, .fs-chat, .chat-panel, button, input, .danmaku")) return;
      const touch = event.touches[0];
      const rect = stage.getBoundingClientRect();
      start = {
        x: touch.clientX,
        y: touch.clientY,
        at: Date.now(),
        mode: "",
        left: touch.clientX - rect.left < rect.width / 2,
        volume: refs.video?.volume ?? 1,
        brightness: stageBrightness,
        time: refs.video?.currentTime || 0,
        seekTo: 0,
      };
    },
    { passive: true },
  );

  stage.addEventListener(
    "touchmove",
    (event) => {
      if (!start) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (!start.mode) {
        if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
        start.mode = Math.abs(dx) > Math.abs(dy) ? "seek" : "side";
      }
      if (start.mode === "side") {
        event.preventDefault();
        if (start.left) {
          const value = clamp(start.brightness - dy / 320, 0.25, 1);
          setStageBrightness(value);
          showGestureHud(`亮度 ${Math.round(value * 100)}%`);
        } else {
          const value = clamp(start.volume - dy / 320, 0, 1);
          refs.video.muted = false;
          state.player?.setVolume(value, false);
          updateVolumeUI();
          showGestureHud(`音量 ${Math.round(value * 100)}%`);
        }
        return;
      }
      if (start.mode === "seek") {
        event.preventDefault();
        const duration = refs.video?.duration || state.video?.duration || 0;
        const target = clamp(start.time + dx / 6, 0, duration || Infinity);
        start.seekTo = target;
        const diff = Math.round(target - start.time);
        showGestureHud(`${diff >= 0 ? "+" : ""}${diff}s / ${formatTime(target)}`);
      }
    },
    { passive: false },
  );

  const finish = (event) => {
    if (!start) return;
    if (start.mode === "seek" && Math.abs(start.seekTo - start.time) > 1) {
      state.player?.seekSafely(start.seekTo, { suppressBuffering: true });
      if (canControl()) state.ws?.send("seek", { position: start.seekTo });
      updatePlaybackUI();
    }
    if (start.mode === "") {
      // 没滑动就是点了一下：全屏时切换控件显隐。
      // 这里拦掉后续的 click，否则会跟着触发一次、来回闪。
      event?.preventDefault?.();
      if (isFullscreenActive()) toggleStageControls();
      else if (state.video && !refs.stageOverlay.hidden) {
        refs.btnBigPlay?.click();
      }
    }
    start = null;
  };
  stage.addEventListener("touchend", finish, { passive: false });
  stage.addEventListener("touchcancel", () => {
    start = null;
  }, { passive: true });
}

// ---- 字幕：只接收房间级字幕（入口已去掉，搜来的片基本用不上外挂字幕） ----
function applySubtitle(subtitle) {
  const video = refs.video;
  if (!video) return;
  for (const old of [...video.querySelectorAll("track[data-wp-sub]")]) {
    if (old.src) URL.revokeObjectURL(old.src);
    old.remove();
  }
  if (!subtitle?.vtt) return;
  const url = URL.createObjectURL(new Blob([subtitle.vtt], { type: "text/vtt" }));
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = subtitle.name || "字幕";
  track.srclang = "zh";
  track.default = true;
  track.dataset.wpSub = "1";
  track.src = url;
  track.addEventListener("load", () => {
    if (track.track) track.track.mode = "showing";
  });
  video.append(track);
  // 已经加载完的字幕不会触发 load，这里兜一下
  setTimeout(() => {
    if (track.track && track.track.mode === "disabled") track.track.mode = "showing";
  }, 300);
}

function pushDanmaku(text, name = "", mine = false) {
  const layer = refs.danmaku;
  if (!layer) return;
  // 同时最多 5 条，多了就丢掉最老的，别糊住画面
  while (layer.children.length >= 5) layer.firstElementChild?.remove();
  const node = el(
    "div",
    { class: `danmaku ${mine ? "danmaku-mine" : ""}` },
    name ? el("span", { class: "danmaku-name", text: name }) : null,
    el("span", { class: "danmaku-text", text: String(text).slice(0, 80) }),
  );
  node.style.top = `${52 + Math.floor(Math.random() * 5) * 34}px`;
  node.style.animationDuration = `${7 + Math.random() * 3}s`;
  layer.append(node);
  setTimeout(() => node.remove(), 11000);
}

// 字幕面板：列出视频自带的字幕轨道，或加载本地 .srt/.vtt（房间级、所有人同步）。
function ensureSubtitlePanel() {
  let box = refs.app?.querySelector("#subtitle-panel");
  if (box) return box;
  box = el("div", { class: "subtitle-panel", id: "subtitle-panel", hidden: true });
  box.innerHTML = `
    <div class="subtitle-card">
      <div class="subtitle-head">
        <span>字幕</span>
        <button class="icon-btn" id="subtitle-close" type="button" aria-label="关闭">${icon("x")}</button>
      </div>
      <div class="subtitle-list" id="subtitle-list"></div>
      <button class="btn btn-ghost btn-sm subtitle-file" id="subtitle-file" type="button">${icon("film")} 加载字幕文件 (.srt / .vtt)</button>
    </div>`;
  refs.app?.append(box);
  box.querySelector("#subtitle-close").onclick = () => closeSubtitlePanel();
  return box;
}

function openSubtitlePanel() {
  const box = ensureSubtitlePanel();
  const list = box.querySelector("#subtitle-list");
  list.replaceChildren();
  const tracks = Array.from(refs.video?.textTracks || []).filter(
    (t) => t.kind === "subtitles" || t.kind === "captions",
  );
  if (!tracks.length) {
    list.append(el("div", { class: "subtitle-empty", text: "这部片没有自带字幕轨道，可加载本地字幕文件" }));
  } else {
    tracks.forEach((track, i) => {
      const btn = el(
        "button",
        { class: `subtitle-opt${track.mode === "showing" ? " is-on" : ""}`, type: "button" },
        track.label || track.language || `字幕 ${i + 1}`,
      );
      btn.onclick = () => {
        Array.from(refs.video.textTracks).forEach((x) => {
          x.mode = "disabled";
        });
        track.mode = "showing";
        closeSubtitlePanel();
        toast(`已切换字幕：${track.label || track.language || "字幕"}`, { type: "success" });
      };
      list.append(btn);
    });
  }
  box.hidden = false;
  box.querySelector("#subtitle-file").onclick = () => refs.subtitleInput?.click();
}

function closeSubtitlePanel() {
  refs.app?.querySelector("#subtitle-panel")?.setAttribute("hidden", "");
}

// .srt/.vtt → vtt；房间级共享，所有人同一份。
function srtToVtt(text) {
  const raw = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r+/g, "");
  if (/^WEBVTT/.test(raw.trimStart())) return raw;
  const body = raw.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`;
}

async function loadSubtitleFile(file) {
  if (!file) return;
  // Keep the raw VTT (plus JSON escaping) under the 2MB WS payload limit.
  if (file.size > 900 * 1024) {
    toast("字幕文件太大了（限制 900KB）", { type: "error" });
    return;
  }
  try {
    const text = await file.text();
    const vtt = srtToVtt(text);
    if (!/-->/.test(vtt)) throw new Error("这个文件里没有字幕时间轴");
    if (!state.ws?.send("subtitle", { name: file.name, vtt })) {
      toast("连接已断开", { type: "error" });
      return;
    }
    toast("字幕已加载，大家都能看到", { type: "success" });
  } catch (error) {
    toast(error.message || "字幕读取失败", { type: "error" });
  }
}

function syncFullscreenChat() {
  if (!refs.fsChat) return;
  const active = isFullscreenActive();
  if (!active) {
    refs.fsChat.hidden = true;
    if (refs.fsChatBubble) refs.fsChatBubble.hidden = true;
    state.fsChatCollapsed = false;
    state.fsChatUnread = 0;
    updateUnreadBadge();
    // 退出全屏时把聊天列表拉回底部：全屏期间对方发的消息，可能因为
    // smooth 滚动竞态或面板被遮挡停在视野外，退出后要能直接看到。
    if (state.fsChatWasNearBottom !== false) state.chat?.scrollToBottom(true);
    state.fsChatWasNearBottom = null;
    return;
  }
  // 进全屏前记住主聊天面板是否在底部，退出时据此决定要不要拉回
  state.fsChatWasNearBottom = state.chat?.isNearBottom?.() ?? true;
  if (state.fsChatCollapsed) {
    refs.fsChat.hidden = true;
    if (refs.fsChatBubble) refs.fsChatBubble.hidden = false;
    updateUnreadBadge();
    return;
  }
  refs.fsChat.hidden = false;
  if (refs.fsChatBubble) refs.fsChatBubble.hidden = true;
  state.fsChatUnread = 0;
  updateUnreadBadge();
  renderFullscreenChat();
}

function mediaExtLabel(url) {
  const match = String(url || "").match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
  return match ? match[1].toUpperCase() : "直链";
}

function updateUnreadBadge() {
  const node = refs.fsChatUnread;
  if (!node) return;
  const count = state.fsChatUnread || 0;
  node.hidden = count <= 0;
  node.textContent = count > 9 ? "9+" : String(count);
}

function setFsChatCollapsed(collapsed) {
  state.fsChatCollapsed = collapsed;
  if (!collapsed) state.fsChatUnread = 0;
  syncFullscreenChat();
}

function canControl() {
  if (!state.video) return false;
  if (state.settings.controlMode === "host" && !state.isHost) {
    return false;
  }
  return true;
}

// host 模式下，观众没有直接控制权。这时不再直接被拒，而是把操作递给主持人，
// 主持人弹窗点「同意」后由他代为执行并广播。shared 模式下则一切照旧。
function needsRequest() {
  return !state.isHost && state.settings.controlMode === "host";
}

function requestControl(action, { position = 0, rate = 1 } = {}) {
  if (!state.ws?.send("controlRequest", { action, position, rate })) {
    toast("连接已断开，稍后再试", { type: "error" });
    return;
  }
  toast("已向主持人申请，等 TA 同意", { type: "info" });
}

function doPlay(position) {
  state.player.forcePlay();
  state.ws?.send("play", { position, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
}

function doPause(position) {
  state.player.pause();
  state.ws?.send("pause", { position, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
}

function doSeek(position) {
  state.player.seek(position);
  state.ws?.send("seek", { position, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
}

function doRate(rate) {
  state.player.setRate(rate);
  state.ws?.send("rate", { rate, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
}

function togglePlay() {
  if (!state.video) {
    if (state.isHost) startResolve({ mode: "change" });
    else toast("等主持人添加影片吧", { type: "info" });
    return;
  }
  if (needsRequest()) {
    requestControl(refs.video.paused ? "play" : "pause", { position: refs.video.currentTime });
    return;
  }
  if (!canControl()) {
    toast("当前只有主持人可以控制播放", { type: "info" });
    return;
  }
  const video = refs.video;
  if (video.paused) doPlay(video.currentTime);
  else doPause(video.currentTime);
  updatePlayButton();
}

function nudgeSeek(delta) {
  if (!state.video) return;
  if (needsRequest()) {
    const duration = refs.video.duration || state.video.duration || 0;
    requestControl("seek", { position: clamp(refs.video.currentTime + delta, 0, duration || Infinity) });
    return;
  }
  if (!canControl()) {
    toast("当前只有主持人可以控制播放", { type: "info" });
    return;
  }
  const video = refs.video;
  const duration = video.duration || state.video.duration || 0;
  const target = clamp(video.currentTime + delta, 0, duration || Infinity);
  state.player.seek(target);
  state.ws?.send("seek", { position: target, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
}

function handleTimeUpdate(info) {
  if (!state.video) return;
  const duration = info.duration || state.video.duration || 0;
  if (!state.dragging) {
    const ratio = duration ? info.currentTime / duration : 0;
    refs.seek.value = String(Math.round(clamp(ratio, 0, 1) * 1000));
    refs.timeCurrent.textContent = formatTime(info.currentTime);
  }
  refs.seekBuffer.style.width = `${duration ? clamp((info.buffered / duration) * 100, 0, 100) : 0}%`;
  updateSyncBadge();
}

function updateSyncBadge(forcedText = "") {
  if (!refs.syncText) return;
  let text = forcedText;
  if (!text) {
    if (!state.video) text = "未开始";
    else if (state.connection !== "open") text = "重连中";
    else if (state.localBuffering) text = "缓冲中";
    else if (state.hostOnline && state.members.some((member) => member.buffering && member.id !== state.me?.id)) {
      text = "等对方缓冲";
    } else if (!state.playback.playing) text = "暂停中";
    else {
      // 与 player.targetPosition 同一套算法：position 是服务端「发出那一刻」
      // 的位置，要按 at→现在 完整投影。漏算在途时间会让大延迟+倍速下
      // 一直误显「校准中」。
      const now = Date.now();
      const age = Math.max(0, (now - (state.playback.at || now)) / 1000);
      const expected = (state.playback.position || 0) + age * (state.playback.rate || 1);
      const diff = Math.abs((refs.video?.currentTime || 0) - expected);
      text = diff > 1.5 ? "校准中" : "已同步";
    }
  }
  if (refs.syncText.textContent !== text) refs.syncText.textContent = text;
  refs.syncBadge.dataset.state = text;
}

function handleLocalBuffering(buffering) {
  if (state.localBuffering === buffering) return;
  state.localBuffering = buffering;
  if (buffering) {
    if (state.bufferOffTimer) {
      clearTimeout(state.bufferOffTimer);
      state.bufferOffTimer = null;
    }
    refs.stageLoading.hidden = false;
    if (!state.bufferSent && !state.bufferOnTimer) {
      // Brief stalls are normal; only tell the room after it lasts.
      state.bufferOnTimer = setTimeout(() => {
        state.bufferOnTimer = null;
        if (!state.localBuffering || state.bufferSent) return;
        state.bufferSent = true;
        state.ws?.send("buffering", { buffering: true });
      }, 600);
    }
  } else {
    if (state.bufferOnTimer) {
      clearTimeout(state.bufferOnTimer);
      state.bufferOnTimer = null;
    }
    if (!state.bufferSent) {
      refs.stageLoading.hidden = true;
      updateSyncBadge();
      updatePartnerStatus();
      return;
    }
    if (state.bufferOffTimer) clearTimeout(state.bufferOffTimer);
    state.bufferOffTimer = setTimeout(() => {
      state.bufferOffTimer = null;
      if (state.localBuffering) return;
      state.bufferSent = false;
      refs.stageLoading.hidden = true;
      state.ws?.send("buffering", { buffering: false });
    }, 600);
  }
  updateSyncBadge();
  updatePartnerStatus();
}

function updatePlayButton() {
  if (!refs.btnPlay) return;
  const paused = refs.video?.paused !== false;
  refs.btnPlay.innerHTML = icon(paused ? "play" : "pause");
  refs.btnPlay.setAttribute("aria-label", paused ? "播放" : "暂停");
}

function updatePlaybackUI() {
  const video = state.video;
  const duration = refs.video?.duration || video?.duration || 0;
  // 直播流的 duration 通常是 Infinity，格式化成 "0:00" 会误导，优先显示“直播”
  refs.timeTotal.textContent =
    duration && Number.isFinite(duration) ? formatTime(duration) : video?.isLive ? "直播" : "0:00";
  refs.liveBadge.hidden = !video?.isLive;
  refs.seek.disabled = !video || !canControl();
  refs.seek.closest(".seek-wrap")?.classList.toggle("disabled", !video || !canControl());
  refs.btnSpeed.disabled = !video || !canControl() || Boolean(video?.isLive);
  if (video?.isLive) {
    refs.btnSpeed.textContent = "直播";
    refs.seek.value = "1000";
  } else if (!state.dragging) {
    refs.seek.value = String(
      duration ? Math.round(clamp((refs.video?.currentTime || 0) / duration, 0, 1) * 1000) : 0,
    );
  }
  updatePlayButton();
  updateSpeedButton();
  updateQualityButton();
  updateSyncBadge();
  updatePartnerStatus();
}

function updateSpeedButton() {
  if (!refs.btnSpeed) return;
  if (state.video?.isLive) {
    refs.btnSpeed.textContent = "直播";
    return;
  }
  const rate = state.playback?.rate || refs.video?.playbackRate || 1;
  refs.btnSpeed.textContent = `${Number(rate.toFixed(2))}×`;
}

function updateQualityButton() {
  if (!refs.btnQuality) return;
  if (!state.video) {
    refs.btnQuality.textContent = "画质";
    return;
  }
  if (state.video.isLive && !state.levels.length) {
    refs.btnQuality.textContent = "直播";
    return;
  }
  if (!state.levels.length) {
    refs.btnQuality.textContent = "原始画质";
    return;
  }
  const current = state.levels.find((level) => level.index === state.currentLevel);
  if (state.currentLevel === -1) {
    refs.btnQuality.textContent = "自动";
  } else {
    refs.btnQuality.textContent = current?.label || "画质";
  }
}

function updateVolumeUI() {
  const video = refs.video;
  if (!video) return;
  const muted = video.muted || video.volume === 0;
  refs.btnMute.innerHTML = icon(muted ? "volume-x" : "volume");
  refs.volume.value = String(Math.round((video.muted ? 0 : video.volume) * 100));
}

function updateRoomHeader() {
  if (!refs.roomTitle) return;
  refs.roomTitle.textContent = state.video?.title || "今晚的放映室";
  refs.roomCode.textContent = state.code;
  refs.onlineCount.textContent = `${state.members.filter((member) => member.online).length} 人在线`;
  updateMembersUI();
}

function renderRoomTitle() {
  if (state.video?.title) {
    setDocumentTitle(`${state.video.title} · 两人放映室`);
    if (refs.roomTitle) refs.roomTitle.textContent = state.video.title;
  } else {
    setDocumentTitle("两人放映室 · 异地同步看片");
  }
}

function updateMembersUI() {
  if (!refs.memberStack) return;
  const online = state.members.filter((member) => member.online);
  refs.memberStack.innerHTML = "";
  for (const member of online.slice(0, 4)) {
    const avatar = el(
      "span",
      {
        class: `member-avatar ${member.buffering ? "buffering" : ""}`,
        style: { backgroundColor: member.color || "#c084fc" },
        title: `${member.name}${member.isHost ? "（主持人）" : ""}`,
        text: initials(member.name),
      },
    );
    if (member.isHost) {
      const crown = el("span", { class: "member-crown", html: icon("crown") });
      avatar.append(crown);
    }
    refs.memberStack.append(avatar);
  }
  if (online.length > 4) {
    refs.memberStack.append(el("span", { class: "member-more", text: `+${online.length - 4}` }));
  }
  refs.onlineCount.textContent = `${online.length} 人在线`;
  const showClaim = !state.isHost && !state.hostOnline && state.members.length > 0;
  if (refs.btnClaimHost) refs.btnClaimHost.hidden = !showClaim;
  updatePermissions();
}

function updatePermissions() {
  if (!refs.btnPlay) return;
  const allowed = canControl();
  refs.btnPlay.disabled = !state.video;
  refs.seek.disabled = !state.video || !allowed;
  refs.btnSpeed.disabled = !state.video || !allowed || Boolean(state.video?.isLive);
  refs.btnBack10.disabled = !state.video || !allowed;
  refs.btnFwd10.disabled = !state.video || !allowed;
  refs.btnQuality.disabled = !state.video;
  refs.stage?.classList.toggle("readonly", !allowed);
}

function updatePartnerStatus() {
  if (!refs.nowMeta) return;
  const others = state.members.filter((member) => member.online && member.id !== state.me?.id);
  const partnerBuffering = others.some((member) => member.buffering);
  const parts = [];
  if (partnerBuffering) {
    const names = others.filter((member) => member.buffering).map((member) => member.name);
    parts.push(`${names.join("、") || "其他"} 正在缓冲`);
  } else if (others.length) {
    parts.push(`${others.length + 1} 人同步观看中`);
  } else {
    parts.push("等人进来一起看…");
  }
  if (state.video) {
    const currentQuality = refs.btnQuality?.textContent?.trim();
    if (currentQuality && currentQuality !== "画质" && currentQuality !== "直播") parts.push(currentQuality);
    if (state.video.isLive) parts.push("直播");
  }
  if (state.settings.controlMode === "host" && !state.isHost) parts.push("主持人控制中");
  refs.nowMeta.textContent = parts.join(" · ");
  if (refs.bufferBadge) {
    refs.bufferBadge.hidden = !partnerBuffering;
    if (partnerBuffering) {
      const names = others.filter((member) => member.buffering).map((member) => member.name);
      refs.bufferText.textContent = names.length ? `${names.join("、")} 正在缓冲…` : "TA 正在缓冲…";
    }
  }
}

function updateNowPlaying() {
  if (!refs.nowTitle) return;
  const video = state.video;
  refs.nowTitle.textContent = video?.title || "还没有影片";
  refs.btnAddVideo.hidden = !state.isHost && !video;
  refs.btnAddVideo.innerHTML = `${icon(video ? "refresh" : "plus")} ${video ? "换一部" : "添加影片"}`;
  if (refs.btnSkipIntro) {
    refs.btnSkipIntro.style.display = video ? "" : "none";
  }
  if (refs.btnDiscoverRoom) {
    refs.btnDiscoverRoom.style.display = state.isHost ? "" : "none";
    if (refs.btnLiveRoom) refs.btnLiveRoom.style.display = state.isHost ? "" : "none";
  }
  refs.stageEmpty.hidden = Boolean(video);
  refs.btnAddVideo.style.display = state.isHost ? "" : "none";
  refs.btnEmptyAdd.style.display = state.isHost ? "" : "none";
  refs.emptyCopy.textContent = state.isHost
    ? "把影片链接粘贴进来，自动嗅探高清播放地址。"
    : "等主持人添加一部影片，你们就能同时开始。";
  if (video) {
    refs.video.poster = safeImageUrl(video.poster);
    refs.stage.classList.add("has-video");
    if (video.isLive) refs.liveBadge.hidden = false;
  } else {
    refs.video.poster = "";
    refs.stage.classList.remove("has-video");
    refs.stageOverlay.hidden = true;
    refs.stageLoading.hidden = true;
  }
  updatePartnerStatus();
  updatePlaybackUI();
  updatePermissions();
}

// ---- 分集/换台：按钮显示当前第几集（直播则是当前频道），点开是列表 ----
function episodeLabel(list) {
  const total = Number(list.total) || 0;
  const index = Number(list.index) || 0;
  if (state.video?.isLive) return total > 1 ? `换台 ${index + 1}/${total}` : "换台";
  return total > 1 ? `选集 ${index + 1}/${total}` : "选集";
}

function updatePlaylistUI() {
  const button = refs.btnNextEpisode;
  if (!button) return;
  const list = state.playlist;
  if (!list || !list.total) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.textContent = episodeLabel(list);
}

function openEpisodeMenu() {
  const list = state.playlist;
  if (!list || !list.items?.length) {
    toast(state.video?.isLive ? "当前直播没有频道列表" : "这部片子没有剧集信息", { type: "info" });
    return;
  }
  const current = Number(list.index) || 0;
  const isLive = Boolean(state.video?.isLive);
  const grid = el("div", { class: "episode-grid" });
  const modal = openModal({
    title: isLive ? `换台 · 共 ${list.total} 个频道` : `选集 · 共 ${list.total} 集`,
    body: grid,
    actions: [],
  });
  if (!modal) return;
  for (const item of list.items) {
    const isCurrent = item.index === current;
    const button = el(
      "button",
      {
        class: `episode-row ${isCurrent ? "is-current" : ""}`,
        type: "button",
        title: item.title,
      },
      el("span", { class: "episode-no", text: String(item.index + 1).padStart(2, "0") }),
      el("span", { class: "episode-title", text: item.title }),
      isCurrent ? el("span", { class: "episode-now", "aria-label": "正在播放", html: icon("check") }) : null,
    );
    button.addEventListener("click", () => {
      if (isCurrent) {
        modal.close();
        return;
      }
      if (!state.ws?.send("selectEpisode", { index: item.index })) {
        toast("连接已断开", { type: "error" });
        return;
      }
      modal.close();
    });
    grid.append(button);
  }
  requestAnimationFrame(() => {
    const active = grid.querySelector(".episode-row.is-current");
    active?.scrollIntoView({ block: "center" });
  });
}

function updateSettingsUI() {
  if (!refs.btnClaimHost) return;
  const showClaim = !state.isHost && !state.hostOnline && state.members.length > 0;
  refs.btnClaimHost.hidden = !showClaim;
}

function showStageOverlay(text, { showPlay = true } = {}) {
  refs.stageOverlay.hidden = false;
  refs.overlayText.textContent = text;
  refs.btnBigPlay.style.display = showPlay ? "" : "none";
}

function sendChat(text) {
  if (!state.ws?.send("chat", { text })) {
    toast("连接已断开，消息没有发出去", { type: "error" });
    return false;
  }
  return true;
}

function sendTyping(typing) {
  state.ws?.send("typing", { typing: Boolean(typing) });
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** iOS < 14.3 没有 createImageBitmap，用 <img> 解码兜底，否则老设备发图直接报错。 */
async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // 解码失败走 <img> 兜底
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片无法解码，换一张试试"));
      image.src = url;
    });
  } finally {
    // img 引用了 blob，延迟回收，等画布画完
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

async function prepareChatImage(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error("只支持 JPG / PNG / WEBP / GIF");
  if (file.type === "image/gif") {
    if (file.size > 6 * 1024 * 1024) throw new Error("GIF 不能超过 6MB");
    return file;
  }
  if (file.size <= 1.5 * 1024 * 1024) return file;
  const bitmap = await decodeImage(file);
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法处理这张图片");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("图片压缩失败");
  if (blob.size > 6 * 1024 * 1024) throw new Error("图片压缩后仍然太大，换一张小一点的吧");
  return blob;
}

async function sendImage(file) {
  if (!state.code || !state.memberToken) {
    toast("还没进入放映室", { type: "error" });
    return;
  }
  // 选图/压缩/上传这几步，部分浏览器会把视频停掉，结束后接回播放
  const video = refs.video;
  const wasPlaying = Boolean(video && !video.paused);
  if (!state.ws?.send) {
    toast("连接已断开，图片没有发出去", { type: "error" });
    return;
  }
  try {
    toast("正在处理图片…", { type: "info", duration: 1600 });
    const blob = await prepareChatImage(file);
    const uploaded = await withAccess(() => api.uploadImage(state.code, state.memberToken, blob));
    if (!uploaded?.url) throw new Error("图片上传失败");
    // iOS 去相册选图期间页面被挂起，ws 可能被系统断开。上传已经成功，
    // 等连接恢复几秒再把消息发出去，别让用户白选一张图。
    const deadline = Date.now() + 9000;
    let sent = false;
    while (Date.now() < deadline) {
      if (state.ws?.send("chat", { text: "", image: uploaded.url })) {
        sent = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!sent) throw new Error("网络还没恢复，图片没有发出去，再试一次");
  } catch (error) {
    toast(error.message || "图片发送失败", { type: "error", duration: 4500 });
  } finally {
    if (wasPlaying && video?.paused) {
      try {
        await video.play();
      } catch {
        // 自动播放被拦就让用户自己点
      }
    }
  }
}

function handleKeyboard(event) {
  if (state.view !== "room") return;
  const target = event.target;
  const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (typing) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === " " || event.code === "Space") {
    event.preventDefault();
    togglePlay();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    nudgeSeek(-5);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    nudgeSeek(5);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    const value = clamp(refs.video.volume + 0.1, 0, 1);
    refs.video.muted = false;
    state.player.setVolume(value, false);
    localStorage.setItem(VOLUME_KEY, String(value));
    updateVolumeUI();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    const value = clamp(refs.video.volume - 0.1, 0, 1);
    state.player.setVolume(value, false);
    localStorage.setItem(VOLUME_KEY, String(value));
    updateVolumeUI();
  } else if (event.key.toLowerCase() === "m") {
    refs.btnMute.click();
  } else if (event.key === "Escape") {
    if (isFullscreenActive() && !document.fullscreenElement) {
      event.preventDefault();
      exitFullscreen();
    }
  } else if (event.key.toLowerCase() === "f") {
    toggleFullscreen();
  } else if (event.key.toLowerCase() === "c") {
    state.chat?.focus();
  }
}

let controlsHideTimer = 0;

/** 全屏时点一下画面：有控件就收起，没有就显示。 */
function toggleStageControls() {
  const stage = refs.stage;
  if (!stage) return;
  if (stage.classList.contains("controls-hidden")) showStageControls();
  else hideStageControls();
}

/** 全屏或不全屏时，鼠标/触摸不动一会儿就把控件收起来，动一下再回来。 */
function hideStageControls() {
  clearTimeout(controlsHideTimer);
  if (!refs.stage) return;
  refs.stage.classList.add("controls-hidden");
}

function showStageControls({ keep = false } = {}) {
  const stage = refs.stage;
  if (!stage) return;
  stage.classList.remove("controls-hidden");
  clearTimeout(controlsHideTimer);
  if (keep) return;
  // 暂停时控件常驻，别让用户对着隐藏的进度条发呆
  if (refs.video?.paused) return;
  controlsHideTimer = setTimeout(() => {
    if (refs.video && !refs.video.paused && !state.dragging) hideStageControls();
  }, 3200);
}

function isFullscreenActive() {
  return Boolean(document.fullscreenElement) || Boolean(refs.stage?.classList.contains("is-fs"));
}

function syncFullscreenUi() {
  const full = isFullscreenActive();
  if (refs.btnFullscreen) {
    refs.btnFullscreen.innerHTML = icon(full ? "minimize" : "maximize");
    refs.btnFullscreen.setAttribute("aria-label", full ? "退出全屏" : "全屏");
  }
  syncFullscreenChat();
}

async function exitFullscreen() {
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen?.();
    } catch {
      // 某些内核这里会抛错，不影响下面的清理
    }
  }
  refs.stage?.classList.remove("is-fs");
  refs.stage?.classList.remove("controls-hidden");
  document.body.classList.remove("fs-lock");
  clearTimeout(controlsHideTimer);
  // 退出全屏时把方向锁解开，别把整个页面钉在横屏
  try {
    screen.orientation?.unlock?.();
  } catch {
    // 没锁过就算了
  }
  syncFullscreenUi();
}

async function toggleFullscreen() {
  const stage = refs.stage;
  if (!stage) return;
  if (isFullscreenActive()) {
    await exitFullscreen();
    return;
  }
  // 先试「元素全屏」：它能让浏览器工具栏一起消失，而且屏幕里还是我们自己的
  // 控件和聊天浮层。绝不调用 video 的全屏接口，那条路会把播放器交给系统。
  const requestStageFullscreen =
    stage.requestFullscreen?.bind(stage) || stage.webkitRequestFullscreen?.bind(stage);
  if (requestStageFullscreen) {
    try {
      await requestStageFullscreen();
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (document.fullscreenElement) {
        syncFullscreenUi();
        showStageControls();
        hintLandscapeIfNeeded();
        return;
      }
    } catch {
      // 浏览器拒绝（权限、手势、被策略禁用），退到属性全屏
    }
  }
  enterPseudoFullscreen();
}

function hintLandscapeIfNeeded() {
  if (window.innerHeight <= window.innerWidth) return;
  toast("横过来看，画面更大", { duration: 2600 });
  try {
    screen.orientation?.lock?.("landscape")?.catch?.(() => {});
  } catch {
    // 不支持就算了
  }
}

function enterPseudoFullscreen() {
  const stage = refs.stage;
  if (!stage) return;
  stage.classList.add("is-fs");
  document.body.classList.add("fs-lock");
  syncFullscreenUi();
  showStageControls();
  hintLandscapeIfNeeded();
}

async function togglePictureInPicture() {
  const video = refs.video;
  if (!video) return;
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled) {
      await video.requestPictureInPicture();
    } else {
      toast("当前浏览器不支持画中画", { type: "error" });
    }
  } catch {
    toast("画中画打开失败", { type: "error" });
  }
}

function closeAnyPopover() {
  document.querySelectorAll(".popover").forEach((node) => node.remove());
}

function openMenu(anchor, items, { title = "" } = {}) {
  closeAnyPopover();
  const popover = el("div", { class: "popover" });
  if (title) popover.append(el("div", { class: "popover-title", text: title }));
  for (const item of items) {
    const button = el(
      "button",
      {
        class: `popover-item ${item.active ? "active" : ""}`,
        type: "button",
        disabled: item.disabled || false,
      },
      el("span", { text: item.label }),
      item.hint ? el("span", { class: "popover-hint", text: item.hint }) : null,
      item.active ? el("span", { class: "popover-check", html: icon("check") }) : null,
    );
    button.addEventListener("click", () => {
      if (item.disabled) return;
      closeAnyPopover();
      item.onClick?.();
    });
    popover.append(button);
  }
  refs.controls.append(popover);
  const anchorRect = anchor.getBoundingClientRect();
  const controlsRect = refs.controls.getBoundingClientRect();
  popover.style.left = `${clamp(anchorRect.left - controlsRect.left, 8, controlsRect.width - 220)}px`;
  popover.style.bottom = `${controlsRect.bottom - anchorRect.top + 8}px`;
  setTimeout(() => {
    document.addEventListener(
      "click",
      (event) => {
        if (!popover.contains(event.target) && event.target !== anchor) popover.remove();
      },
      { once: true },
    );
  }, 0);
}

function openSpeedMenu() {
  if (!state.video || state.video.isLive) return;
  if (!canControl()) {
    toast("当前只有主持人可以控制倍速", { type: "info" });
    return;
  }
  const current = Number(state.playback.rate || 1);
  const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];
  openMenu(
    refs.btnSpeed,
    rates.map((rate) => ({
      label: `${rate}×`,
      active: Math.abs(rate - current) < 0.01,
      onClick: () => {
        state.playback.rate = rate;
        state.player.setRate(rate);
        if (needsRequest()) {
          state.ws?.send("controlRequest", { action: "rate", rate });
          updateSpeedButton();
          return;
        }
        state.ws?.send("rate", { rate, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
        updateSpeedButton();
      },
    })),
    { title: "播放速度" },
  );
}

function openQualityMenu() {
  if (!state.video) return;
  if (!state.levels.length) {
    toast("这个源只有原始画质", { type: "info" });
    return;
  }
  openMenu(
    refs.btnQuality,
    state.levels.map((level) => ({
      label: level.auto ? "自动（推荐）" : level.label,
      hint: level.bitrate ? `${Math.round(level.bitrate / 1000)} kbps` : "",
      active: level.index === state.currentLevel,
      onClick: () => {
        state.player.setLevel(level.index);
        updateQualityButton();
      },
    })),
    { title: "清晰度" },
  );
}

function invite() {
  const url = `${location.origin}${location.pathname}#/r/${state.code}`;
  const access = getAccessCode();
  const inviteText = `一起来看电影：${url}${access ? `（通行码：${access}）` : ""}`;

  const codeNode = el("div", { class: "invite-code", text: state.code });
  const codeButton = el("button", {
    class: "btn btn-primary btn-sm",
    type: "button",
    html: `${icon("copy")} 复制房间码`,
  });
  codeButton.addEventListener("click", async () => {
    const ok = await copyText(state.code);
    toast(ok ? `房间码 ${state.code} 已复制` : "复制失败，请长按选择", {
      type: ok ? "success" : "error",
    });
  });

  const linkInput = el("input", {
    class: "input code-readonly",
    value: url,
    readonly: true,
    "aria-label": "邀请链接",
  });
  const linkButton = el("button", {
    class: "btn btn-ghost btn-sm",
    type: "button",
    html: `${icon("copy")} 复制链接`,
  });
  linkButton.addEventListener("click", async () => {
    const ok = await copyText(inviteText);
    toast(ok ? "邀请链接已复制" : "复制失败，请长按选择", { type: ok ? "success" : "error" });
  });

  const blocks = [
    el(
      "div",
      { class: "invite-block" },
      el("div", { class: "invite-label", text: "房间码" }),
      codeNode,
      el("div", { class: "invite-hint", text: "TA 在首页输入这 6 位就能进来" }),
      codeButton,
    ),
    el(
      "div",
      { class: "invite-block" },
      el("div", { class: "invite-label", text: "邀请链接" }),
      linkInput,
      access
        ? el("div", { class: "invite-hint", text: `通行码 ${access}，复制链接时会一起带上` })
        : null,
      linkButton,
    ),
  ];

  if (navigator.share) {
    const shareButton = el("button", {
      class: "btn btn-ghost btn-sm btn-block",
      type: "button",
      html: `${icon("send")} 用系统分享发出去`,
    });
    shareButton.addEventListener("click", async () => {
      try {
        await navigator.share({ title: "两人放映室", text: inviteText, url });
      } catch {
        // 用户取消，忽略
      }
    });
    blocks.push(shareButton);
  }

  openModal({
    title: "分享放映室",
    body: el("div", { class: "invite-body" }, ...blocks),
    actions: [{ label: "关闭", kind: "ghost" }],
  });
}

function openSkipIntro() {
  if (!state.video) return;
  if (!canControl()) {
    toast("当前只有主持人可以控制播放", { type: "info" });
    return;
  }
  const input = el("input", {
    class: "input",
    type: "number",
    min: "0",
    max: "7200",
    step: "1",
    value: "90",
    placeholder: "例如 90",
  });
  const errorNode = el("p", { class: "form-error" });
  openModal({
    title: "跳过片头 / 广告",
    body: el(
      "div",
      { class: "form-stack" },
      el("p", { class: "modal-text", text: "从第几秒开始？大家会一起跳过去，适合固定的贴片广告或片头。" }),
      input,
      el("p", { class: "settings-hint", text: "只对当前播放生效，不会修改视频文件。" }),
      errorNode,
    ),
    actions: [
      { label: "取消", kind: "ghost" },
      {
        label: "跳过去",
        kind: "primary",
        keepOpen: true,
        onClick: ({ close }) => {
          const seconds = Number(input.value);
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 7200) {
            errorNode.textContent = "请输入 0–7200 秒";
            return false;
          }
          const duration = refs.video.duration || state.video.duration || 0;
          const target = duration ? Math.min(seconds, Math.max(0, duration - 1)) : seconds;
          state.player.seek(target);
          state.ws?.send("seek", { position: target, clientTs: Date.now() + (state.ws?.clockOffset || 0) });
          close();
          toast(`已跳到 ${formatTime(target)}`, { type: "success" });
          return false;
        },
      },
    ],
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 80);
}

async function leaveRoom() {
  const ok = await confirmDialog({
    title: "离开放映室？",
    message: state.isHost && state.members.filter((member) => member.online).length > 1
      ? "你是主持人，离开后其他成员可以接管主持。"
      : "随时可以通过房间码再回来。",
    confirmLabel: "离开",
    danger: true,
  });
  if (!ok) return;
  cleanupRoom();
  navigate("/");
}

function openSettings() {
  const body = el("div", { class: "settings-body" });
  const autoWait = el("input", {
    type: "checkbox",
    checked: state.settings.autoWait,
    disabled: !state.isHost,
  });
  const shared = el("input", {
    type: "radio",
    name: "controlMode",
    value: "shared",
    checked: state.settings.controlMode === "shared",
    disabled: !state.isHost,
  });
  const hostOnly = el("input", {
    type: "radio",
    name: "controlMode",
    value: "host",
    checked: state.settings.controlMode === "host",
    disabled: !state.isHost,
  });
  const codeText = el("input", {
    class: "input code-readonly",
    value: state.code,
    readonly: true,
    "aria-label": "房间码",
  });
  const copyButton = el("button", { class: "btn btn-ghost btn-sm", type: "button", html: `${icon("copy")} 复制邀请` });
  copyButton.addEventListener("click", invite);
  const leaveButton = el("button", { class: "btn btn-danger btn-sm", type: "button", html: `${icon("log-out")} 离开房间` });
  leaveButton.addEventListener("click", () => {
    modal.close();
    leaveRoom();
  });
  const nameRow = el(
    "div",
    { class: "settings-row" },
    el("div", { class: "settings-label", text: "昵称" }),
    el("div", { class: "settings-value", text: state.me?.name || storedName() }),
  );
  const roomRow = el(
    "div",
    { class: "settings-row" },
    el("div", { class: "settings-label", text: "房间码" }),
    el("div", { class: "settings-inline" }, codeText, copyButton),
  );
  const toggleRow = el(
    "label",
    { class: "settings-row settings-toggle" },
    el(
      "div",
      {},
      el("div", { class: "settings-label", text: "自动等待缓冲" }),
      el("div", { class: "settings-hint", text: "TA 卡住时自动暂停，缓冲好再继续" }),
    ),
    autoWait,
  );
  const controlRow = el(
    "div",
    { class: "settings-block" },
    el("div", { class: "settings-label", text: "谁可以控制播放" }),
    el(
      "div",
      { class: "radio-group" },
      el("label", { class: "radio-item" }, shared, el("span", { text: "任何成员都可以（推荐）" })),
      el("label", { class: "radio-item" }, hostOnly, el("span", { text: "只有主持人" })),
    ),
    !state.isHost ? el("div", { class: "settings-hint", text: "只有主持人可以修改这些设置" }) : null,
  );
  const saveButton = el("button", {
    class: "btn btn-primary",
    type: "button",
    text: state.isHost ? "保存设置" : "关闭",
  });
  let modal;
  saveButton.addEventListener("click", () => {
    if (state.isHost) {
      state.ws?.send("settings", {
        settings: {
          autoWait: autoWait.checked,
          controlMode: shared.checked ? "shared" : "host",
        },
      });
      toast("设置已保存", { type: "success" });
    }
    modal.close();
  });
  body.append(nameRow, roomRow, toggleRow, controlRow);
  modal = openModal({
    title: "放映室设置",
    body,
    actions: [],
  });
  if (!modal) return;
  modal.footer.append(leaveButton, saveButton);
}

function openMembers() {
  const body = el("div", { class: "member-list" });
  for (const member of state.members) {
    body.append(
      el(
        "div",
        { class: `member-row ${member.online ? "" : "offline"}` },
        el(
          "span",
          { class: "member-avatar", style: { backgroundColor: member.color || "#c084fc" }, text: initials(member.name) },
        ),
        el(
          "span",
          { class: "member-info" },
          el(
            "span",
            { class: "member-name" },
            member.name,
            member.isHost ? el("span", { class: "member-tag", html: `${icon("crown")} 主持人` }) : null,
            member.id === state.me?.id ? el("span", { class: "member-tag muted", text: "你" }) : null,
          ),
          el("span", {
            class: "member-state",
            text: member.online ? (member.buffering ? "缓冲中" : "在线") : "已离开",
          }),
        ),
      ),
    );
  }
  openModal({ title: "放映室成员", body, actions: [{ label: "关闭", kind: "ghost" }] });
}

// Boot
document.addEventListener("keydown", handleKeyboard);
document.addEventListener("fullscreenchange", () => {
  // 从系统全屏退回来时，把属性全屏也一并清掉
  if (!document.fullscreenElement) {
    refs.stage?.classList.remove("is-fs");
    document.body.classList.remove("fs-lock");
  }
  syncFullscreenUi();
});
window.addEventListener("beforeunload", () => {
  state.ws?.close();
});

// iOS Safari 的 100vh/dvh 在地址栏显隐、旋转屏幕时会失真或直接失效
// （老系统不支持 dvh），房间页高度链一断，聊天输入表单就被消息/图片
// 挤出屏幕——表现为"按钮没了、打不了字"。用 JS 量真实视口高兜底。
function syncViewportHeight() {
  try {
    document.documentElement.style.setProperty("--app-h", `${window.innerHeight}px`);
  } catch {
    // ignore
  }
}
window.addEventListener("resize", syncViewportHeight);
window.addEventListener("orientationchange", syncViewportHeight);
syncViewportHeight();

route();

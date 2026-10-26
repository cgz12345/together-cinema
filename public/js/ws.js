export class RoomSocket {
  constructor({ code, token, onMessage, onStatus, onAuthLost, onOpen }) {
    this.code = code;
    this.token = token;
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.onAuthLost = onAuthLost || (() => {});
    this.onOpen = onOpen || (() => {});
    this.ws = null;
    this.closed = false;
    this.attempts = 0;
    this.openedOnce = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    // 本机时钟和服务器时钟的差（serverTime - clientTime）。手机时间、
    // 虚拟机时间都可能偏几秒，不校正的话同步会整体偏出去。
    this.clockOffset = 0;
    this.bestRtt = Infinity;
    // iOS 上去相册选图、切 App 时页面被挂起，系统的 WebSocket 可能被断掉，
    // 而退避重连的定时器在后台是不跑的。回到前台/网络恢复时立刻补连，
    // 别让聊天输入框一直灰着（按钮像"没了"）。
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.resumeIfDead();
    });
    window.addEventListener("online", () => this.resumeIfDead());
    window.addEventListener("focus", () => this.resumeIfDead());
  }

  /** 连接已断或正在重连等待中时，立即重连，取消退避等待。 */
  resumeIfDead() {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.clearReconnect();
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.clearReconnect();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}/ws?code=${encodeURIComponent(this.code)}&token=${encodeURIComponent(this.token)}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.onStatus("connecting");
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.openedOnce = true;
      this.attempts = 0;
      this.onStatus("open");
      this.send("ping", { t: Date.now() });
      this.startHeartbeat();
      this.onOpen();
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "pong") this.notePong(message);
      this.onMessage(message);
    });

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (event.code === 4002) {
        this.closed = true;
        this.onStatus("replaced");
        return;
      }
      this.onStatus("closed");
      if (this.closed) return;
      if (!this.openedOnce && this.attempts >= 2) {
        this.onAuthLost();
        return;
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close will handle reconnection
    });
  }

  /** 用一次往返估算时钟差，取 RTT 最小的那次，减少网络抖动带来的噪声。 */
  notePong(message) {
    const sentAt = Number(message.t);
    const serverNow = Number(message.now);
    if (!Number.isFinite(sentAt) || !Number.isFinite(serverNow)) return;
    const now = Date.now();
    const rtt = now - sentAt;
    if (rtt < 0 || rtt > 8000) return;
    if (rtt > this.bestRtt + 60) return; // 明显更慢的一次不采信
    this.bestRtt = Math.min(this.bestRtt, rtt);
    this.clockOffset = serverNow + rtt / 2 - now;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send("ping", { t: Date.now() });
    }, 25000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.closed) return;
    this.clearReconnect();
    this.attempts += 1;
    const delay = Math.min(15000, 800 * 2 ** Math.min(this.attempts, 4)) + Math.random() * 500;
    this.onStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ type, ...payload }));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.closed = true;
    this.clearReconnect();
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, "leaving");
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

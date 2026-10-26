import { clamp } from "./utils.js";
import { safeImageUrl } from "./ui.js";

const Hls = window.Hls || null;
const QUALITY_KEY = "wp.quality.v2";
const DIRECT_KEY = "wp.direct.v2";

function isNativeHlsSupported(video) {
  return Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
}

const PAINT_KEY = "wp.paint";

// 画布渲染是「兜底手段」：把 video 缩到 2px，画面改由 canvas 绘制，浏览器就
// 认不出这是视频，不会接管成系统播放器。不是所有内核都给缩小的 video 出帧，
// 所以默认关闭，由用户在设置里手动打开；一旦黑屏会自动退回并记住别再用。
export function canvasPaintPreferred() {
  return localStorage.getItem(PAINT_KEY) === "1";
}

function rememberCanvasPaint(enabled) {
  try {
    localStorage.setItem(PAINT_KEY, enabled ? "1" : "0");
  } catch {
    // 隐私模式下写不了，忽略
  }
}

function isIOS() {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export class Player {
  constructor(video, callbacks = {}) {
    this.video = video;
    this.callbacks = callbacks;
    this.hls = null;
    this.videoData = null;
    this.levels = [];
    this.manifestReady = false;
    this.pendingPlayback = null;
    this.userSeeking = false;
    this.baseRate = 1;
    this.nudgeTarget = null;
    this.nudgeTimer = null;
    this.clockOffset = 0;
    this.bufferTimer = null;
    this.recoverCount = 0;
    this.qualityPref = localStorage.getItem(QUALITY_KEY) || "auto";
    // 直连是唯一模式：走服务器中转太慢，源站防盗链时下面会自动回退
    this.directPref = true;
    this.usingDirect = false;
    this.proxySrc = null;
    this.lastProgressAt = 0;
    this.autoplayBlocked = false;
    this.suppressBufferingUntil = 0;
    this.lastHardSeekAt = 0;
    this.nativeFallbackSource = null;
    this.hlsFallbackTried = false;
    this.takeoverHits = 0;
    this.paint = null;
    this.paintRaf = 0;
    this.paintObserver = null;
    this.hardenVideo();
    this.bind();
    this.guardControls();
  }

  /**
   * 国产浏览器（小米、UC、QQ 等）会在视频开始播放时接管播放器，
   * 换成带「听 / 下载 / 投屏」的系统控件，页面自己的控件就被盖掉了。
   * 这些属性不能保证挡住，但能明显降低被接管的概率。
   */
  setCanvasPaint(enabled) {
    rememberCanvasPaint(enabled);
    if (enabled) {
      this.enableCanvasPaint();
      this.watchCanvasHealth();
    } else {
      this.disableCanvasPaint();
    }
  }

  /** 把画面搬到 canvas 上，video 本身缩到看不见，浏览器就不会接管。 */
  enableCanvasPaint() {
    if (this.paint || !this.video?.parentElement) return;
    const stage = this.video.parentElement;
    const canvas = document.createElement("canvas");
    canvas.className = "video-paint";
    stage.insertBefore(canvas, this.video.nextSibling);
    this.video.classList.add("is-painted");
    this.paint = { canvas, ctx: canvas.getContext("2d", { alpha: false }) };
    this.resizePaint();
    this.paintTick = () => this.drawFrame();
    const loop = () => {
      if (!this.paint) return;
      this.drawFrame();
      this.paintRaf = requestAnimationFrame(loop);
    };
    this.paintRaf = requestAnimationFrame(loop);
    this.paintObserver = new ResizeObserver(() => this.resizePaint());
    this.paintObserver.observe(stage);
    this.video.addEventListener("timeupdate", this.paintTick);
    this.watchCanvasHealth();
  }

  /**
   * 有些内核（比如小米浏览器）会把缩到 2px 的 video 当成「不用渲染」，
   * 结果是黑屏。这里在播放后抽样看画面是不是全黑，是就自动退回原生播放。
   */
  watchCanvasHealth() {
    clearInterval(this.paintHealth);
    let dark = 0;
    this.paintHealth = setInterval(() => {
      const paint = this.paint;
      const video = this.video;
      if (!paint || !video) return;
      if (video.paused || video.currentTime < 2 || video.readyState < 2) return;
      let avg;
      try {
        const { ctx, canvas } = paint;
        const w = Math.min(canvas.width, 80);
        const h = Math.min(canvas.height, 45);
        if (!w || !h) return;
        const data = ctx.getImageData(
          Math.max(0, Math.round((canvas.width - w) / 2)),
          Math.max(0, Math.round((canvas.height - h) / 2)),
          w,
          h,
        ).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
        avg = sum / (data.length / 4) / 3;
      } catch {
        return; // 读不了像素就当作正常，别误伤
      }
      dark = avg < 2 ? dark + 1 : 0;
      if (dark >= 3) {
        this.disableCanvasPaint();
        rememberCanvasPaint(false);
        this.callbacks.onPaintFallback?.();
      }
    }, 1500);
    this.paintHealth.unref?.();
  }

  resizePaint() {
    if (!this.paint) return;
    const rect = this.paint.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const fit = Math.min(1, 1280 / (rect.width * dpr));
    const width = Math.max(2, Math.round(rect.width * dpr * fit));
    const height = Math.max(2, Math.round(rect.height * dpr * fit));
    if (this.paint.canvas.width !== width || this.paint.canvas.height !== height) {
      this.paint.canvas.width = width;
      this.paint.canvas.height = height;
    }
  }

  drawFrame() {
    const paint = this.paint;
    const video = this.video;
    if (!paint || !video || video.readyState < 2) return;
    const { ctx, canvas } = paint;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(canvas.width / vw, canvas.height / vh);
    const w = vw * scale;
    const h = vh * scale;
    try {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    } catch {
      // 画不出来就退回原生 video，总比黑屏强
      this.disableCanvasPaint();
    }
  }

  disableCanvasPaint() {
    if (!this.paint) return;
    if (this.paintHealth) {
      clearInterval(this.paintHealth);
      this.paintHealth = null;
    }
    cancelAnimationFrame(this.paintRaf);
    this.paintObserver?.disconnect();
    this.paintObserver = null;
    if (this.paintTick) {
      this.video.removeEventListener("timeupdate", this.paintTick);
      this.paintTick = null;
    }
    this.paint.canvas.remove();
    this.video.classList.remove("is-painted");
    this.paint = null;
  }

  hardenVideo() {
    const video = this.video;
    if (!video) return;
    video.controls = false;
    video.disablePictureInPicture = false;
    video.setAttribute("controlslist", "nodownload nofullscreen noplaybackrate");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    // 腾讯 X5 内核（QQ / 微信 / 部分国产浏览器）认这两条，能禁止进系统播放器
    video.setAttribute("x5-playsinline", "true");
    video.setAttribute("x5-video-player-type", "h5-page");
    video.setAttribute("x5-video-player-fullscreen", "false");
  }

  /** 一旦浏览器把 controls 打开，立刻关回去；连续多次失败就提示用户。 */
  guardControls() {
    if (this.controlsGuard) clearInterval(this.controlsGuard);
    this.controlsGuard = setInterval(() => {
      const video = this.video;
      if (!video || !video.controls) return;
      video.controls = false;
      this.takeoverHits += 1;
      if (this.takeoverHits === 3) {
        this.callbacks.onBrowserTakeover?.();
      }
    }, 1200);
    this.controlsGuard.unref?.();
  }

  bind() {
    const video = this.video;
    video.addEventListener("timeupdate", () => this.emitTime());
    video.addEventListener("progress", () => this.emitTime());
    video.addEventListener("loadedmetadata", () => {
      this.manifestReady = this.manifestReady || !this.hls;
      this.callbacks.onDuration?.(this.getDuration());
      this.callbacks.onLevels?.(this.getLevels(), this.getCurrentLevel());
      this.emitTime();
      this.flushPending();
    });
    video.addEventListener("durationchange", () => {
      this.callbacks.onDuration?.(this.getDuration());
      this.emitTime();
    });
    video.addEventListener("seeking", () => {
      // A remote sync seek is not a real buffering event; reporting it as one
      // makes the auto-wait flip between "waiting" and "resume" every second.
      this.emitTime();
    });
    video.addEventListener("seeked", () => {
      this.callbacks.onBuffering?.(false);
      this.emitTime();
    });
    video.addEventListener("waiting", () => {
      if (performance.now() < this.suppressBufferingUntil) return;
      this.callbacks.onBuffering?.(true);
    });
    video.addEventListener("stalled", () => {
      if (performance.now() < this.suppressBufferingUntil) return;
      this.callbacks.onBuffering?.(true);
    });
    video.addEventListener("playing", () => {
      this.callbacks.onBuffering?.(false);
      this.callbacks.onPlaying?.();
    });
    video.addEventListener("canplay", () => {
      this.callbacks.onBuffering?.(false);
    });
    video.addEventListener("pause", () => {
      this.callbacks.onPauseState?.(false);
    });
    video.addEventListener("play", () => {
      this.callbacks.onPauseState?.(true);
    });
    video.addEventListener("ratechange", () => {
      this.callbacks.onRateChange?.(this.video.playbackRate);
    });
    video.addEventListener("ended", () => {
      this.callbacks.onEnded?.();
    });
    video.addEventListener("error", () => {
      const error = this.video.error;
      if (!error) return;
      if (this.usingDirect && this.proxySrc) {
        this.fallbackToProxy("直连线路不可用，已切回服务器代理");
        return;
      }
      if (this.nativeFallbackSource && !this.hlsFallbackTried && Hls && Hls.isSupported()) {
        this.hlsFallbackTried = true;
        const fallbackSource = this.nativeFallbackSource;
        this.nativeFallbackSource = null;
        this.callbacks.onTransientError?.("原生播放失败，正在切换兼容模式…");
        try {
          video.removeAttribute("src");
          video.load();
        } catch {
          // ignore
        }
        this.initHls(fallbackSource);
        return;
      }
      if (!this.hls) this.callbacks.onError?.(this.describeMediaError(error));
    });
    video.addEventListener("volumechange", () => {
      this.callbacks.onVolumeChange?.(this.video.volume, this.video.muted);
    });
  }

  describeMediaError(error) {
    const codes = {
      1: "播放被中止",
      2: "网络错误，视频加载失败",
      3: "视频解码失败",
      4: "播放地址不可用，可能已过期或需要 Referer/Cookie",
    };
    return codes[error.code] || "视频加载失败";
  }

  async load(videoData, { forceProxy = false } = {}) {
    this.destroyHls();
    this.videoData = videoData;
    this.levels = [];
    this.manifestReady = false;
    this.pendingPlayback = null;
    this.recoverCount = 0;
    this.autoplayBlocked = false;
    this.suppressBufferingUntil = 0;
    this.lastHardSeekAt = 0;
    // 用户主动 seek 的时刻：seek 命令和它的广播可能在弱网上乱序迟到，
    // 期间服务端心跳还是旧位置，不设宽限就会把用户甩回原地（进度条跳回去）。
    this.lastUserSeekAt = 0;
    this.nativeFallbackSource = null;
    this.hlsFallbackTried = false;
    this.usingDirect = false;
    this.proxySrc = videoData?.src || null;
    this.takeoverHits = 0;
    this.hardenVideo();
    if (canvasPaintPreferred() && !this.paint) this.enableCanvasPaint();
    const video = this.video;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.poster = safeImageUrl(videoData?.poster);
    video.dataset.kind = videoData?.kind || "file";

    if (!videoData?.src) {
      this.callbacks.onError?.("没有可播放的地址");
      return;
    }

    const directCandidate =
      typeof videoData.directSrc === "string" && /^https?:\/\//i.test(videoData.directSrc)
        ? videoData.directSrc.trim()
        : "";
    const pageIsHttps = location.protocol === "https:";
    const directUsable =
      Boolean(directCandidate) && (!pageIsHttps || directCandidate.startsWith("https://"));
    const useDirect = !forceProxy && this.directPref && directUsable;
    this.usingDirect = useDirect;
    video.dataset.direct = useDirect ? "1" : "0";
    const playSrc = useDirect ? directCandidate : videoData.src;
    const source = useDirect ? { ...videoData, src: directCandidate } : videoData;

    if (videoData.kind === "hls") {
      if (isIOS() && isNativeHlsSupported(video)) {
        this.nativeFallbackSource = useDirect ? { ...videoData, src: videoData.src } : videoData;
        video.src = playSrc;
        video.load();
        this.manifestReady = true;
        this.callbacks.onLevels?.([], -1);
      } else if (Hls && Hls.isSupported()) {
        this.initHls(source);
      } else if (isNativeHlsSupported(video)) {
        video.src = playSrc;
        video.load();
        this.manifestReady = true;
        this.callbacks.onLevels?.([], -1);
      } else {
        this.callbacks.onError?.("当前浏览器不支持 HLS 播放，请使用 Chrome / Edge / Safari 最新版");
      }
    } else {
      // 无后缀的直播地址（live/12345 这种）服务端按 file 处理，实际内容
      // 常常是 HLS：桌面浏览器原生播不了，失败时用 hls.js 兜一次
      // （iOS 原生支持 HLS，不会走到这；flv 没有播放器，兜完照样报错）。
      this.nativeFallbackSource = { ...source, kind: "hls" };
      video.src = playSrc;
      video.load();
      this.manifestReady = true;
      this.callbacks.onLevels?.([], -1);
    }
  }

  setDirectMode(enabled) {
    const next = Boolean(enabled);
    const changed = next !== this.directPref;
    this.directPref = next;
    try {
      localStorage.setItem(DIRECT_KEY, this.directPref ? "1" : "0");
    } catch {
      // ignore
    }
    // 设置没变就别重载，否则每次保存设置都会从头播一遍
    if (!changed || !this.videoData) return;
    if (this.directPref && !this.videoData.directSrc) {
      this.callbacks.onTransientError?.("这个播放源没有可直连的地址，继续走服务器");
      return;
    }
    const time = this.video.currentTime || 0;
    const wasPlaying = !this.video.paused;
    this.load(this.videoData, { forceProxy: !this.directPref }).then(() => {
      if (time > 0) this.seekSafely(time, { suppressBuffering: true });
      if (wasPlaying) this.tryPlay();
    });
  }

  fallbackToProxy(message) {
    if (!this.videoData || !this.proxySrc || !this.usingDirect) return;
    const time = this.video.currentTime || 0;
    const wasPlaying = !this.video.paused;
    // Live channels usually have no CORS. A failed direct attempt there is
    // expected, so don't interrupt the viewer with a toast before falling back.
    if (!this.videoData.isLive) this.callbacks.onTransientError?.(message);
    this.usingDirect = false;
    const data = this.videoData;
    this.load(data, { forceProxy: true }).then(() => {
      if (time > 0) this.seekSafely(time, { suppressBuffering: true });
      if (wasPlaying) this.tryPlay();
    });
  }

  initHls(videoData) {
    const isLive = Boolean(videoData.isLive);
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      capLevelToPlayerSize: false,
      startLevel: -1,
      maxBufferLength: isLive ? 24 : 40,
      maxMaxBufferLength: isLive ? 48 : 90,
      backBufferLength: isLive ? 10 : 60,
      abrEwmaDefaultEstimate: 8_000_000,
      manifestLoadingTimeOut: 25000,
      levelLoadingTimeOut: 25000,
      fragLoadingTimeOut: 35000,
      liveSyncDurationCount: isLive ? 2 : 3,
      liveMaxLatencyDurationCount: isLive ? 5 : 8,
    });
    this.hls = hls;
    hls.attachMedia(this.video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      hls.loadSource(videoData.src);
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.manifestReady = true;
      this.levels = hls.levels || [];
      this.applyPreferredLevel();
      this.callbacks.onLevels?.(this.getLevels(), this.getCurrentLevel());
      this.callbacks.onDuration?.(this.getDuration());
      this.flushPending();
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
      this.callbacks.onLevel?.(
        this.getLevels().find((level) => level.index === data.level) || null,
        this.getCurrentLevel(),
      );
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (this.usingDirect) {
        setTimeout(() => this.fallbackToProxy("直连线路不可用，已切回服务器代理"), 0);
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.recoverCount < 2) {
        this.recoverCount += 1;
        this.callbacks.onTransientError?.("网络抖动，正在重连视频流…");
        setTimeout(() => {
          try {
            hls.startLoad();
          } catch {
            // ignore
          }
        }, 900);
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.recoverCount < 2) {
        this.recoverCount += 1;
        try {
          hls.recoverMediaError();
          this.callbacks.onTransientError?.("正在恢复解码…");
          return;
        } catch {
          // fall through
        }
      }
      this.callbacks.onError?.(this.describeHlsError(data));
    });
  }

  describeHlsError(data) {
    const details = data?.details || "";
    if (/manifestLoadError|levelLoadError|fragLoadError/i.test(details)) {
      return "视频流加载失败，可能是播放地址过期、防盗链或网络问题";
    }
    if (/keyLoadError|keySystem/i.test(details)) {
      return "加密密钥加载失败，这个源可能需要登录或无法直接播放";
    }
    if (/bufferAppendError|bufferStalledError/i.test(details)) {
      return "视频解码失败，试试切换清晰度或换一个源";
    }
    return "播放出错，试试切换清晰度或重新解析";
  }

  getDuration() {
    const duration = this.video.duration;
    if (Number.isFinite(duration) && duration > 0) return duration;
    if (Number.isFinite(this.videoData?.duration) && this.videoData.duration > 0) return this.videoData.duration;
    return null;
  }

  getLevels() {
    if (!this.hls || !this.levels.length) return [];
    return [
      { index: -1, label: "自动", height: null, bitrate: null, auto: true },
      ...[...this.levels]
        .map((level, index) => {
          let label;
          if (level.height) label = `${level.height}P`;
          else if (level.name) label = String(level.name);
          else if (level.bitrate > 0) label = `${Math.round(level.bitrate / 1000)}kbps`;
          else label = "标准";
          return {
            index,
            label,
            height: level.height || null,
            bitrate: level.bitrate || null,
            width: level.width || null,
          };
        })
        .sort((a, b) => (b.height || 0) - (a.height || 0)),
    ];
  }

  getCurrentLevel() {
    if (!this.hls) return -1;
    if (this.hls.autoLevelEnabled) return -1;
    return this.hls.currentLevel;
  }

  qualityHeight() {
    if (!this.hls) return null;
    if (this.hls.currentLevel === -1) return null;
    return this.hls.levels?.[this.hls.currentLevel]?.height || null;
  }

  setQualityPreference(value) {
    this.qualityPref = String(value);
    try {
      localStorage.setItem(QUALITY_KEY, this.qualityPref);
    } catch {
      // ignore
    }
    this.applyPreferredLevel();
  }

  applyPreferredLevel() {
    if (!this.hls || !this.hls.levels?.length) return;
    if (this.qualityPref === "auto") {
      this.hls.currentLevel = -1;
      return;
    }
    let target;
    if (this.qualityPref === "highest") {
      target = this.hls.levels.reduce(
        (best, level, index) => ((level.height || 0) > (this.hls.levels[best]?.height || 0) ? index : best),
        0,
      );
    } else {
      const height = Number(this.qualityPref);
      target = this.hls.levels.findIndex((level) => level.height === height);
    }
    if (target >= 0) this.hls.currentLevel = target;
    else this.hls.currentLevel = -1;
  }

  setLevel(index) {
    if (!this.hls) return;
    const value = Number(index);
    if (value === -1) {
      this.hls.currentLevel = -1;
      this.setQualityPreference("auto");
    } else {
      const level = this.hls.levels?.[value];
      if (!level) return;
      this.hls.currentLevel = value;
      this.setQualityPreference(level.height || "auto");
    }
    this.callbacks.onLevels?.(this.getLevels(), this.getCurrentLevel());
  }

  /**
   * 消息里的 position 是「服务端发出那一刻」的位置。播放中如果直接拿它当目标，
   * 网络延迟（跨境常有 300ms）会让本地永远超前，补偿逻辑就会一直降速抖动。
   * 这里把消息在路上花掉的时间按倍速补回去。
   */
  /** 服务器上的"现在"。本机时钟不准时靠 ws 层算出的 offset 补正。 */
  serverNow() {
    return Date.now() + (this.clockOffset || 0);
  }

  setClockOffset(offset) {
    const next = Number(offset);
    if (!Number.isFinite(next)) return;
    this.clockOffset = next;
  }

  targetPosition(playback) {
    const base = Number(playback?.position) || 0;
    if (!playback?.playing) return base;
    const at = Number(playback.at) || 0;
    if (!at) return base;
    const rate = clamp(Number(playback.rate) || 1, 0.25, 3);
    const age = Math.max(0, Math.min(this.serverNow() - at, 8000)) / 1000;
    return base + age * rate;
  }

  applyPlayback(playback, { initial = false } = {}) {
    if (!playback) return;
    if (!this.manifestReady || !this.videoData) {
      this.pendingPlayback = { playback, initial };
      return;
    }
    const playing = Boolean(playback.playing);
    const rate = clamp(Number(playback.rate) || 1, 0.25, 3);
    const target = this.targetPosition(playback);
    this.baseRate = rate;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    if (Math.abs(this.video.playbackRate - rate) > 0.01) {
      this.video.playbackRate = rate;
    }
    // auto-wait 的暂停只翻状态、不跳位置：卡住端本地停在哪，那才是真实
    // 位置；服务端定格的是「最后心跳位置」，跳过去反而会打断缓冲。
    if (!this.videoData.isLive && playback.reason !== "buffering") {
      const current = this.video.currentTime;
      const diff = Math.abs(current - target);
      if (initial) {
        if (diff > 0.25) this.seekSafely(target, { suppressBuffering: true });
      } else if (diff > 1.2) {
        // 动作消息也走同一档死区：倍速/延迟下 transit 补偿有百毫秒级噪声，
        // 0.9 的老阈值会把这种噪声放大成反复 seek。
        // 用户刚拖过进度条的话先让路：TA 的 seek 广播可能还在路上，
        // 这时候按服务端旧位置硬跳，等于把用户甩回原地。
        // 只跳位置校正，播放/暂停状态下面照常翻。
        if (performance.now() - this.lastUserSeekAt >= 3000) {
          this.seekSafely(target, { suppressBuffering: true });
        }
      }
    }
    if (playing) {
      this.tryPlay();
    } else if (!this.video.paused) {
      this.video.pause();
    }
  }

  applySync(playback, { force = false } = {}) {
    if (!playback || !this.videoData || !this.manifestReady) return;
    const video = this.video;
    const rate = clamp(Number(playback.rate) || 1, 0.25, 3);
    const playing = Boolean(playback.playing);
    if (Math.abs(this.baseRate - rate) > 0.01) {
      this.baseRate = rate;
      if (this.nudgeTimer) {
        clearTimeout(this.nudgeTimer);
        this.nudgeTimer = null;
      }
      video.playbackRate = rate;
    }
    if (playing && video.paused) this.tryPlay();
    if (!playing && !video.paused) video.pause();
    if (!this.videoData.isLive) this.applyRate();
    if (this.videoData.isLive || this.userSeeking) return;
    if (video.readyState < 1 || video.seeking) return;
    const target = this.targetPosition(playback);
    const diff = video.currentTime - target;
    const now = performance.now();
    // 手动点「同步」时严格对齐，平时只在大偏差时才硬跳。
    if (force) {
      if (Math.abs(diff) > 0.25) {
        this.seekSafely(target, { suppressBuffering: true });
      }
      return;
    }
    // 无论谁是主持人，都以服务端时间为准：主持人掉队时也要追回来，
    // 否则他的本地播放一旦卡顿，整场都会跟着停在那里。
    // 但用户刚拖过进度条的 3 秒内例外——seek 广播可能乱序迟到，
    // 这时候拿旧位置硬跳，用户会被甩回原地（弱网下尤其明显）。
    if (performance.now() - this.lastUserSeekAt < 3000) return;
    if (Math.abs(diff) > (playing ? 1.2 : 1.2)) {
      // Hard seeks are expensive and can trigger a buffering pause. Only do
      // them when really out of sync, and at most once every 3 seconds.
      if (now - this.lastHardSeekAt > 3000) {
        this.lastHardSeekAt = now;
        this.seekSafely(target, { suppressBuffering: true });
      }
    } else if (playing && Math.abs(diff) > 0.15) {
      // 差得越多追得越狠（单次不超过 0.25 速率偏移，听不出来），
      // 并且没追平就接着追，不再等下一轮 sync。
      this.nudgeDiff = diff;
      const strength = Math.min(0.25, 0.06 + Math.abs(diff) * 0.12);
      this.nudgeRate(diff > 0 ? -strength : strength);
    } else {
      this.nudgeDiff = null;
    }
  }

  /** 把当前应有的倍速重新写进 video，浏览器偷偷改了也能纠回来。 */
  applyRate() {
    const video = this.video;
    if (!video) return;
    const wanted = this.nudgeTimer ? this.nudgeTarget : this.baseRate;
    if (!Number.isFinite(wanted)) return;
    if (Math.abs(video.playbackRate - wanted) > 0.02) {
      try {
        video.playbackRate = wanted;
      } catch {
        // 某些移动浏览器在不支持时抛错，忽略即可
      }
    }
  }

  nudgeRate(delta) {
    if (this.nudgeTimer) return;
    const original = this.baseRate;
    this.nudgeTarget = clamp(original + delta, 0.25, 3);
    this.video.playbackRate = this.nudgeTarget;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      this.nudgeTarget = null;
      if (Math.abs(this.video.playbackRate - original) > 0.02) this.video.playbackRate = original;
      // 还没追平就接着追：1 秒的偏差靠 0.06 的微调要追十几秒，
      // 期间一直挂在"校准中"。这里按剩余偏差自动续轮。
      const diff = this.nudgeDiff;
      if (diff && Math.abs(diff) > 0.15 && !this.video.paused && !this.video.seeking) {
        const strength = Math.min(0.25, 0.06 + Math.abs(diff) * 0.12);
        this.nudgeRate(diff > 0 ? -strength : strength);
      } else {
        this.nudgeDiff = null;
      }
    }, 2000);
  }

  seekSafely(position, { suppressBuffering = false } = {}) {
    const video = this.video;
    const target = Math.max(0, Number(position) || 0);
    if (suppressBuffering) this.suppressBufferingUntil = performance.now() + 2500;
    const apply = () => {
      try {
        const limit = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.15) : target;
        video.currentTime = Math.min(target, limit);
      } catch {
        // ignore
      }
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener("loadedmetadata", apply, { once: true });
  }

  tryPlay() {
    if (this.autoplayBlocked) return;
    if (!this.video.paused) return;
    const promise = this.video.play();
    if (promise && typeof promise.then === "function") {
      // iOS Safari 会忽略「未播放时」设置的 playbackRate，播放成功后补一次。
      promise.then(() => this.applyRate()).catch(() => {});
    }
    if (promise && typeof promise.catch === "function") {
      promise.catch((error) => {
        if (error?.name === "NotAllowedError") {
          this.autoplayBlocked = true;
          this.callbacks.onAutoplayBlocked?.();
        } else if (error?.name !== "AbortError") {
          this.callbacks.onError?.("播放失败，请点击播放按钮重试");
        }
      });
    }
  }

  play() {
    this.tryPlay();
  }

  forcePlay() {
    this.autoplayBlocked = false;
    this.tryPlay();
  }

  flushPending() {
    if (!this.pendingPlayback || !this.manifestReady) return;
    const pending = this.pendingPlayback;
    this.pendingPlayback = null;
    this.applyPlayback(pending.playback, { initial: pending.initial });
  }

  play() {
    this.tryPlay();
  }

  pause() {
    this.video.pause();
  }

  seek(position) {
    this.seekSafely(position);
  }

  setRate(rate) {
    const value = clamp(Number(rate) || 1, 0.25, 3);
    this.baseRate = value;
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    this.video.playbackRate = value;
  }

  setVolume(value, muted = false) {
    this.video.volume = clamp(Number(value), 0, 1);
    this.video.muted = Boolean(muted);
  }

  beginSeek() {
    this.userSeeking = true;
  }

  endSeek(position) {
    this.userSeeking = false;
    this.lastUserSeekAt = performance.now();
    if (Number.isFinite(position)) this.seek(position);
  }

  getBufferedEnd() {
    const video = this.video;
    if (!video.buffered || !video.buffered.length) return 0;
    const current = video.currentTime;
    let end = video.buffered.end(video.buffered.length - 1);
    for (let i = 0; i < video.buffered.length; i += 1) {
      if (video.buffered.start(i) <= current && video.buffered.end(i) >= current) {
        end = video.buffered.end(i);
        break;
      }
    }
    return end;
  }

  emitTime() {
    const now = performance.now();
    if (now - this.lastProgressAt < 120 && !this.video.seeking) return;
    this.lastProgressAt = now;
    this.callbacks.onTime?.({
      currentTime: this.video.currentTime || 0,
      duration: this.getDuration(),
      buffered: this.getBufferedEnd(),
      paused: this.video.paused,
    });
  }

  destroyHls() {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch {
        // ignore
      }
      this.hls = null;
    }
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
  }

  destroy() {
    if (this.controlsGuard) {
      clearInterval(this.controlsGuard);
      this.controlsGuard = null;
    }
    this.disableCanvasPaint();
    this.destroyHls();
    try {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    } catch {
      // ignore
    }
  }
}

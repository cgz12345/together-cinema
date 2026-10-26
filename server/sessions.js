import path from "node:path";
import config from "./config.js";
import { AppError, randomId, hmacSign, base64url, fromBase64url, safeEqual } from "./utils.js";

const FORWARDED_HEADER_NAMES = new Set([
  "referer",
  "origin",
  "user-agent",
  "cookie",
  "authorization",
  "accept",
  "accept-language",
]);

function sanitizeHeaders(input = {}) {
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (!FORWARDED_HEADER_NAMES.has(lower)) continue;
    if (typeof value !== "string" || !value) continue;
    if (value.length > 8192) continue;
    result[lower] = value;
  }
  return result;
}

export class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.timer = setInterval(() => this.cleanup(), 10 * 60 * 1000);
    this.timer.unref?.();
  }

  create({ url = "", headers = {}, kind = "file", isLive = false, title = "", duration = null, localPath = null }) {
    const id = randomId(18);
    const now = Date.now();
    const session = {
      id,
      url,
      headers: sanitizeHeaders(headers),
      kind,
      isLive,
      title,
      duration,
      localPath,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + config.sessionTtlMs,
    };
    this.sessions.set(id, session);
    if (this.sessions.size > 500) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
    return session;
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  entryPath(id) {
    return `/p/${id}/entry`;
  }

  childPath(id, absoluteUrl) {
    const encoded = base64url(absoluteUrl);
    const signature = hmacSign(config.secret, `${id}:${absoluteUrl}`);
    return `/p/${id}/${signature}/${encoded}`;
  }

  verifyChild(id, signature, encoded) {
    let absoluteUrl;
    try {
      absoluteUrl = fromBase64url(encoded);
    } catch {
      return null;
    }
    const expected = hmacSign(config.secret, `${id}:${absoluteUrl}`);
    if (!safeEqual(signature, expected)) return null;
    if (!/^https?:\/\//i.test(absoluteUrl)) return null;
    return absoluteUrl;
  }

  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

export class ResolvedStore {
  constructor(sessionStore) {
    this.sessions = sessionStore;
    this.results = new Map();
    this.timer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.timer.unref?.();
  }

  create(result) {
    const token = randomId(20);
    const now = Date.now();
    this.results.set(token, {
      ...result,
      token,
      createdAt: now,
      expiresAt: now + config.resolveTtlMs,
    });
    if (this.results.size > 200) {
      const oldest = [...this.results.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.results.delete(oldest.token);
    }
    return token;
  }

  get(token) {
    const result = this.results.get(token);
    if (!result) throw new AppError(404, "result_expired", "解析结果已过期，请重新解析");
    if (result.expiresAt <= Date.now()) {
      this.results.delete(token);
      throw new AppError(404, "result_expired", "解析结果已过期，请重新解析");
    }
    return result;
  }

  peek(token) {
    try {
      return this.get(token);
    } catch {
      return null;
    }
  }

  toVideo(token, candidateId, overrides = {}) {
    const result = this.get(token);
    const candidate =
      result.candidates.find((item) => item.id === candidateId) || result.candidates.find((item) => item.recommended);
    if (!candidate) throw new AppError(404, "candidate_missing", "播放源不存在，请重新解析");
    if (candidate.kind === "merge" && !candidate.localPath) {
      throw new AppError(409, "merge_required", "这个高清源需要先合并，请使用高清合并功能");
    }
    const overrideTitle =
      typeof overrides.title === "string" ? overrides.title.trim().slice(0, 200) : "";
    const overridePoster =
      typeof overrides.poster === "string" && /^https?:\/\//i.test(overrides.poster)
        ? overrides.poster.slice(0, 2048)
        : "";

    const session = this.sessions.create({
      url: candidate.url || "",
      headers: candidate.headers || {},
      kind: candidate.kind,
      isLive: Boolean(candidate.isLive || result.isLive),
      title: result.title,
      duration: result.duration,
      localPath: candidate.localPath || null,
    });

    const qualities = (candidate.qualities || []).map((item) => ({
      label: item.label,
      height: item.height || null,
      bandwidth: item.bandwidth || null,
    }));

    if (!qualities.length) {
      if (candidate.height) {
        qualities.push({ label: `${candidate.height}P`, height: candidate.height, bandwidth: null });
      } else {
        qualities.push({
          label: candidate.kind === "hls" ? "HLS 原始画质" : "原始画质",
          height: null,
          bandwidth: null,
        });
      }
    }

    return {
      id: randomId(8),
      title: overrideTitle || result.title || "未命名影片",
      poster: overridePoster || result.poster || null,
      duration: result.duration || null,
      pageUrl: result.pageUrl || null,
      kind: candidate.localPath ? "file" : candidate.kind,
      src: this.sessions.entryPath(session.id),
      directSrc: candidate.localPath || !candidate.url ? null : candidate.url,
      isLive: Boolean(candidate.isLive || result.isLive),
      qualities,
      addedAt: Date.now(),
    };
  }

  /** 取出重建播放会话所需的信息，供休眠房间唤醒时续期。 */
  describeSource(token, candidateId) {
    let result;
    try {
      result = this.get(token);
    } catch {
      return null;
    }
    const candidate =
      result.candidates.find((item) => item.id === candidateId) ||
      result.candidates.find((item) => item.recommended);
    if (!candidate) return null;
    return {
      url: candidate.url || "",
      headers: candidate.headers || {},
      kind: candidate.localPath ? "file" : candidate.kind,
      isLive: Boolean(candidate.isLive || result.isLive),
      title: result.title || "",
      duration: result.duration || null,
      localPath: candidate.localPath || null,
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [token, result] of this.results) {
      if (result.expiresAt <= now) this.results.delete(token);
    }
  }
}

export function localMediaPath(session) {
  if (!session.localPath) return null;
  return path.resolve(session.localPath);
}

/**
 * 房间无人时会休眠，休眠超过 sessionTtlMs（6 小时）后播放会话就过期了。
 * 醒来时用房间留存的源信息重建一个会话，玩家点开就能接着看，
 * 不会撞上「解析结果已过期」。
 */
export function refreshRoomVideo(room, store) {
  const video = room?.video;
  if (!video) return false;
  const match = /^\/p\/([^/]+)\/entry$/.exec(String(video.src || ""));
  if (match && store.get(match[1])) return false; // 会话还有效，不动
  const source = room.videoSource;
  if (!source) return false;
  try {
    const session = store.create({ ...source });
    video.src = store.entryPath(session.id);
    // Keep the direct-play URL in sync as well: signed/proxied URLs may be
    // refreshed, while direct mode bypasses the proxy entirely.
    video.directSrc = source.url || null;
    return true;
  } catch {
    return false;
  }
}


/** 用一条直链地址直接构造可播放的 video，跳过嗅探。 */
export function buildDirectVideo(store, { url, title = "", isLive = false, headers = {} }) {
  const isHls = /\.m3u8(?:$|[?#])/i.test(url);
  const cleanTitle = String(title || "").trim().slice(0, 80) || "影片";
  const session = store.create({
    url,
    headers,
    kind: isHls ? "hls" : "file",
    isLive: Boolean(isLive),
    title: cleanTitle,
    duration: null,
    localPath: null,
  });
  return {
    id: randomId(8),
    title: cleanTitle,
    poster: null,
    duration: null,
    pageUrl: null,
    kind: isHls ? "hls" : "file",
    src: store.entryPath(session.id),
    directSrc: url,
    isLive: Boolean(isLive),
    qualities: [{ label: isHls ? "HLS 原始画质" : "原始画质", height: null, bandwidth: null }],
    addedAt: Date.now(),
  };
}

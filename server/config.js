import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(serverDir, "..");

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(root, ".env"));

const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, "data"));
const publicDir = path.join(root, "public");
const tmpDir = path.join(dataDir, "tmp");
const uploadDir = path.join(dataDir, "uploads");

for (const dir of [dataDir, tmpDir, path.join(dataDir, "cache"), uploadDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const config = {
  root,
  serverDir,
  publicDir,
  dataDir,
  tmpDir,
  uploadDir,
  cacheDir: path.join(dataDir, "cache"),
  segmentCacheDir: path.join(dataDir, "cache", "segments"),
  segmentCacheMaxBytes: Number(process.env.SEGMENT_CACHE_MAX_BYTES || 1024 * 1024 * 1024),
  segmentCacheTtlMs: Number(process.env.SEGMENT_CACHE_TTL_MS || 6 * 60 * 60 * 1000),
  segmentCacheMaxSegmentBytes: Number(
    process.env.SEGMENT_CACHE_MAX_SEGMENT_BYTES || 64 * 1024 * 1024,
  ),

  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 3010),

  accessCode: (process.env.ACCESS_CODE || "").trim(),
  secret: process.env.SECRET || crypto.randomBytes(32).toString("hex"),

  ytDlp: process.env.YTDLP || "yt-dlp",
  ffmpeg: process.env.FFMPEG || "ffmpeg",

  resolveTimeoutMs: Number(process.env.RESOLVE_TIMEOUT_MS || 70000),
  resolveConcurrency: Math.max(1, Number(process.env.RESOLVE_CONCURRENCY || 2)),
  pageFetchTimeoutMs: Number(process.env.PAGE_FETCH_TIMEOUT_MS || 15000),
  streamFetchTimeoutMs: Number(process.env.STREAM_FETCH_TIMEOUT_MS || 20000),

  maxPageBytes: 3 * 1024 * 1024,
  maxPlaylistBytes: 6 * 1024 * 1024,
  maxJsonBytes: 64 * 1024 * 1024,
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 6 * 1024 * 1024),
  uploadTtlMs: Number(process.env.UPLOAD_TTL_MS || 7 * 24 * 60 * 60 * 1000),

  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000),
  resolveTtlMs: 45 * 60 * 1000,
  roomTtlMs: 24 * 60 * 60 * 1000,
  // 无人在线的房间不销毁，只休眠：保留播放链接、进度和聊天记录。
  // 休眠房间的保留期比活跃房间长，方便第二天接着看。
  sleepingRoomTtlMs: Number(process.env.SLEEPING_ROOM_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  offlineMemberTtlMs: 3 * 60 * 1000,

  mergeMaxConcurrent: Math.max(1, Number(process.env.MERGE_MAX_CONCURRENT || 1)),
  mergeTtlMs: 24 * 60 * 60 * 1000,
  mergeMaxBytes: Number(process.env.MERGE_MAX_BYTES || 6 * 1024 * 1024 * 1024),
  mergeEnabled: process.env.MERGE_ENABLED === "1",

  snifferUrl: (process.env.SNIFFER_URL || "").replace(/\/+$/, ""),
  snifferAuth: process.env.SNIFFER_AUTH || "",
  snifferTimeoutMs: Number(process.env.SNIFFER_TIMEOUT_MS || 30000),
  snifferExclude: process.env.SNIFFER_EXCLUDE || "obj/tos|loadjs|byteimg",
  browserSnifferHosts: (process.env.BROWSER_SNIFFER_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),

  discoverySources: (() => {
    const raw = process.env.DISCOVERY_SOURCES || "";
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (item) =>
            item &&
            typeof item.name === "string" &&
            typeof item.api === "string" &&
            /^https?:\/\//i.test(item.api),
        )
        .slice(0, 6)
        .map((item) => ({ name: item.name.slice(0, 40), api: item.api }));
    } catch {
      return [];
    }
  })(),
  discoveryTimeoutMs: Number(process.env.DISCOVERY_TIMEOUT_MS || 15000),

  // One-click built-in live TV source. Override with your own m3u URL if the
  // public list is unreachable from your server.
  builtinLiveName: process.env.BUILTIN_LIVE_NAME || "内置 · 央卫",
  builtinLiveList:
    process.env.BUILTIN_LIVE_LIST || "https://iptv-org.github.io/iptv/countries/cn.m3u",

  userAgent:
    process.env.USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  allowPrivateUrls: process.env.ALLOW_PRIVATE_URLS === "1",
  version: "1.0.0",

  // 连麦用的 ICE 服务器。默认三个公共 STUN；若配置了 TURN（coturn），
  // 对称 NAT / 4G 下直连不通时自动走中继。可用 ICE_SERVERS 环境变量整段覆盖。
  iceServers: (() => {
    const raw = process.env.ICE_SERVERS;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // 标准 WebRTC 里 urls 既可以是字符串也可以是数组，两种都接受并归一化成数组
        const ok =
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every((item) => item && (typeof item.urls === "string" || Array.isArray(item.urls)));
        if (ok) return parsed.map((item) => ({ ...item, urls: typeof item.urls === "string" ? [item.urls] : item.urls }));
      } catch {
        // 解析失败就退回默认
      }
    }
    return [
      { urls: "stun:stun.qq.com:3478" },
      { urls: "stun:stun.miwifi.com:3478" },
      { urls: "stun:stun.l.google.com:19302" },
    ];
  })(),
};

export default config;

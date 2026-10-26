import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import config from "./config.js";

export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function normalizeUrl(input) {
  if (typeof input !== "string") throw new AppError(400, "bad_url", "链接格式不正确");
  let value = input.trim();
  if (!value) throw new AppError(400, "bad_url", "请输入链接");
  if (value.length > 4096) throw new AppError(400, "bad_url", "链接过长");
  if (!/^https?:\/\//i.test(value)) {
    if (/^\/\//.test(value)) value = `https:${value}`;
    else value = `https://${value}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, "bad_url", "链接无法解析");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "bad_url", "只支持 http/https 链接");
  }
  if (url.username || url.password) {
    throw new AppError(400, "bad_url", "链接里不要包含用户名密码");
  }
  url.hash = "";
  return url.toString();
}

const PRIVATE_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function isPrivateIp(ip) {
  if (!net.isIP(ip)) return true;
  if (net.isIPv4(ip)) {
    return PRIVATE_V4.some(([base, prefix]) => inV4Range(ip, base, prefix));
  }
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith("2001:db8:")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7));
  return false;
}

const dnsCache = new Map();
const DNS_CACHE_MS = 60 * 1000;

async function lookupHost(hostname) {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > now) return cached.addresses;
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  const list = addresses.map((item) => item.address);
  dnsCache.set(hostname, { addresses: list, expires: now + DNS_CACHE_MS });
  if (dnsCache.size > 500) {
    for (const [key, value] of dnsCache) {
      if (value.expires <= now) dnsCache.delete(key);
    }
  }
  return list;
}

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa"];

export async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError(400, "bad_url", "链接无法解析");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "blocked_url", "只允许访问 http/https 地址");
  }
  if (config.allowPrivateUrls) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new AppError(400, "blocked_url", "链接缺少域名");
  const lower = host.toLowerCase();
  if (lower === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    throw new AppError(400, "blocked_url", "不允许访问内网地址");
  }
  if (net.isIP(lower)) {
    if (isPrivateIp(lower)) throw new AppError(400, "blocked_url", "不允许访问内网地址");
    return url;
  }
  let addresses;
  try {
    addresses = await lookupHost(lower);
  } catch {
    throw new AppError(400, "dns_error", `域名解析失败：${host}`);
  }
  if (!addresses.length) throw new AppError(400, "dns_error", `域名解析失败：${host}`);
  if (addresses.some((ip) => isPrivateIp(ip))) {
    throw new AppError(400, "blocked_url", "不允许访问内网地址");
  }
  return url;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export async function openUpstream(
  rawUrl,
  {
    headers = {},
    method = "GET",
    timeoutMs = 20000,
    maxRedirects = 6,
    signal: externalSignal = null,
  } = {},
) {
  let current = rawUrl;
  let currentMethod = method;
  let controller = null;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicHttpUrl(current);
    controller = new AbortController();
    let timer = null;
    const onExternalAbort = () => controller.abort(externalSignal?.reason || "aborted");
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort("upstream timeout"), timeoutMs);
    }
    let response;
    try {
      response = await fetch(current, {
        method: currentMethod,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      if (error?.name === "AbortError") {
        throw new AppError(504, "upstream_timeout", "上游服务器响应超时");
      }
      throw new AppError(502, "upstream_error", `无法连接上游：${error?.message || "网络错误"}`);
    }
    if (timer) clearTimeout(timer);

    if (REDIRECT_CODES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      if (!location) throw new AppError(502, "bad_redirect", "上游返回了空重定向");
      current = new URL(location, current).toString();
      if (response.status === 303) currentMethod = "GET";
      continue;
    }
    return { response, finalUrl: current, controller };
  }
  throw new AppError(502, "too_many_redirects", "上游重定向次数过多");
}

export async function readResponseLimited(response, maxBytes) {
  if (!response.body) return { buffer: Buffer.alloc(0), text: "" };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AppError(413, "body_too_large", "上游内容过大");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  const buffer = Buffer.concat(chunks, total);
  return { buffer, text: "" };
}

export function charsetFromContentType(contentType = "") {
  const match = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType);
  return match ? match[1].trim().toLowerCase() : "";
}

export function decodeBuffer(buffer, contentType = "", headSample = "") {
  const candidates = [];
  const fromHeader = charsetFromContentType(contentType);
  if (fromHeader) candidates.push(fromHeader);
  const head = headSample || buffer.subarray(0, 4096).toString("latin1");
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_-]+)/i.exec(head);
  if (meta) candidates.push(meta[1].toLowerCase());
  candidates.push("utf-8");
  for (const charset of candidates) {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(buffer);
    } catch {
      // try the next charset
    }
  }
  return buffer.toString("utf8");
}

export function isMediaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase();
    if (/\.(m3u8|mp4|flv|webm|mkv|mov|m4v)$/.test(path)) return true;
    if (/\.(m3u8|mp4|flv|webm|mkv)(?:$|[?&#])/i.test(url.search)) return true;
    return false;
  } catch {
    return false;
  }
}

export function resolveMaybeRelative(value, baseUrl) {
  if (!value) return "";
  let cleaned = value
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/")
    .replace(/&quot;/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\\u002f/gi, "/");
  if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("blob:") || cleaned.startsWith("javascript:")) {
    return "";
  }
  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return "";
  }
}

export function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomCode(length = 6) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

export function base64url(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function fromBase64url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

export function hmacSign(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url").slice(0, 24);
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  take(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }
}

export function publicIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)}${units[index]}`;
}

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

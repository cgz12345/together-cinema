import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import config from "./config.js";
import {
  AppError,
  normalizeUrl,
  assertPublicHttpUrl,
  openUpstream,
  readResponseLimited,
  decodeBuffer,
  resolveMaybeRelative,
  randomId,
  Semaphore,
  clamp,
  isMediaUrl,
} from "./utils.js";

const execFileAsync = promisify(execFile);

const MEDIA_EXT_RE = /\.(m3u8|mp4|flv|webm|mkv|mov|m4v)(?:$|[?#])/i;
const ABSOLUTE_MEDIA_RE =
  /(?:https?:)?\/\/[^\s"'`<>\\)]+?\.(?:m3u8|mp4|flv|webm|mkv|mov|m4v)(?:\?[^\s"'`<>\\)]*)?/gi;
const RELATIVE_MEDIA_RE =
  /(["'`])((?:\/|\.{1,2}\/)[^"'`\s<>]+?\.(?:m3u8|mp4|flv|webm|mkv|mov|m4v)(?:\?[^"'`\s<>]*)?)\1/gi;
const M3U8_ANY_RE = /(?:https?:)?\/\/[^\s"'`<>\\)]+m3u8[^\s"'`<>\\)]*/gi;
const TAG = /<[^>]+>/g;

const BROWSER_HEADERS = {
  "user-agent": config.userAgent,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

function decodeEntities(value = "") {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeEscapes(value = "") {
  return value
    .replace(/\\u002f/gi, "/")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/\\u003a/gi, ":")
    .replace(/&amp;/g, "&");
}

function stripTags(value = "") {
  return decodeEntities(value.replace(TAG, " ")).replace(/\s+/g, " ").trim();
}

function scanBalanced(text, start) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "";
}

function decodePossiblyEncoded(rawValue) {
  let value = String(rawValue || "").trim();
  for (let round = 0; round < 3; round += 1) {
    if (/^https?:\/\//i.test(value)) return value;
    if (/%3A|%2F|%3F|%3D/i.test(value)) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded !== value) {
          value = decoded;
          continue;
        }
      } catch {
        // fall through
      }
    }
    if (/^[A-Za-z0-9+/=_-]{16,}$/.test(value)) {
      try {
        const decoded = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) {
          value = decoded;
          continue;
        }
      } catch {
        // fall through
      }
    }
    break;
  }
  return value;
}

function parseAttrs(input) {
  const attrs = {};
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /[,\s]/.test(input[index])) index += 1;
    const eq = input.indexOf("=", index);
    if (eq < 0) break;
    const key = input.slice(index, eq).trim().toUpperCase();
    let cursor = eq + 1;
    let value = "";
    if (input[cursor] === '"') {
      cursor += 1;
      const end = input.indexOf('"', cursor);
      if (end < 0) break;
      value = input.slice(cursor, end);
      index = end + 1;
    } else {
      let end = input.indexOf(",", cursor);
      if (end < 0) end = input.length;
      value = input.slice(cursor, end).trim();
      index = end + 1;
    }
    if (key) attrs[key] = value;
    while (index < input.length && input[index] === ",") index += 1;
  }
  return attrs;
}

export function parseHlsPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  let duration = 0;
  let hasEndList = false;
  let playlistType = "";
  let targetDuration = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttrs(line.slice("#EXT-X-STREAM-INF:".length));
      let cursor = i + 1;
      while (cursor < lines.length) {
        const next = lines[cursor].trim();
        if (next && !next.startsWith("#")) break;
        cursor += 1;
      }
      const uri = lines[cursor]?.trim();
      if (uri && !uri.startsWith("#")) {
        const absolute = resolveMaybeRelative(uri, baseUrl);
        if (absolute) {
          const resolution = (attrs.RESOLUTION || "").toLowerCase().split("x");
          variants.push({
            url: absolute,
            width: Number(resolution[0]) || null,
            height: Number(resolution[1]) || null,
            bandwidth: Number(attrs.BANDWIDTH) || Number(attrs["AVERAGE-BANDWIDTH"]) || null,
            name: attrs.NAME || null,
            codecs: attrs.CODECS || null,
            frameRate: Number(attrs["FRAME-RATE"]) || null,
          });
        }
      }
    } else if (line.startsWith("#EXTINF:")) {
      const value = Number.parseFloat(line.slice("#EXTINF:".length));
      if (Number.isFinite(value)) duration += value;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      hasEndList = true;
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number.parseFloat(line.slice("#EXT-X-TARGETDURATION:".length)) || null;
    } else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      playlistType = line.slice("#EXT-X-PLAYLIST-TYPE:".length).trim().toUpperCase();
    }
  }

  const isMaster = variants.length > 0;
  const heights = variants.map((variant) => variant.height).filter(Boolean);
  const bandwidths = variants.map((variant) => variant.bandwidth).filter(Boolean);
  return {
    isMaster,
    variants,
    height: heights.length ? Math.max(...heights) : null,
    bandwidth: bandwidths.length ? Math.max(...bandwidths) : null,
    duration: duration > 0 ? duration : null,
    isLive: !isMaster && !hasEndList && playlistType !== "VOD",
    targetDuration,
  };
}

function extractTitle(html, fallbackUrl) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og) return stripTags(og[1]);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) {
    const cleaned = stripTags(title[1]);
    if (cleaned) return cleaned.slice(0, 200);
  }
  try {
    const url = new URL(fallbackUrl);
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || url.hostname);
  } catch {
    return "";
  }
}

function extractPoster(html, pageUrl) {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      const abs = resolveMaybeRelative(decodeEntities(match[1]), pageUrl);
      if (abs) return abs;
    }
  }
  return null;
}

function extractDuration(html) {
  const patterns = [
    /<meta[^>]+property=["']og:video:duration["'][^>]+content=["']([0-9.]+)["']/i,
    /<meta[^>]+property=["']video:duration["'][^>]+content=["']([0-9.]+)["']/i,
    /"duration"\s*:\s*"?([0-9.]+)"?/i,
    /itemprop=["']duration["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (!match) continue;
    if (match[1].includes(":")) {
      const parts = match[1].split(":").map(Number);
      if (parts.every(Number.isFinite)) {
        return parts.reduce((acc, part) => acc * 60 + part, 0);
      }
    }
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function collectFromPlayerConfig(obj, baseUrl, streams, nestedPages, players) {
  if (!obj || typeof obj !== "object") return;
  if (typeof obj.from === "string" && obj.from && typeof obj.url === "string" && obj.url) {
    players.push({ from: obj.from, url: obj.url });
  }
  const keys = ["url", "url_next", "url_pre", "play_url", "video_url", "m3u8", "mp4", "link", "src", "file"];
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw !== "string" || !raw) continue;
    const decoded = decodePossiblyEncoded(decodeEntities(raw));
    if (!decoded) continue;
    const absolute = resolveMaybeRelative(decoded, baseUrl);
    if (!absolute) continue;
    if (isMediaUrl(absolute) || /m3u8/i.test(absolute)) {
      streams.push(absolute);
    } else if (/^https?:\/\//i.test(absolute) && !/\.(?:js|css|png|jpe?g|webp|gif|svg)$/i.test(absolute)) {
      nestedPages.push(absolute);
    }
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectFromPlayerConfig(item, baseUrl, streams, nestedPages, players);
    } else if (value && typeof value === "object") {
      collectFromPlayerConfig(value, baseUrl, streams, nestedPages, players);
    }
  }
}

export function extractFromHtml(html, pageUrl) {
  const streams = [];
  const iframes = [];
  const nestedPages = [];
  const scripts = [];
  const players = [];
  const raw = normalizeEscapes(html);

  for (const match of raw.matchAll(ABSOLUTE_MEDIA_RE)) {
    const absolute = resolveMaybeRelative(match[0], pageUrl);
    if (absolute) streams.push(absolute);
  }
  for (const match of raw.matchAll(M3U8_ANY_RE)) {
    const absolute = resolveMaybeRelative(match[0], pageUrl);
    if (absolute) streams.push(absolute);
  }
  for (const match of raw.matchAll(RELATIVE_MEDIA_RE)) {
    const absolute = resolveMaybeRelative(match[2], pageUrl);
    if (absolute) streams.push(absolute);
  }

  const tagPattern = /<(video|source|embed|object)\b([^>]*)>/gi;
  for (const match of raw.matchAll(tagPattern)) {
    const attrs = match[2];
    const attrPattern = /\b(?:src|data-src|data-url|data-video|data)=\s*["']([^"']+)["']/gi;
    for (const attr of attrs.matchAll(attrPattern)) {
      const absolute = resolveMaybeRelative(attr[1], pageUrl);
      if (absolute && (isMediaUrl(absolute) || /m3u8/i.test(absolute))) streams.push(absolute);
    }
  }

  const iframePattern = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of raw.matchAll(iframePattern)) {
    const absolute = resolveMaybeRelative(match[1], pageUrl);
    if (absolute) iframes.push(absolute);
  }

  const scriptPattern = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of raw.matchAll(scriptPattern)) {
    const absolute = resolveMaybeRelative(match[1], pageUrl);
    if (absolute) scripts.push(absolute);
  }

  const dataAttrPattern = /\b(?:data-url|data-src|data-video|data-play)\s*=\s*["']([^"']+)["']/gi;
  for (const match of raw.matchAll(dataAttrPattern)) {
    const absolute = resolveMaybeRelative(match[1], pageUrl);
    if (absolute && (isMediaUrl(absolute) || /m3u8/i.test(absolute))) streams.push(absolute);
  }

  const metaPatterns = [
    /<meta[^>]+property=["']og:video(?::url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+itemprop=["']contentUrl["'][^>]+content=["']([^"']+)["']/gi,
  ];
  for (const pattern of metaPatterns) {
    for (const match of raw.matchAll(pattern)) {
      const absolute = resolveMaybeRelative(decodeEntities(match[1]), pageUrl);
      if (absolute) streams.push(absolute);
    }
  }

  const playerPattern = /player_[a-zA-Z0-9]+\s*=\s*\{/g;
  for (const match of raw.matchAll(playerPattern)) {
    const start = raw.indexOf("{", match.index);
    const objectText = scanBalanced(raw, start);
    if (!objectText) continue;
    try {
      const parsed = JSON.parse(decodeEntities(objectText));
      collectFromPlayerConfig(parsed, pageUrl, streams, nestedPages, players);
    } catch {
      // Not valid JSON, try a couple of common assignments below.
    }
  }

  const jsonKeyPattern =
    /["'](?:url|src|file|play_url|video_url|m3u8|mp4|stream_url)["']\s*:\s*["']([^"']+)["']/gi;
  for (const match of raw.matchAll(jsonKeyPattern)) {
    const decoded = decodePossiblyEncoded(decodeEntities(match[1]));
    const absolute = resolveMaybeRelative(decoded, pageUrl);
    if (absolute && (isMediaUrl(absolute) || /m3u8/i.test(absolute))) streams.push(absolute);
  }

  const assignmentPattern = /\b(?:url|src|file|playUrl|videoUrl|streamUrl)\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of raw.matchAll(assignmentPattern)) {
    const decoded = decodePossiblyEncoded(decodeEntities(match[1]));
    const absolute = resolveMaybeRelative(decoded, pageUrl);
    if (absolute && (isMediaUrl(absolute) || /m3u8/i.test(absolute))) streams.push(absolute);
  }

  const uniqueStreams = [...new Set(streams.filter((item) => /^https?:\/\//i.test(item)))];
  const uniqueIframes = [...new Set(iframes.filter((item) => /^https?:\/\//i.test(item)))];
  const uniqueNested = [...new Set(nestedPages.filter((item) => /^https?:\/\//i.test(item)))];

  return {
    streams: uniqueStreams,
    iframes: uniqueIframes,
    nestedPages: uniqueNested,
    scripts: [...new Set(scripts.filter((item) => /^https?:\/\//i.test(item)))],
    players: [
      ...new Map(
        players
          .filter((item) => /^[a-zA-Z0-9_-]{1,32}$/.test(item.from))
          .map((item) => [`${item.from}|${item.url}`, item]),
      ).values(),
    ],
    title: extractTitle(raw, pageUrl),
    poster: extractPoster(raw, pageUrl),
    duration: extractDuration(raw),
  };
}

function netscapeCookieLines(input) {
  return input
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("# ") && !line.startsWith("#Netscape"))
    .filter((line) => line.split("\t").length >= 7);
}

export function cookieHeaderForHost(input, hostname) {
  if (!input) return "";
  const host = hostname.toLowerCase().replace(/^\./, "");
  const netscape = netscapeCookieLines(input);
  if (netscape.length) {
    const pairs = [];
    for (const line of netscape) {
      const parts = line.split("\t");
      let domain = parts[0].toLowerCase();
      const isHttpOnly = domain.startsWith("#httponly_");
      if (isHttpOnly) domain = domain.slice("#httponly_".length);
      domain = domain.replace(/^\./, "");
      const name = parts[5];
      const value = parts[6];
      if (!name) continue;
      if (host === domain || host.endsWith(`.${domain}`)) pairs.push(`${name}=${value}`);
    }
    return pairs.join("; ");
  }
  const cleaned = input.replace(/\r/g, "").trim();
  if (!cleaned) return "";
  if (/^cookie\s*:/i.test(cleaned)) return cleaned.replace(/^cookie\s*:\s*/i, "");
  return cleaned
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("; ");
}

async function writeCookieFile(input, targetUrl) {
  if (!input || !input.trim()) return null;
  const url = new URL(targetUrl);
  const host = url.hostname;
  const file = path.join(config.tmpDir, `cookies-${randomId(8)}.txt`);
  const netscape = netscapeCookieLines(input);
  let content;
  if (netscape.length) {
    content = input.startsWith("# Netscape") ? input : `# Netscape HTTP Cookie File\n${input}`;
  } else {
    const header = cookieHeaderForHost(input, host);
    const lines = header
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 1) return "";
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        return `.${host}\tTRUE\t/\tFALSE\t0\t${name}\t${value}`;
      })
      .filter(Boolean);
    content = `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`;
  }
  await fs.writeFile(file, content, { mode: 0o600 });
  return file;
}

export class Resolver {
  constructor(sessionStore, resolvedStore) {
    this.sessions = sessionStore;
    this.resolved = resolvedStore;
    this.semaphore = new Semaphore(config.resolveConcurrency);
  }

  async resolve(rawUrl, { cookies = "", onProgress = null } = {}) {
    const release = await this.semaphore.acquire();
    try {
      return await this.#resolveInner(rawUrl, { cookies, onProgress });
    } finally {
      release();
    }
  }

  async #resolveInner(rawUrl, { cookies, onProgress }) {
    const report = (stage, message) => {
      if (!onProgress) return;
      try {
        onProgress({ stage, message });
      } catch {
        // progress reporting must never break resolution
      }
    };
    report("check", "检查链接…");
    const pageUrl = normalizeUrl(rawUrl);
    const pageHost = new URL(pageUrl).hostname.toLowerCase();
    const browserAllowed = config.browserSnifferHosts.includes(pageHost);
    if (!browserAllowed) await assertPublicHttpUrl(pageUrl);
    const hints = [];
    const host = pageHost;
    const known = /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|b23\.tv|vimeo\.com|dailymotion\.com|twitch\.tv|v\.qq\.com|iqiyi\.com|youku\.com|mgtv\.com|acfun\.cn|twitter\.com|x\.com|facebook\.com|instagram\.com|tiktok\.com|douyin\.com|reddit\.com|soundcloud\.com|odysee\.com|peertube\.tv)$/i.test(
      host,
    );

    let browserTried = false;
    if (browserAllowed && config.snifferUrl) {
      browserTried = true;
      report("browser", "启动 Playwright 浏览器嗅探…");
      try {
        const sniffed = await this.#browserSniff(pageUrl, cookies, report);
        if (sniffed.candidates.length) {
          return this.#store(this.#buildBrowserResult(pageUrl, pageHost, sniffed));
        }
        hints.push("Playwright 浏览器嗅探没有找到播放地址");
      } catch (error) {
        hints.push(`Playwright 浏览器嗅探：${error.message}`);
      }
    }

    if (isMediaUrl(pageUrl)) {
      report("direct", "尝试直接读取播放地址…");
      try {
        const cookie = cookieHeaderForHost(cookies, host);
        const candidate = await this.#probeMedia(pageUrl, {
          Referer: new URL(pageUrl).origin + "/",
          "User-Agent": config.userAgent,
          ...(cookie ? { Cookie: cookie } : {}),
        });
        if (candidate) {
          report("direct", "直链可用，读取清晰度…");
          const title = decodeURIComponent(new URL(pageUrl).pathname.split("/").filter(Boolean).pop() || host);
          const result = this.#buildResult({
            pageUrl,
            title,
            poster: null,
            duration: candidate.duration,
            isLive: candidate.isLive,
            candidates: [candidate],
          });
          return this.#store(result);
        }
      } catch (error) {
        hints.push(`直链读取失败：${error.message}`);
      }
    }

    if (known) {
      report("ytdlp", "调用 yt-dlp 解析站点…");
      try {
        const info = await this.#ytdlp(pageUrl, cookies);
        const candidates = this.#candidatesFromYtdlp(info, pageUrl);
        if (candidates.length) {
          return this.#store(
            this.#buildResult({
              pageUrl,
              title: info.title || extractTitle("", pageUrl),
              poster: info.thumbnail || null,
              duration: Number.isFinite(info.duration) ? info.duration : null,
              isLive: Boolean(info.is_live),
              candidates,
              note: this.#ytdlpNote(candidates, info),
            }),
          );
        }
        hints.push("yt-dlp 没有找到可直接播放的格式");
      } catch (error) {
        hints.push(`yt-dlp：${error.message}`);
      }
    }

    try {
      report("page", "抓取页面并扫描播放地址…");
      const page = await this.#sniffPage(pageUrl, cookies, report);
      if (page.candidates.length) {
        report("probe", `确认 ${page.candidates.length} 个可播放源`);
        return this.#store(
          this.#buildResult({
            pageUrl,
            title: page.title || host,
            poster: page.poster,
            duration: page.duration,
            isLive: page.isLive,
            candidates: page.candidates,
            note: page.note,
          }),
        );
      }
      hints.push("页面里没有找到 .m3u8 / .mp4 播放地址");
    } catch (error) {
      hints.push(`网页嗅探：${error.message}`);
    }

    if (!known) {
      report("ytdlp", "调用 yt-dlp 兜底解析…");
      try {
        const info = await this.#ytdlp(pageUrl, cookies);
        const candidates = this.#candidatesFromYtdlp(info, pageUrl);
        if (candidates.length) {
          return this.#store(
            this.#buildResult({
              pageUrl,
              title: info.title || host,
              poster: info.thumbnail || null,
              duration: Number.isFinite(info.duration) ? info.duration : null,
              isLive: Boolean(info.is_live),
              candidates,
              note: this.#ytdlpNote(candidates, info),
            }),
          );
        }
        hints.push("yt-dlp 没有找到可直接播放的格式");
      } catch (error) {
        hints.push(`yt-dlp：${error.message}`);
      }
    }

    if (!browserTried && config.snifferUrl) {
      browserTried = true;
      report("browser", "启动 Playwright 浏览器兜底嗅探…");
      try {
        const sniffed = await this.#browserSniff(pageUrl, cookies, report);
        if (sniffed.candidates.length) {
          return this.#store(this.#buildBrowserResult(pageUrl, pageHost, sniffed));
        }
        hints.push("Playwright 浏览器嗅探没有找到播放地址");
      } catch (error) {
        hints.push(`Playwright 浏览器嗅探：${error.message}`);
      }
    }

    report("error", "没有找到可播放的地址");
    throw new AppError(
      422,
      "no_stream",
      "没有找到可播放的地址。可能是登录/会员内容、DRM 加密，或者站点用了浏览器脚本动态生成播放地址。",
      { hints: hints.slice(0, 6) },
    );
  }

  #buildBrowserResult(pageUrl, pageHost, sniffed) {
    return this.#buildResult({
      pageUrl,
      title: pageHost,
      poster: null,
      duration: sniffed.candidates[0]?.duration || null,
      isLive: Boolean(sniffed.candidates[0]?.isLive),
      candidates: sniffed.candidates,
      note: "Playwright 浏览器嗅探",
    });
  }

  async #browserSniff(pageUrl, cookies, report = null) {
    if (!config.snifferUrl) throw new AppError(503, "sniffer_disabled", "浏览器嗅探未配置");
    const target = new URL(pageUrl);
    const headerMap = {
      "user-agent": config.userAgent,
      referer: `${target.origin}/`,
    };
    const cookie = cookieHeaderForHost(cookies, target.hostname);
    if (cookie) headerMap.cookie = cookie;
    const baseParams = {
      url: pageUrl,
      is_pc: "1",
      timeout: String(config.snifferTimeoutMs),
      headers: JSON.stringify(headerMap),
      sniffer_exclude: config.snifferExclude,
    };

    const items = [];
    const seen = new Set();
    const addItems = (data) => {
      if (!data || typeof data !== "object") return;
      const add = (item) => {
        if (!item || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return;
        if (seen.has(item.url)) return;
        seen.add(item.url);
        const headers = item.headers && typeof item.headers === "object" ? item.headers : headerMap;
        items.push({ url: item.url, headers });
      };
      if (typeof data.url === "string") add({ url: data.url, headers: data.headers });
      if (Array.isArray(data.urls)) for (const item of data.urls) add(item);
    };

    let data;
    let media = [];
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      report?.("browser", `浏览器仍在工作… ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }, 2000);
    heartbeat.unref?.();
    try {
      report?.("browser", "浏览器已启动，等待播放器发出请求…");
      data = await this.#callSniffer({ ...baseParams, mode: "0" });
      addItems(data);
      const mediaPattern = /\.(m3u8|mp4|flv|webm|mkv|mov|m4v)(?:$|[?#])/i;
      media = items.filter((item) => mediaPattern.test(item.url));
      if (!media.length && data?.code === 200) {
        report?.("browser", "第一轮没抓到媒体，继续监听页面请求…");
        data = await this.#callSniffer({ ...baseParams, mode: "1", timeout: "15000" });
        addItems(data);
        media = items.filter((item) => mediaPattern.test(item.url));
      }
    } finally {
      clearInterval(heartbeat);
    }
    return await this.#finishBrowserCandidates(media, headerMap, report);
  }

  async #finishBrowserCandidates(media, headerMap, report) {
    if (!media.length) {
      report?.("browser", "浏览器没有捕获到媒体地址");
      return { candidates: [] };
    }
    report?.("browser", `浏览器捕获到 ${media.length} 个地址，读取清晰度…`);
    const candidates = [];
    for (const item of media.slice(0, 6)) {
      const headers = item.headers || headerMap;
      try {
        const probed = await this.#probeMedia(item.url, headers, { forceHls: /\.m3u8/i.test(item.url) });
        if (probed) {
          probed.note = "Playwright 浏览器嗅探";
          candidates.push(probed);
        }
      } catch {
        const kind = /\.m3u8/i.test(item.url) ? "hls" : "file";
        candidates.push({
          url: item.url,
          headers,
          kind,
          height: null,
          bandwidth: null,
          duration: null,
          isLive: false,
          qualities:
            kind === "hls"
              ? [{ label: "HLS 原始画质", height: null, bandwidth: null }]
              : [{ label: "原始画质", height: null, bandwidth: null }],
          label: kind === "hls" ? "HLS · 浏览器嗅探" : "原始画质",
          note: "Playwright 浏览器嗅探",
        });
      }
    }
    report?.("probe", `确认 ${candidates.length} 个可播放源`);
    return { candidates };
  }

  async #callSniffer(params) {
    const query = new URLSearchParams(params).toString();
    const headers = { accept: "application/json" };
    if (config.snifferAuth) headers.authorization = config.snifferAuth;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(60000, config.snifferTimeoutMs + 45000));
    try {
      const response = await fetch(`${config.snifferUrl}/sniffer?${query}`, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AppError(502, "sniffer_failed", `浏览器嗅探服务返回 HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError") throw new AppError(504, "sniffer_timeout", "浏览器嗅探超时");
      if (error instanceof AppError) throw error;
      throw new AppError(502, "sniffer_failed", error?.message || "浏览器嗅探服务连接失败");
    } finally {
      clearTimeout(timer);
    }
  }

  #store(result) {
    const token = this.resolved.create(result);
    return {
      token,
      title: result.title,
      poster: result.poster,
      duration: result.duration,
      isLive: result.isLive,
      pageUrl: result.pageUrl,
      note: result.note || null,
      candidates: result.candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        kind: candidate.kind,
        height: candidate.height,
        isLive: candidate.isLive,
        note: candidate.note || null,
        bandwidth: candidate.bandwidth || null,
        // 给前端展示和「复制地址」用；合并源没有真实地址
        url: candidate.kind === "merge" ? null : candidate.url || null,
        recommended: Boolean(candidate.recommended),
      })),
    };
  }

  #buildResult({ pageUrl, title, poster, duration, isLive, candidates, note = "" }) {
    const deduped = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const key = `${candidate.kind}|${candidate.height || ""}|${candidate.label}|${candidate.url || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(candidate);
    }
    const notes = [note].filter(Boolean);
    let available = deduped;
    if (!config.mergeEnabled && available.some((item) => item.kind === "merge")) {
      available = available.filter((item) => item.kind !== "merge");
      notes.push("更高画质需要服务器合并，当前已隐藏该项");
    }

    const direct = available.filter((item) => item.kind !== "merge");
    const merge = available.filter((item) => item.kind === "merge");
    const sortByQuality = (a, b) => {
      if (Boolean(a.isLive) !== Boolean(b.isLive)) return a.isLive ? 1 : -1;
      const heightDiff = (b.height || 0) - (a.height || 0);
      if (heightDiff) return heightDiff;
      const kindRank = (item) => (item.kind === "hls" ? 0 : item.kind === "file" ? 1 : 2);
      const kindDiff = kindRank(a) - kindRank(b);
      if (kindDiff) return kindDiff;
      return (b.bandwidth || 0) - (a.bandwidth || 0);
    };
    direct.sort(sortByQuality);
    merge.sort(sortByQuality);
    const limited = [...direct, ...merge].slice(0, 8);
    limited.forEach((candidate, index) => {
      candidate.id = `src${index + 1}`;
      candidate.recommended = false;
    });
    if (limited.length) limited[0].recommended = true;

    return {
      pageUrl,
      title: (title || "未命名影片").slice(0, 200),
      poster: poster || null,
      duration: Number.isFinite(duration) ? duration : null,
      isLive: Boolean(isLive),
      candidates: limited,
      note: notes.join("；"),
      createdAt: Date.now(),
    };
  }

  async #fetchPage(url, cookies, referer, { maxBytes = config.maxPageBytes, timeoutMs = config.pageFetchTimeoutMs } = {}) {
    const host = new URL(url).hostname;
    const cookie = cookieHeaderForHost(cookies, host);
    const headers = {
      ...BROWSER_HEADERS,
      referer: referer || `${new URL(url).origin}/`,
    };
    if (cookie) headers.cookie = cookie;
    const { response, finalUrl } = await openUpstream(url, {
      headers,
      timeoutMs,
      maxRedirects: 6,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AppError(response.status === 403 ? 403 : 502, "page_fetch_failed", `页面返回 HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (/^(video|audio)\//i.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      return { text: "", finalUrl, contentType, media: true };
    }
    const { buffer } = await readResponseLimited(response, maxBytes);
    const text = decodeBuffer(buffer, contentType);
    return { text, finalUrl, contentType, media: false };
  }

  async #sniffPage(pageUrl, cookies, report = null) {
    report?.("page", "读取页面 HTML…");
    const visited = new Set();
    const queue = [{ url: pageUrl, referer: `${new URL(pageUrl).origin}/`, depth: 0 }];
    const found = [];
    const nested = [];
    let title = "";
    let poster = null;
    let duration = null;

    while (queue.length && visited.size < 5) {
      const item = queue.shift();
      if (visited.has(item.url)) continue;
      visited.add(item.url);
      let page;
      try {
        page = await this.#fetchPage(item.url, cookies, item.referer);
      } catch {
        continue;
      }
      if (item.depth === 0 && (page.media || /mpegurl/i.test(page.contentType))) {
        try {
          const cookie = cookieHeaderForHost(cookies, new URL(page.finalUrl).hostname);
          const candidate = await this.#probeMedia(
            page.finalUrl,
            {
              Referer: `${new URL(page.finalUrl).origin}/`,
              "User-Agent": config.userAgent,
              ...(cookie ? { Cookie: cookie } : {}),
            },
            { forceHls: /mpegurl/i.test(page.contentType) },
          );
          if (candidate) {
            return {
              title: "",
              poster: null,
              duration: candidate.duration,
              isLive: candidate.isLive,
              candidates: [candidate],
              note: "",
            };
          }
        } catch {
          // continue with HTML extraction
        }
      }
      const extracted = extractFromHtml(page.text, page.finalUrl);
      if (item.depth === 0) {
        report?.("page", "页面已打开，扫描 m3u8 / mp4 / 播放器配置…");
        title = extracted.title;
        poster = extracted.poster;
        duration = extracted.duration;
      }
      for (const stream of extracted.streams) {
        found.push({ url: stream, referer: page.finalUrl });
      }
      if (found.length) {
        report?.("page", `页面内找到 ${found.length} 个候选地址，继续检查脚本…`);
      }
      if (item.depth < 2 && found.length < 6) {
        if (extracted.scripts.length) report?.("page", "扫描页面引用的外部脚本…");
        const ignored = /google-analytics|googletagmanager|gtag\/js|hm\.baidu|cnzz|doubleclick|adsystem|hotjar|sentry/i;
        let pageHost = "";
        try {
          pageHost = new URL(page.finalUrl).hostname;
        } catch {
          // ignore
        }
        const scoredScripts = extracted.scripts
          .filter((scriptUrl) => !ignored.test(scriptUrl))
          .map((scriptUrl) => {
            let score = 0;
            try {
              const parsed = new URL(scriptUrl);
              const pathName = parsed.pathname.toLowerCase();
              if (/demo|player|main|app|config|video|play|bundle|chunk|index/.test(pathName)) score += 10;
              if (/jquery|bootstrap|filesaver|ace\.js|hls\.min\.js|hls\.js$|react|vue|polyfill|fontawesome/.test(pathName)) {
                score -= 20;
              }
              if (pageHost && parsed.hostname === pageHost) score += 2;
            } catch {
              score -= 5;
            }
            return { scriptUrl, score };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 4)
          .map((item) => item.scriptUrl);
        for (const scriptUrl of scoredScripts) {
          if (visited.has(scriptUrl)) continue;
          visited.add(scriptUrl);
          try {
            const script = await this.#fetchPage(scriptUrl, cookies, page.finalUrl, {
              maxBytes: 2 * 1024 * 1024,
              timeoutMs: 10000,
            });
            if (!script.media) {
              const jsExtracted = extractFromHtml(script.text, scriptUrl);
              for (const stream of jsExtracted.streams) {
                found.push({ url: stream, referer: page.finalUrl });
              }
            }
          } catch {
            // ignore broken third-party scripts
          }
          if (found.length >= 10) break;
        }
      }
      for (const nestedPage of extracted.nestedPages) {
        if (queue.length + visited.size < 8) {
          queue.push({ url: nestedPage, referer: page.finalUrl, depth: item.depth + 1 });
        }
      }
      if (item.depth < 2) {
        for (const iframe of extracted.iframes.slice(0, 4)) {
          if (!visited.has(iframe)) {
            queue.push({ url: iframe, referer: page.finalUrl, depth: item.depth + 1 });
          }
        }
      }
      if (found.length >= 16) break;
    }

    const unique = new Map();
    for (const item of found) {
      if (!unique.has(item.url)) unique.set(item.url, item);
    }

    const candidates = [];
    const probeList = [...unique.values()].slice(0, 8);
    if (probeList.length) report?.("probe", `验证 ${probeList.length} 个播放地址…`);
    let probeCursor = 0;
    const workers = Math.min(3, probeList.length);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (probeCursor < probeList.length) {
          const item = probeList[probeCursor];
          probeCursor += 1;
          const cookie = cookieHeaderForHost(cookies, new URL(item.url).hostname);
          try {
            const candidate = await this.#probeMedia(item.url, {
              Referer: item.referer,
              "User-Agent": config.userAgent,
              ...(cookie ? { Cookie: cookie } : {}),
            });
            if (candidate) candidates.push(candidate);
          } catch {
            // try the next candidate
          }
        }
      }),
    );

    const hlsCandidates = candidates.filter((candidate) => candidate.kind === "hls");
    const best = hlsCandidates.find((candidate) => candidate.isMaster) || hlsCandidates[0] || candidates[0];
    report?.("probe", `确认 ${candidates.length} 个可播放源`);
    return {
      title,
      poster,
      duration: duration || best?.duration || null,
      isLive: Boolean(best?.isLive),
      candidates,
      note: candidates.length > 1 ? `检测到 ${candidates.length} 个播放源` : "",
    };
  }

  async #probeMedia(url, headers, { forceHls = false } = {}) {
    const looksHls = forceHls || /\.m3u8(?:$|[?#])/i.test(url) || /m3u8/i.test(new URL(url).search);
    if (looksHls) {
      const { response, finalUrl } = await openUpstream(url, {
        headers,
        timeoutMs: 15000,
        maxRedirects: 6,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new AppError(502, "stream_probe_failed", `播放地址返回 HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") || "";
      const { buffer } = await readResponseLimited(response, config.maxPlaylistBytes);
      const text = decodeBuffer(buffer, contentType);
      if (!text.trimStart().startsWith("#EXTM3U")) {
        throw new AppError(422, "not_hls", "返回内容不是 HLS 播放列表");
      }
      const parsed = parseHlsPlaylist(text, finalUrl);
      const qualities = parsed.variants
        .map((variant) => ({
          label: variant.height ? `${variant.height}P` : variant.name || "自动",
          height: variant.height,
          bandwidth: variant.bandwidth,
        }))
        .filter((item, index, list) => list.findIndex((other) => other.label === item.label) === index)
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      return {
        url,
        headers,
        kind: "hls",
        height: parsed.height,
        bandwidth: parsed.bandwidth,
        duration: parsed.duration,
        isLive: parsed.isLive,
        qualities,
        label: parsed.height
          ? `${parsed.height}P · HLS`
          : parsed.isMaster
            ? "HLS · 多码率"
            : "HLS · 原始画质",
        note: parsed.isMaster ? `${parsed.variants.length} 档码率` : parsed.isLive ? "直播" : "",
      };
    }

    const probeHeaders = { ...headers, Range: "bytes=0-4095" };
    const { response } = await openUpstream(url, {
      headers: probeHeaders,
      timeoutMs: 15000,
      maxRedirects: 6,
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      throw new AppError(502, "stream_probe_failed", `播放地址返回 HTTP ${response.status}`);
    }
    let head = Buffer.alloc(0);
    if (response.body) {
      const reader = response.body.getReader();
      try {
        const { value } = await reader.read();
        if (value) head = Buffer.from(value).subarray(0, 4096);
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    const textHead = head.toString("utf8").trimStart();
    if (textHead.startsWith("#EXTM3U")) {
      return this.#probeMedia(url, headers, { forceHls: true });
    }
    const isVideo =
      /^(video|audio)\//i.test(contentType) ||
      /\.(mp4|flv|webm|mkv|mov|m4v)(?:$|[?#])/i.test(url) ||
      /octet-stream/i.test(contentType);
    if (!isVideo) {
      throw new AppError(422, "not_media", "返回内容不是视频");
    }
    const contentRange = response.headers.get("content-range") || "";
    const sizeMatch = /\/\s*(\d+)\s*$/.exec(contentRange);
    const size = sizeMatch ? Number(sizeMatch[1]) : Number(response.headers.get("content-length")) || null;
    const extMatch = /\.(mp4|flv|webm|mkv|mov|m4v)(?:$|[?#])/i.exec(url);
    const ext = extMatch ? extMatch[1].toLowerCase() : "mp4";
    return {
      url,
      headers,
      kind: "file",
      height: null,
      bandwidth: null,
      duration: null,
      isLive: false,
      size,
      ext,
      qualities: [{ label: "原始画质", height: null, bandwidth: null }],
      label: `${ext.toUpperCase()} · 原始画质`,
      note: size ? `${Math.round(size / 1024 / 1024)}MB` : "",
    };
  }

  async #ytdlp(url, cookies) {
    let cookieFile = null;
    try {
      cookieFile = await writeCookieFile(cookies, url);
      const args = [
        "--no-config",
        "--no-warnings",
        "--no-progress",
        "--no-playlist",
        "--dump-single-json",
        "--socket-timeout",
        "20",
        "--retries",
        "2",
        "--extractor-retries",
        "1",
      ];
      if (cookieFile) args.push("--cookies", cookieFile);
      args.push(url);
      const env = {
        ...process.env,
        HOME: path.join(config.dataDir, "home"),
        XDG_CACHE_HOME: path.join(config.dataDir, "cache-ytdlp"),
        TMPDIR: config.tmpDir,
      };
      let stdout;
      try {
        const result = await execFileAsync(config.ytDlp, args, {
          timeout: config.resolveTimeoutMs,
          maxBuffer: config.maxJsonBytes,
          env,
          windowsHide: true,
        });
        stdout = result.stdout;
      } catch (error) {
        const stderr = String(error.stderr || "").trim();
        const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" / ");
        if (error.killed || error.signal === "SIGTERM") {
          throw new AppError(504, "ytdlp_timeout", "解析超时");
        }
        throw new AppError(422, "ytdlp_failed", tail || "yt-dlp 解析失败");
      }
      const start = stdout.indexOf("{");
      const end = stdout.lastIndexOf("}");
      if (start < 0 || end < start) throw new AppError(422, "ytdlp_failed", "yt-dlp 没有返回 JSON");
      const info = JSON.parse(stdout.slice(start, end + 1));
      if (info._type === "playlist" && Array.isArray(info.entries) && info.entries.length) {
        return info.entries[0];
      }
      return info;
    } finally {
      if (cookieFile) await fs.unlink(cookieFile).catch(() => {});
    }
  }

  #candidatesFromYtdlp(info, pageUrl) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const combined = [];
    const videoOnly = [];
    const audioOnly = [];
    const fallback = [];

    for (const format of formats) {
      if (!format || !format.url || format.has_drm) continue;
      const protocol = String(format.protocol || "");
      if (/dash/i.test(protocol)) continue;
      if (!/^https?$/i.test(protocol) && !/m3u8/i.test(protocol)) continue;
      const hasVideo = format.vcodec !== "none";
      const hasAudio = format.acodec !== "none";
      if (!hasVideo) {
        if (hasAudio) audioOnly.push(format);
        continue;
      }
      const kind = protocol.includes("m3u8") || /\.m3u8(?:$|[?#])/i.test(format.url) ? "hls" : "file";
      const item = {
        url: format.url,
        headers: format.http_headers || info.http_headers || {},
        kind,
        height: Number(format.height) || null,
        bandwidth: format.tbr ? Math.round(Number(format.tbr) * 1000) : null,
        isLive: Boolean(info.is_live),
        duration: Number.isFinite(info.duration) ? info.duration : null,
        fps: Number(format.fps) || null,
        formatId: format.format_id,
        formatNote: format.format_note || "",
        ext: format.ext || (kind === "hls" ? "m3u8" : "mp4"),
        filesize: Number(format.filesize || format.filesize_approx) || null,
      };
      if (hasAudio) combined.push(item);
      else videoOnly.push(item);
      if (hasAudio && hasVideo) fallback.push(item);
    }

    if (!combined.length && !videoOnly.length && info.url) {
      const kind = /\.m3u8(?:$|[?#])/i.test(info.url) ? "hls" : "file";
      combined.push({
        url: info.url,
        headers: info.http_headers || {},
        kind,
        height: Number(info.height) || null,
        bandwidth: info.tbr ? Math.round(Number(info.tbr) * 1000) : null,
        isLive: Boolean(info.is_live),
        duration: Number.isFinite(info.duration) ? info.duration : null,
        fps: Number(info.fps) || null,
        formatId: info.format_id,
        formatNote: info.format_note || "",
        ext: info.ext || (kind === "hls" ? "m3u8" : "mp4"),
        filesize: Number(info.filesize || info.filesize_approx) || null,
      });
    }

    const makeCandidate = (item, extra = {}) => {
      const height = item.height || null;
      const fpsLabel = item.fps && item.fps > 30 ? ` ${Math.round(item.fps)}fps` : "";
      const kindLabel = item.kind === "hls" ? "HLS" : String(item.ext || "mp4").toUpperCase();
      return {
        url: item.url,
        headers: item.headers,
        kind: item.kind,
        height,
        bandwidth: item.bandwidth,
        duration: item.duration,
        isLive: item.isLive,
        fps: item.fps,
        filesize: item.filesize,
        label: `${height ? `${height}P` : "原始画质"}${fpsLabel} · ${kindLabel}`,
        note: [item.formatNote, item.filesize ? `${Math.round(item.filesize / 1024 / 1024)}MB` : ""]
          .filter(Boolean)
          .join(" · "),
        qualities: height
          ? [{ label: `${height}P`, height, bandwidth: item.bandwidth }]
          : [{ label: "原始画质", height: null, bandwidth: null }],
        ...extra,
      };
    };

    const dedupe = (list) => {
      const map = new Map();
      for (const item of list) {
        const key = `${item.height || 0}|${item.kind}|${Math.round((item.bandwidth || 0) / 100000)}`;
        const existing = map.get(key);
        if (!existing || (item.bandwidth || 0) > (existing.bandwidth || 0)) map.set(key, item);
      }
      return [...map.values()].sort((a, b) => {
        const heightDiff = (b.height || 0) - (a.height || 0);
        if (heightDiff) return heightDiff;
        return (b.bandwidth || 0) - (a.bandwidth || 0);
      });
    };

    const candidates = dedupe(combined).slice(0, 6).map((item) => makeCandidate(item));

    const bestCombinedHeight = candidates.reduce((max, item) => Math.max(max, item.height || 0), 0);
    const bestVideoOnly = dedupe(videoOnly)[0];
    const bestAudio = audioOnly.sort((a, b) => (Number(b.abr) || 0) - (Number(a.abr) || 0))[0];

    if (bestVideoOnly && (bestVideoOnly.height || 0) > bestCombinedHeight) {
      candidates.push({
        ...makeCandidate(bestVideoOnly, {
          kind: "merge",
          label: `${bestVideoOnly.height}P · 高清合并`,
          note: "先由服务器下载并合并，画质更高，等待时间取决于片长",
          qualities: [{ label: `${bestVideoOnly.height}P`, height: bestVideoOnly.height, bandwidth: bestVideoOnly.bandwidth }],
        }),
        merge: {
          videoFormatId: bestVideoOnly.formatId,
          audioFormatId: bestAudio?.format_id || null,
          pageUrl,
        },
      });
    }

    if (!candidates.length && audioOnly.length) {
      return [];
    }
    return candidates;
  }

  #ytdlpNote(candidates, info) {
    const notes = [];
    const maxHeight = candidates.reduce((max, item) => Math.max(max, item.height || 0), 0);
    if (info.is_live) notes.push("直播流");
    if (maxHeight && maxHeight < 1080 && !candidates.some((item) => item.kind === "merge")) {
      notes.push("当前站点可直连的最高画质有限；若出现“高清合并”选项，可选择它获取更高画质");
    }
    if (candidates.some((item) => item.kind === "merge")) {
      notes.push("1080P 及以上通常需要服务器合并，首次播放会先缓存");
    }
    return notes.join("；");
  }
}

export { BROWSER_HEADERS };

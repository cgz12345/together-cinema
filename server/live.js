import fs from "node:fs";
import path from "node:path";
import config from "./config.js";
import {
  AppError,
  openUpstream,
  readResponseLimited,
  decodeBuffer,
  randomId,
} from "./utils.js";

const MAX_SOURCES = 40;
const MAX_CHANNELS_PER_SOURCE = 500;
const MAX_TOTAL_CHANNELS = 3000;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 2000;

function cleanText(value, max = 80) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

/** 只做协议格式校验；内网/SSRF 防护在真正发起请求时由 openUpstream 负责。 */
function validChannelUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim()) && value.length <= 2048;
}

function normalizeHeaderValue(value) {
  const text = cleanText(value, 512);
  return text;
}

/** 解析 #EXTINF 行里的属性：tvg-id="x" group-title="y"（容错单引号和无引号）。 */
function parseExtinfAttributes(rest) {
  const attrs = {};
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let match;
  while ((match = re.exec(rest))) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!(key in attrs)) attrs[key] = cleanText(value, 200);
  }
  return attrs;
}

function channelName(raw, fallbackIndex) {
  const name = cleanText(raw, 60);
  return name || `频道 ${fallbackIndex + 1}`;
}

/**
 * 解析一份直播列表文本，返回 [{ name, group, url, logo, ua, referer }]。
 * 支持三种常见格式：
 *  1. M3U（#EXTINF / #EXTGRP / #EXTVLCOPT，IPTV 列表最常用的格式）
 *  2. JSON（TVBox / DIYP 导出的 {"channels": [...]} / {"lives": [...]}）
 *  3. 纯文本（CCTV1,https://... / 央视,CCTV1$https://... / CCTV1 https://...）
 */
export function parseM3U(input, { maxChannels = MAX_CHANNELS_PER_SOURCE } = {}) {
  const text = String(input ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const fromJson = parseJsonList(trimmed);
    if (fromJson.length) return fromJson.slice(0, maxChannels);
  }
  if (/^#EXTM3U|^#EXTINF/i.test(trimmed)) {
    return parseM3uText(text).slice(0, maxChannels);
  }
  return parseTextLines(text).slice(0, maxChannels);
}

function pushUnique(list, seen, channel) {
  if (!validChannelUrl(channel.url)) return;
  const key = channel.url.trim();
  if (seen.has(key)) return;
  seen.add(key);
  list.push(channel);
}

function parseM3uText(text) {
  const lines = text.split("\n");
  const list = [];
  const seen = new Set();
  let pending = null;
  let groupOverride = "";
  let ua = "";
  let referer = "";
  for (const rawLine of lines) {
    const line = rawLine.slice(0, MAX_LINE).trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      // 找显示名前的逗号时要跳过属性引号：tvg-logo 的 data URI 或带 query 的
      // URL 里经常有逗号，直接 indexOf(",") 会把频道名截错。
      let commaAt = -1;
      let inQuote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (inQuote) {
          if (ch === inQuote) inQuote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inQuote = ch;
          continue;
        }
        if (ch === ",") {
          commaAt = i;
          break;
        }
      }
      const head = commaAt >= 0 ? line.slice(0, commaAt) : line;
      const display = commaAt >= 0 ? line.slice(commaAt + 1) : "";
      const attrs = parseExtinfAttributes(head);
      pending = {
        name: cleanText(display, 60) || cleanText(attrs["tvg-name"], 60) || "",
        group: cleanText(attrs["group-title"], 40),
        logo: cleanText(attrs["tvg-logo"], 500),
        ua: "",
        referer: "",
      };
      continue;
    }
    if (/^#EXTGRP/i.test(line)) {
      groupOverride = cleanText(line.slice(line.indexOf(":") + 1), 40);
      continue;
    }
    if (/^#EXTVLCOPT/i.test(line)) {
      const body = line.slice(line.indexOf(":") + 1);
      const eq = body.indexOf("=");
      if (eq > 0) {
        const key = body.slice(0, eq).trim().toLowerCase();
        const value = normalizeHeaderValue(body.slice(eq + 1));
        if (key === "http-user-agent") ua = value;
        else if (key === "http-referrer" || key === "http-referer") referer = value;
      }
      continue;
    }
    if (line.startsWith("#")) continue;
    if (!pending) {
      // 没有 #EXTINF 的裸地址行，也能认
      if (validChannelUrl(line)) {
        pushUnique(list, seen, {
          name: `频道 ${list.length + 1}`,
          group: "",
          url: line,
          logo: "",
          ua,
          referer,
        });
      }
      continue;
    }
    if (!validChannelUrl(line)) {
      pending = null;
      continue;
    }
    pushUnique(list, seen, {
      name: channelName(pending.name, list.length),
      group: pending.group || groupOverride,
      url: line,
      logo: pending.logo,
      ua: pending.ua || ua,
      referer: pending.referer || referer,
    });
    pending = null;
    groupOverride = "";
  }
  return list;
}

function parseTextLines(text) {
  const list = [];
  const seen = new Set();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.slice(0, MAX_LINE).trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const urlMatches = line.match(/https?:\/\/\S+/gi);
    if (!urlMatches || !urlMatches.length) continue;
    const url = urlMatches[urlMatches.length - 1].replace(/[),;]+$/, "");
    if (!validChannelUrl(url)) continue;
    const head = line.slice(0, line.length - urlMatches[urlMatches.length - 1].length).replace(/[,，$\s]+$/, "");
    const parts = head
      .split(/[,，$|]/)
      .map((part) => cleanText(part, 40))
      .filter(Boolean);
    const name = channelName(parts.length ? parts[parts.length - 1] : "", list.length);
    const group = parts.length > 1 ? parts.slice(0, -1).join(" · ") : "";
    pushUnique(list, seen, { name, group, url, logo: "", ua: "", referer: "" });
  }
  return list;
}

function parseJsonList(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const arrays = [];
  const visit = (node, depth) => {
    if (depth > 4 || !node) return;
    if (Array.isArray(node)) {
      arrays.push(node);
      return;
    }
    if (typeof node === "object") {
      for (const key of ["channels", "lives", "data", "list", "tv"]) {
        if (node[key]) visit(node[key], depth + 1);
      }
    }
  };
  visit(data, 0);
  const list = [];
  const seen = new Set();
  for (const array of arrays) {
    for (const item of array) {
      if (!item || typeof item !== "object") continue;
      const urls = [];
      if (Array.isArray(item.urls)) {
        for (const entry of item.urls) {
          if (typeof entry === "string") urls.push(entry);
          else if (entry && typeof entry === "object" && typeof entry.url === "string") urls.push(entry.url);
        }
      }
      if (typeof item.url === "string") urls.push(item.url);
      if (Array.isArray(item.url)) urls.push(...item.url.filter((entry) => typeof entry === "string"));
      if (!urls.length) continue;
      const url = urls.find(validChannelUrl);
      if (!url) continue;
      pushUnique(list, seen, {
        name: channelName(cleanText(item.name || item.title, 60), list.length),
        group: cleanText(item.group || item.groupTitle || item.category, 40),
        url,
        logo: cleanText(item.logo || item.pic, 500),
        ua: cleanText(item.ua || item.userAgent, 512),
        referer: cleanText(item.referer || item.referrer, 512),
      });
    }
  }
  return list;
}

/** 从 URL 抓取直播列表并解析（大小限制 2MB，防盗链重定向由 openUpstream 处理）。 */
export async function fetchLiveList(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new AppError(400, "bad_url", "链接无法解析");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError(400, "bad_url", "只支持 http(s) 链接");
  }
  const { response } = await openUpstream(url.toString(), {
    headers: {
      "user-agent": config.userAgent,
      accept: "audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*",
    },
    timeoutMs: 20000,
    maxRedirects: 5,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(502, "fetch_failed", `链接返回 HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  const { buffer } = await readResponseLimited(response, MAX_IMPORT_BYTES);
  const text = decodeBuffer(buffer, contentType);
  const channels = parseM3U(text);
  if (!channels.length) {
    throw new AppError(422, "empty_list", "这个链接里没有解析出直播频道，确认是 m3u/txt 列表链接吗");
  }
  return channels;
}

export class LiveTV {
  constructor() {
    this.file = path.join(config.dataDir, "live-sources.json");
    this.sources = [];
    this.load();
  }

  validSource(item) {
    return (
      item &&
      typeof item.name === "string" &&
      item.name.trim() &&
      Array.isArray(item.channels) &&
      item.channels.length > 0
    );
  }

  validChannel(item) {
    return item && typeof item.name === "string" && item.name.trim() && validChannelUrl(item.url);
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.sources = parsed
          .filter((item) => this.validSource(item))
          .slice(0, MAX_SOURCES)
          .map((item) => ({
            id: String(item.id || randomId(6)).slice(0, 24),
            name: cleanText(item.name, 40),
            createdAt: Number(item.createdAt) || Date.now(),
            channels: item.channels
              .filter((channel) => this.validChannel(channel))
              .slice(0, MAX_CHANNELS_PER_SOURCE)
              .map((channel) => ({
                id: String(channel.id || randomId(6)).slice(0, 24),
                name: cleanText(channel.name, 60),
                group: cleanText(channel.group, 40),
                url: String(channel.url).trim(),
                logo: cleanText(channel.logo, 500),
                ua: cleanText(channel.ua, 512),
                referer: cleanText(channel.referer, 512),
              })),
          }))
          .filter((item) => item.channels.length);
      }
    } catch {
      this.sources = [];
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.sources, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // 带上 channels：前端的“看电视”列表一把拉完，省得再发一次请求。
  // 3000 个频道的上限下 JSON 也就几百 KB，自用部署无所谓。
  list() {
    return this.sources.map((item) => ({
      id: item.id,
      name: item.name,
      count: item.channels.length,
      createdAt: item.createdAt,
      channels: item.channels,
    }));
  }

  totalChannels() {
    return this.sources.reduce((sum, item) => sum + item.channels.length, 0);
  }

  add(name, channels, { save = true } = {}) {
    const cleanName = cleanText(name, 40);
    if (!cleanName) throw new AppError(400, "bad_source_name", "请填写直播源名称");
    if (!Array.isArray(channels) || !channels.length) {
      throw new AppError(400, "empty_channels", "没有可导入的频道");
    }
    if (this.sources.length >= MAX_SOURCES) {
      throw new AppError(400, "too_many_sources", `最多添加 ${MAX_SOURCES} 个直播源`);
    }
    if (this.totalChannels() + channels.length > MAX_TOTAL_CHANNELS) {
      throw new AppError(400, "too_many_channels", "频道总数超过上限了，先删一些旧的");
    }
    const seen = new Set();
    const normalized = [];
    for (const channel of channels) {
      const cleanUrl = String(channel?.url || "").trim();
      if (!validChannelUrl(cleanUrl)) continue;
      if (seen.has(cleanUrl)) continue;
      seen.add(cleanUrl);
      normalized.push({
        id: randomId(6),
        name: channelName(channel?.name, normalized.length),
        group: cleanText(channel?.group, 40),
        url: cleanUrl,
        logo: cleanText(channel?.logo, 500),
        ua: cleanText(channel?.ua, 512),
        referer: cleanText(channel?.referer, 512),
      });
      if (normalized.length >= MAX_CHANNELS_PER_SOURCE) break;
    }
    if (!normalized.length) throw new AppError(400, "empty_channels", "没有可导入的频道");
    const source = { id: randomId(6), name: cleanName, createdAt: Date.now(), channels: normalized };
    this.sources.push(source);
    if (save) this.save();
    return source;
  }

  remove(id) {
    const before = this.sources.length;
    this.sources = this.sources.filter((item) => item.id !== id);
    if (this.sources.length === before) throw new AppError(404, "source_not_found", "直播源不存在");
    this.save();
    return this.list();
  }

  getSource(id) {
    return this.sources.find((item) => item.id === id) || null;
  }

  addChannel(sourceId, { name, url, group = "", logo = "" }) {
    const source = this.getSource(sourceId);
    if (!source) throw new AppError(404, "source_not_found", "直播源不存在");
    const cleanUrl = String(url || "").trim();
    if (!validChannelUrl(cleanUrl)) throw new AppError(400, "bad_channel_url", "频道地址必须是 http(s) 链接");
    if (source.channels.some((item) => item.url === cleanUrl)) {
      throw new AppError(409, "channel_exists", "这个频道地址已经存在了");
    }
    if (source.channels.length >= MAX_CHANNELS_PER_SOURCE) {
      throw new AppError(400, "too_many_channels", "这个直播源频道太多了");
    }
    const channel = {
      id: randomId(6),
      name: channelName(name, source.channels.length),
      group: cleanText(group, 40),
      url: cleanUrl,
      logo: cleanText(logo, 500),
      ua: "",
      referer: "",
    };
    source.channels.push(channel);
    this.save();
    return channel;
  }

  removeChannel(sourceId, channelId) {
    const source = this.getSource(sourceId);
    if (!source) throw new AppError(404, "source_not_found", "直播源不存在");
    const before = source.channels.length;
    source.channels = source.channels.filter((item) => item.id !== channelId);
    if (source.channels.length === before) throw new AppError(404, "channel_not_found", "频道不存在");
    if (!source.channels.length) {
      // 最后一个频道被删掉，这个源也没存在的意义了
      this.sources = this.sources.filter((item) => item.id !== sourceId);
    }
    this.save();
    return source;
  }

  /** 展平成 [{ ...channel, sourceId, sourceName }]，供“看电视”列表和搜索用。 */
  allChannels() {
    const list = [];
    for (const source of this.sources) {
      for (const channel of source.channels) {
        list.push({ ...channel, sourceId: source.id, sourceName: source.name });
      }
    }
    return list;
  }
}

// 内置公开 IPTV 列表：用户点一下即可一键导入成自己的直播源（远程抓取解析）。
// 这些列表长期维护、公开可达，但里面个别频道地址会失效（第三方流），所以做成
// 「按需导入」而不是预置——免得预置一堆放不出的源污染列表、变成负体验。
const BUILTIN_SOURCES = [
  {
    id: "iptv-cn",
    name: "中国央视频道",
    url: "https://iptv-org.github.io/iptv/countries/cn.m3u",
    desc: "央视 + 卫视 + 地方台（约 150 路）",
  },
  {
    id: "iptv-hk",
    name: "中国香港频道",
    url: "https://iptv-org.github.io/iptv/countries/hk.m3u",
    desc: "香港免费台（约 17 路）",
  },
  {
    id: "iptv-tw",
    name: "中国台湾频道",
    url: "https://iptv-org.github.io/iptv/countries/tw.m3u",
    desc: "台湾无线台（约 32 路）",
  },
  {
    id: "fm-live",
    name: "Fanmingming 精选",
    url: "https://raw.githubusercontent.com/fanmingming/live/main/tv/m3u/ipv6.m3u",
    desc: "国内外精选直播（约 82 路）",
  },
];

export function getBuiltins() {
  return BUILTIN_SOURCES;
}

import fs from "node:fs";
import path from "node:path";
import config from "./config.js";
import {
  AppError,
  openUpstream,
  readResponseLimited,
  decodeBuffer,
  resolveMaybeRelative,
  randomId,
} from "./utils.js";

function cleanText(value, max = 200) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function normalizePoster(value, apiUrl) {
  if (typeof value !== "string" || !value) return "";
  const absolute = resolveMaybeRelative(value, apiUrl);
  return /^https?:\/\//i.test(absolute) ? absolute.slice(0, 2048) : "";
}

const isDirectM3u8 = (url) => /\.m3u8(?:$|[?#])/i.test(url);

function parseEpisodes(item, apiUrl) {
  const names = String(item.vod_play_from || "").split("$$$");
  const groups = String(item.vod_play_url || "").split("$$$");
  // 一批采集站（红牛/急速/豪华/速播/光速等）的 vod_play_url 给的是
  // DPlayer 播放页（/play/<id>），页面里 const vid 指向的真实地址就是
  // 页面地址后面拼 /index.m3u8（标准 AES-128 HLS，播放器原生支持）。
  // 量子这类站则给的是 v.lzcdn*.com/share/<id> 分享页——不是直链，浏览器
  // 放不出来。这里把能直接播放的 .m3u8 地址整体前置，share/播放页往后排，
  // 保证默认选中的第 1 集、默认高亮的源都是真能放的直链（前端按 group 分栏
  // 展示，顺序变化不影响分栏，只影响默认集）。
  const direct = [];
  const fallback = [];
  const MAX = 120;
  let total = 0;
  groups.forEach((group, groupIndex) => {
    for (const rawEntry of group.split("#")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      const splitAt = entry.indexOf("$");
      let name = splitAt >= 0 ? entry.slice(0, splitAt).trim() : "";
      let url = splitAt >= 0 ? entry.slice(splitAt + 1).trim() : entry;
      if (!/^https?:\/\//i.test(url)) {
        const absolute = resolveMaybeRelative(url, apiUrl);
        if (!absolute) continue;
        url = absolute;
      }
      if (!/^https?:\/\//i.test(url)) continue;
      const playPage = url.match(/^(https?:\/\/[^/]+\/play\/[A-Za-z0-9]+)\/?$/);
      if (playPage) url = `${playPage[1]}/index.m3u8`;
      if (!name) name = `第 ${total + 1} 集`;
      const ep = {
        name: cleanText(name, 60) || `第 ${total + 1} 集`,
        url,
        group: cleanText(names[groupIndex] || "默认源", 30),
      };
      (isDirectM3u8(url) ? direct : fallback).push(ep);
      total += 1;
      if (total >= MAX) break;
    }
  });
  return [...direct, ...fallback];
}

export class Discovery {
  constructor() {
    this.file = path.join(config.dataDir, "discovery-sources.json");
    this.sources = [];
    this.load();
  }

  validSource(item) {
    return (
      item &&
      typeof item.name === "string" &&
      item.name.trim() &&
      typeof item.api === "string" &&
      /^https?:\/\//i.test(item.api)
    );
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // 与 add() 的 40 个上限保持一致：以前这里截 12 个，用户加到第 13 个
        // 片源重启后就消失，还查不到原因。
        this.sources = parsed
          .filter((item) => this.validSource(item))
          .slice(0, 40)
          .map((item) => ({
            id: String(item.id || randomId(6)).slice(0, 24),
            name: item.name.trim().slice(0, 40),
            api: item.api,
          }));
      }
    } catch {
      this.sources = [];
    }
    if (!this.sources.length && config.discoverySources.length) {
      this.sources = config.discoverySources.map((item) => ({
        id: randomId(6),
        name: item.name,
        api: item.api,
      }));
      this.save();
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.sources, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.sources.map((item) => ({ id: item.id, name: item.name, api: item.api }));
  }

  add(name, api, { save = true } = {}) {
    const cleanName = String(name || "").trim().slice(0, 40);
    const cleanApi = String(api || "").trim();
    if (!cleanName) throw new AppError(400, "bad_source_name", "请填写片源名称");
    if (!/^https?:\/\//i.test(cleanApi)) throw new AppError(400, "bad_source_api", "片源 API 必须是 http(s) 地址");
    if (this.sources.length >= 40) throw new AppError(400, "too_many_sources", "最多添加 40 个片源");
    if (this.sources.some((item) => item.api === cleanApi)) {
      throw new AppError(409, "source_exists", "这个片源已经添加过了");
    }
    const source = { id: randomId(6), name: cleanName, api: cleanApi };
    this.sources.push(source);
    if (save) this.save();
    return source;
  }

  remove(id) {
    const before = this.sources.length;
    this.sources = this.sources.filter((item) => item.id !== id);
    if (this.sources.length === before) throw new AppError(404, "source_not_found", "片源不存在");
    this.save();
    return this.list();
  }

  async search(query) {
    if (!this.sources.length) {
      throw new AppError(503, "discovery_disabled", "还没有配置找片资源站，请先添加片源");
    }
    const tasks = this.sources.map(async (source) => {
      const results = [];
      const seen = new Set();
      try {
        for (const pg of [1, 2]) {
          const api = new URL(source.api);
          api.searchParams.set("ac", "detail");
          api.searchParams.set("wd", query);
          // 默认每页只有 20 条，尽量多要一些；站点不支持时会忽略这个参数。
          api.searchParams.set("pagesize", "50");
          api.searchParams.set("pg", String(pg));
          const { response } = await openUpstream(api.toString(), {
            headers: {
              "user-agent": config.userAgent,
              accept: "application/json,text/plain,*/*",
            },
            timeoutMs: config.discoveryTimeoutMs,
            maxRedirects: 4,
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new AppError(502, "source_failed", `资源站返回 HTTP ${response.status}`);
          }
          const contentType = response.headers.get("content-type") || "";
          const { buffer } = await readResponseLimited(response, 3 * 1024 * 1024);
          const text = decodeBuffer(buffer, contentType);
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw new AppError(422, "source_bad_json", "资源站返回的不是 JSON");
          }
          const list = Array.isArray(data?.list) ? data.list : [];
          if (!list.length) break;
          for (const item of list) {
            const title = cleanText(item?.vod_name, 200);
            if (!title) continue;
            const vid = String(item?.vod_id ?? "");
            if (vid && seen.has(vid)) continue;
            const episodes = parseEpisodes(item, api.toString());
            if (!episodes.length) continue;
            if (vid) seen.add(vid);
            results.push({
              id: String(item?.vod_id ?? results.length + 1).slice(0, 40),
              title,
              poster: normalizePoster(item?.vod_pic, api.toString()),
              year: cleanText(item?.vod_year, 12),
              remarks: cleanText(item?.vod_remarks, 40),
              episodes: episodes.slice(0, 80),
              source: source.name,
            });
            if (results.length >= 100) break;
          }
          if (results.length >= 100) break;
        }
        return { id: source.name, name: source.name, ok: true, results };
      } catch (error) {
        if (results.length) {
          return { id: source.name, name: source.name, ok: true, results, partial: true };
        }
        return {
          id: source.name,
          name: source.name,
          ok: false,
          error: error.message || "搜索失败",
          results: [],
        };
      }
    });
    return Promise.all(tasks);
  }
}

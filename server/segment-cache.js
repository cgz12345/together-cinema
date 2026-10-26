import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MEDIA_EXTENSION = /\.(?:ts|m4s|mp4|m4v|aac|m4a|mp3|webm|flv)$/i;

function hashKey(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

export class SegmentCache {
  constructor({ dir, maxBytes, ttlMs, maxSegmentBytes }) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.maxSegmentBytes = maxSegmentBytes;
    this.inflight = new Map();
    this.ready = this.init();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch(() => {});
    }, 30 * 60 * 1000);
    this.cleanupTimer.unref?.();
    this.cleanup().catch(() => {});
  }

  isCacheable(req, url) {
    if (req.method !== "GET") return false;
    if (req.headers.range) return false;
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
    return MEDIA_EXTENSION.test(pathname);
  }

  keyFor(url, headers = {}) {
    const variants = [
      url,
      String(headers.cookie || ""),
      String(headers.referer || ""),
      String(headers["user-agent"] || ""),
    ];
    return hashKey(variants.join("\n"));
  }

  metaPath(key) {
    return path.join(this.dir, `${key}.json`);
  }

  dataPath(key) {
    return path.join(this.dir, `${key}.bin`);
  }

  async lookup(key) {
    await this.ready;
    const [metaRaw, stat] = await Promise.all([
      fsp.readFile(this.metaPath(key), "utf8").catch(() => null),
      fsp.stat(this.dataPath(key)).catch(() => null),
    ]);
    if (!metaRaw || !stat || !stat.size) return null;
    let meta;
    try {
      meta = JSON.parse(metaRaw);
    } catch {
      return null;
    }
    if (Date.now() - stat.mtimeMs > this.ttlMs) return null;
    if (stat.size > this.maxSegmentBytes) return null;
    return {
      key,
      path: this.dataPath(key),
      size: stat.size,
      contentType: meta.contentType || "application/octet-stream",
      etag: meta.etag || null,
    };
  }

  begin(key) {
    const existing = this.inflight.get(key);
    if (existing) return { leader: false, promise: existing.promise };
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // The rejection is delivered to every follower; the leader handles its own copy.
    promise.catch(() => {});
    const entry = { promise, resolve, reject, tempPath: null };
    this.inflight.set(key, entry);
    return { leader: true, entry };
  }

  finish(key) {
    this.inflight.delete(key);
  }

  async write(key, tempPath, contentType, etag) {
    const dest = this.dataPath(key);
    try {
      await fsp.rename(tempPath, dest);
      await fsp.writeFile(
        this.metaPath(key),
        JSON.stringify({ contentType, etag: etag || null, createdAt: Date.now() }),
      );
    } catch (error) {
      await fsp.unlink(tempPath).catch(() => {});
      throw error;
    }
    return { key, path: dest, contentType, etag: etag || null };
  }

  tempPath(key) {
    return path.join(this.dir, `${key}.${process.pid}.${Date.now()}.tmp`);
  }

  async cleanup() {
    await this.ready;
    const now = Date.now();
    const files = await walkFiles(this.dir);
    const dataFiles = [];
    let total = 0;
    for (const file of files) {
      let stat;
      try {
        stat = await fsp.stat(file);
      } catch {
        continue;
      }
      if (file.endsWith(".tmp")) {
        if (now - stat.mtimeMs > 15 * 60 * 1000) await fsp.unlink(file).catch(() => {});
        continue;
      }
      if (!file.endsWith(".bin")) {
        if (now - stat.mtimeMs > this.ttlMs + 60 * 60 * 1000) await fsp.unlink(file).catch(() => {});
        continue;
      }
      if (now - stat.mtimeMs > this.ttlMs) {
        await fsp.unlink(file).catch(() => {});
        await fsp.unlink(file.replace(/\.bin$/, ".json")).catch(() => {});
        continue;
      }
      dataFiles.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      total += stat.size;
    }
    if (total <= this.maxBytes) return;
    dataFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const item of dataFiles) {
      if (total <= this.maxBytes) break;
      await fsp.unlink(item.file).catch(() => {});
      await fsp.unlink(item.file.replace(/\.bin$/, ".json")).catch(() => {});
      total -= item.size;
    }
  }
}

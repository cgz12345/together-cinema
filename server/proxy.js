import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import config from "./config.js";
import { SegmentCache } from "./segment-cache.js";
import {
  AppError,
  openUpstream,
  readResponseLimited,
  decodeBuffer,
  resolveMaybeRelative,
} from "./utils.js";
import { localMediaPath } from "./sessions.js";

const PLAYLIST_CONTENT_TYPE =
  /(application\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)|audio\/mpegurl)/i;
const TEXT_CONTENT_TYPE = /^text\//i;
const MEDIA_CONTENT_TYPE = /^(?:video|audio)\//i;

const segmentCache = new SegmentCache({
  dir: config.segmentCacheDir,
  maxBytes: config.segmentCacheMaxBytes,
  ttlMs: config.segmentCacheTtlMs,
  maxSegmentBytes: config.segmentCacheMaxSegmentBytes,
});

function waitForCache(promise, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}


function upstreamHeaders(session, req) {
  const headers = {
    ...session.headers,
    "accept-encoding": "identity",
  };
  if (!headers.accept) headers.accept = "*/*";
  const range = req.headers.range;
  if (range) headers.range = range;
  const ifRange = req.headers["if-range"];
  if (ifRange) headers["if-range"] = ifRange;
  return headers;
}

function rewritePlaylist(text, baseUrl, sessionStore, sid) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (whole, uri) => {
          if (/^(data:|skd:)/i.test(uri)) return whole;
          const absolute = resolveMaybeRelative(uri, baseUrl);
          if (!absolute) return whole;
          return `URI="${sessionStore.childPath(sid, absolute)}"`;
        });
      }
      const absolute = resolveMaybeRelative(trimmed, baseUrl);
      if (!absolute) return line;
      return sessionStore.childPath(sid, absolute);
    })
    .join("\n");
}

function contentLooksLikePlaylist(text) {
  return text.replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U");
}

function parseRangeHeader(header, size) {
  const match = /bytes=(\d*)-(\d*)/i.exec(header || "");
  if (!match) return null;
  let start = match[1] === "" ? null : Number(match[1]);
  let end = match[2] === "" ? null : Number(match[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    const suffix = Math.min(end || 0, size);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    if (end === null || end >= size) end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true };
  }
  return { start, end };
}

async function serveLocalFile(req, res, filePath, contentType = "video/mp4") {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.status(404).type("text/plain").send("Not found");
    return;
  }
  const size = stat.size;
  const range = parseRangeHeader(req.headers.range, size);
  if (range?.invalid) {
    res.status(416).set("Content-Range", `bytes */${size}`).end();
    return;
  }
  if (range) {
    const length = range.end - range.start + 1;
    res.status(206).set({
      "Content-Type": contentType,
      "Content-Length": String(length),
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await pipeline(fs.createReadStream(filePath, { start: range.start, end: range.end }), res);
    return;
  }
  res.status(200).set({
    "Content-Type": contentType,
    "Content-Length": String(size),
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(filePath), res);
}

async function streamAndCache(res, response, headers, cacheKey, tempPath, contentType, etag, leader) {
  const source = Readable.fromWeb(response.body);
  const file = fs.createWriteStream(tempPath);
  let clientGone = false;
  let fileError = null;
  const onClose = () => {
    clientGone = true;
  };
  res.on("close", onClose);
  file.on("error", (error) => {
    fileError = error;
    source.destroy(error);
  });
  res.status(200).set(headers);
  res.flushHeaders?.();
  let bytes = 0;
  try {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (fileError) throw fileError;
      if (!file.write(chunk)) await once(file, "drain");
      if (!clientGone && !res.destroyed) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolve();
            };
            res.once("drain", done);
            res.once("close", done);
          });
        }
      }
    }
    await new Promise((resolve, reject) => {
      file.once("error", reject);
      file.end(resolve);
    });
    if (!clientGone && !res.destroyed) res.end();
    const entry = await segmentCache.write(cacheKey, tempPath, contentType, etag);
    leader.resolve({ ...entry, size: bytes });
  } catch (error) {
    file.destroy();
    await fsp.unlink(tempPath).catch(() => {});
    leader.reject(error);
    if (!res.destroyed) res.destroy(error);
  } finally {
    res.off("close", onClose);
    segmentCache.finish(cacheKey);
  }
}

async function proxyResponse(req, res, session, sessionStore, sid, targetUrl) {
  const cacheable = segmentCache.isCacheable(req, targetUrl);
  const cacheKey = cacheable ? segmentCache.keyFor(targetUrl, session.headers) : null;
  let cacheLeader = null;
  let cacheTempPath = null;
  if (cacheable) {
    const cached = await segmentCache.lookup(cacheKey);
    if (cached) {
      await serveLocalFile(req, res, cached.path, cached.contentType);
      return;
    }
    const slot = segmentCache.begin(cacheKey);
    if (slot.leader) {
      cacheLeader = slot.entry;
      cacheTempPath = segmentCache.tempPath(cacheKey);
    } else {
      const entry = await waitForCache(slot.promise);
      if (entry) {
        await serveLocalFile(req, res, entry.path, entry.contentType);
        return;
      }
    }
  }

  const clientAbort = new AbortController();
  let finished = false;
  res.on("finish", () => {
    finished = true;
  });
  res.on("close", () => {
    if (!finished && !cacheable) clientAbort.abort("client closed");
  });

  let upstream;
  try {
    upstream = await openUpstream(targetUrl, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: upstreamHeaders(session, req),
      timeoutMs: config.streamFetchTimeoutMs,
      maxRedirects: 6,
      signal: clientAbort.signal,
    });
  } catch (error) {
    if (cacheLeader) {
      cacheLeader.reject(error);
      segmentCache.finish(cacheKey);
    }
    if (!res.headersSent) {
      res.status(error.status || 502).type("text/plain").send(error.message || "上游读取失败");
    } else {
      res.destroy();
    }
    return;
  }

  const { response, finalUrl } = upstream;
  const status = response.status;
  const contentType = response.headers.get("content-type") || "";
  const contentEncoding = response.headers.get("content-encoding") || "";
  const isPlaylistUrl = /\.m3u8(?:$|[?#])/i.test(finalUrl) || /m3u8/i.test(new URL(finalUrl).search);
  const contentLength = Number(response.headers.get("content-length")) || 0;
  const shouldReadPlaylist =
    isPlaylistUrl ||
    PLAYLIST_CONTENT_TYPE.test(contentType) ||
    (TEXT_CONTENT_TYPE.test(contentType) &&
      !contentEncoding &&
      (!contentLength || contentLength < 2_000_000));

  if (req.method === "HEAD") {
    const headers = {
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=60",
      "Accept-Ranges": response.headers.get("accept-ranges") || "bytes",
    };
    const length = response.headers.get("content-length");
    if (length) headers["Content-Length"] = length;
    res.status(status).set(headers).end();
    await response.body?.cancel().catch(() => {});
    return;
  }

  if (shouldReadPlaylist) {
    if (cacheLeader) {
      cacheLeader.resolve(null);
      segmentCache.finish(cacheKey);
    }
    let buffer;
    try {
      ({ buffer } = await readResponseLimited(response, config.maxPlaylistBytes));
    } catch (error) {
      if (!res.headersSent) res.status(error.status || 502).type("text/plain").send(error.message);
      return;
    }
    const text = decodeBuffer(buffer, contentType);
    if (contentLooksLikePlaylist(text)) {
      const rewritten = rewritePlaylist(text, finalUrl, sessionStore, sid);
      const body = Buffer.from(rewritten, "utf8");
      res.status(200).set({
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
      return;
    }
    if (isPlaylistUrl) {
      if (!res.headersSent) res.status(502).type("text/plain").send("上游返回的不是有效的 HLS 播放列表");
      return;
    }
    res.status(status).set({
      "Content-Type": contentType || "text/plain; charset=utf-8",
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    });
    res.end(buffer);
    return;
  }

  const headers = {
    "Content-Type": contentType || "application/octet-stream",
    "Cache-Control": session.isLive ? "private, max-age=30" : "private, max-age=3600",
  };
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = response.headers.get(name);
    if (value) headers[name.replace(/(^|-)([a-z])/g, (_, dash, ch) => `${dash}${ch.toUpperCase()}`)] = value;
  }
  if (contentEncoding && contentEncoding !== "identity") {
    delete headers["Content-Length"];
    delete headers["Content-Range"];
  }
  if (!response.body) {
    if (cacheLeader) {
      cacheLeader.resolve(null);
      segmentCache.finish(cacheKey);
    }
    res.status(status).set(headers).end();
    return;
  }

  const cacheWrite =
    cacheLeader &&
    status === 200 &&
    !response.headers.get("content-range") &&
    (!contentEncoding || contentEncoding === "identity") &&
    (!contentLength || contentLength <= config.segmentCacheMaxSegmentBytes) &&
    (!contentType || MEDIA_CONTENT_TYPE.test(contentType) || /octet-stream/i.test(contentType));
  if (cacheWrite) {
    await streamAndCache(
      res,
      response,
      headers,
      cacheKey,
      cacheTempPath,
      contentType || "application/octet-stream",
      response.headers.get("etag"),
      cacheLeader,
    );
    return;
  }
  if (cacheLeader) {
    cacheLeader.resolve(null);
    segmentCache.finish(cacheKey);
  }
  res.status(status).set(headers);
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!finished) res.destroy(error);
  }
}

export function createStreamHandlers(sessionStore) {
  return {
    entry: async (req, res) => {
      const session = sessionStore.get(req.params.sid);
      if (!session) {
        res.status(404).type("text/plain").send("播放会话已过期，请重新添加影片");
        return;
      }
      if (session.localPath) {
        try {
          await serveLocalFile(req, res, path.resolve(session.localPath));
        } catch (error) {
          if (!res.headersSent) res.status(500).type("text/plain").send(error.message || "读取失败");
          else res.destroy();
        }
        return;
      }
      if (!session.url) {
        res.status(502).type("text/plain").send("播放地址为空");
        return;
      }
      try {
        await proxyResponse(req, res, session, sessionStore, session.id, session.url);
      } catch (error) {
        if (!res.headersSent) res.status(error.status || 502).type("text/plain").send(error.message || "读取失败");
        else res.destroy();
      }
    },

    child: async (req, res) => {
      const { sid, sig, enc } = req.params;
      const session = sessionStore.get(sid);
      if (!session) {
        res.status(404).type("text/plain").send("播放会话已过期");
        return;
      }
      const targetUrl = sessionStore.verifyChild(sid, sig, enc);
      if (!targetUrl) {
        res.status(403).type("text/plain").send("签名无效");
        return;
      }
      try {
        await proxyResponse(req, res, session, sessionStore, sid, targetUrl);
      } catch (error) {
        if (!res.headersSent) res.status(error.status || 502).type("text/plain").send(error.message || "读取失败");
        else res.destroy();
      }
    },
  };
}

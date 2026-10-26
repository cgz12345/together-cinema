const ACCESS_KEY = "wp.accessCode";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "request_failed", hints = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hints = hints;
  }
}

export function getAccessCode() {
  try {
    return localStorage.getItem(ACCESS_KEY) || "";
  } catch {
    return "";
  }
}

export function setAccessCode(value) {
  try {
    if (value) localStorage.setItem(ACCESS_KEY, value);
    else localStorage.removeItem(ACCESS_KEY);
  } catch {
    // ignore
  }
}

export function clearAccessCode() {
  setAccessCode("");
}

async function request(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const accessCode = getAccessCode();
  if (accessCode) headers["x-access-code"] = accessCode;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ApiError("请求超时了，解析长视频源可能会比较慢，请再试一次", { code: "timeout" });
    }
    throw new ApiError("网络连接失败，请检查网络后重试", { code: "network_error" });
  } finally {
    clearTimeout(timer);
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw new ApiError(data.message || `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      code: data.error || "request_failed",
      hints: Array.isArray(data.hints) ? data.hints : null,
    });
  }
  return data;
}

export const api = {
  checkAccess: () => request("/api/auth/check"),
  resolve: (url, cookies = "") =>
    request("/api/resolve", { method: "POST", body: { url, cookies }, timeoutMs: 120000 }),
  startResolveJob: (url, cookies = "") =>
    request("/api/resolve/jobs", { method: "POST", body: { url, cookies }, timeoutMs: 20000 }),
  getResolveJob: (jobId) =>
    request(`/api/resolve/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 15000 }),
  createDirectRoom: (name, url, extra = {}) =>
    request("/api/rooms/direct", {
      method: "POST",
      body: { name, url, ...extra },
    }),

  createRoom: (name, token = "", candidateId = "", meta = {}) =>
    request("/api/rooms", {
      method: "POST",
      body: {
        name,
        token,
        candidateId,
        title: meta.title || "",
        poster: meta.poster || "",
        playlist: Array.isArray(meta.playlist) ? meta.playlist : undefined,
        playlistIndex: Number.isInteger(meta.playlistIndex) ? meta.playlistIndex : undefined,
      },
    }),
  discoverSearch: (query) =>
    request(`/api/discover/search?q=${encodeURIComponent(query)}`, { timeoutMs: 30000 }),
  discoverSources: () => request("/api/discover/sources"),
  addDiscoverSource: (name, api) =>
    request("/api/discover/sources", { method: "POST", body: { name, api } }),
  deleteDiscoverSource: (id) =>
    request(`/api/discover/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  liveSources: () => request("/api/live/sources"),
  loadBuiltinLive: () => request("/api/live/builtin", { method: "POST", timeoutMs: 30000 }),
  addLiveSource: (payload) =>
    request("/api/live/sources", { method: "POST", body: payload, timeoutMs: 30000 }),
  deleteLiveSource: (id) =>
    request(`/api/live/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addLiveChannel: (sourceId, payload) =>
    request(`/api/live/sources/${encodeURIComponent(sourceId)}/channels`, {
      method: "POST",
      body: payload,
    }),
  deleteLiveChannel: (sourceId, channelId) =>
    request(`/api/live/sources/${encodeURIComponent(sourceId)}/channels/${encodeURIComponent(channelId)}`, {
      method: "DELETE",
    }),
  getRoom: (code) => request(`/api/rooms/${encodeURIComponent(code)}`),
  joinRoom: (code, { name, hostToken = "", memberToken = "" }) =>
    request(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST",
      body: { name, hostToken, memberToken },
    }),
  uploadImage: async (code, memberToken, blob) => {
    const headers = {
      "content-type": blob.type || "application/octet-stream",
      "x-member-token": memberToken,
    };
    const accessCode = getAccessCode();
    if (accessCode) headers["x-access-code"] = accessCode;
    const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/upload`, {
      method: "POST",
      headers,
      body: blob,
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      throw new ApiError(data.message || `图片上传失败（HTTP ${response.status}）`, {
        status: response.status,
        code: data.error || "upload_failed",
      });
    }
    return data;
  },
  health: () => request("/api/health", { timeoutMs: 8000 }),
};

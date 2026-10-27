import { WebSocketServer } from "ws";
import { clamp, RateLimiter } from "./utils.js";
import { refreshRoomVideo, buildDirectVideo } from "./sessions.js";

function send(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // ignore broken sockets
  }
}

function broadcast(room, payload, { exceptId = null } = {}) {
  const data = JSON.stringify(payload);
  for (const member of room.members.values()) {
    if (member.id === exceptId) continue;
    if (member.ws?.readyState === 1) {
      try {
        member.ws.send(data);
      } catch {
        // ignore
      }
    }
  }
}

function clearBufferTimer(room) {
  if (room.bufferTimer) {
    clearTimeout(room.bufferTimer);
    room.bufferTimer = null;
  }
}

function broadcastPlayback(room, action, extra = {}) {
  broadcast(room, {
    type: "playback",
    action,
    playing: room.playback.playing,
    position: room.positionAt(),
    rate: room.playback.rate,
    at: Date.now(),
    ...extra,
  });
}

function broadcastMembers(room) {
  broadcast(room, { type: "members", members: room.publicMembers(), hostId: room.hostId, hostOnline: room.hostOnline() });
}

function maybeAutoWait(room) {
  if (!room.settings.autoWait || !room.video) return;
  const now = Date.now();
  if (room.suppressAutoWaitUntil && now < room.suppressAutoWaitUntil) return;
  // Only consider a stall that has lasted for a moment. Transient `waiting`
  // events during seeks/prefetch used to cause a pause/resume loop.
  // 卡住的人本地其实没在动，投影会把基线推到超前位置，恢复时所有人被
  // 集体拉回去 → 重新缓冲 → 再卡，循环"反复播放同一段"。所以定格在
  // 「最后已知的真实位置」（最后一次心跳/动作的位置），不推进时钟。
  const buffering = [...room.members.values()].filter(
    (member) =>
      member.online &&
      member.buffering &&
      now - (member.bufferingSince || 0) > 500 &&
      now - (member.bufferingSince || 0) < 15000,
  );
  if (room.playback.playing && buffering.length && !room.pausedForBuffer) {
    clearBufferTimer(room);
    room.playback.playing = false;
    room.playback.updatedAt = now;
    room.pausedForBuffer = true;
    broadcastPlayback(room, "pause", { reason: "buffering" });
    const message = room.addSystem("正在等待缓冲…");
    broadcast(room, { type: "chat", message });
    return;
  }
  if (room.pausedForBuffer && !buffering.length) {
    clearBufferTimer(room);
    room.bufferTimer = setTimeout(() => {
      room.bufferTimer = null;
      if (!room.pausedForBuffer) return;
      const stillBuffering = [...room.members.values()].some(
        (member) => member.online && member.buffering,
      );
      if (stillBuffering || room.playback.playing) return;
      room.pausedForBuffer = false;
      room.play();
      // Don't let a single late buffer event immediately pause again.
      room.suppressAutoWaitUntil = Date.now() + 6000;
      broadcastPlayback(room, "play", { reason: "resume" });
      const message = room.addSystem("缓冲完成，继续播放");
      broadcast(room, { type: "chat", message });
    }, 1200);
  }
}

export function attachWebSocket(server, { rooms, resolvedStore }) {
  const wss = new WebSocketServer({
    noServer: true,
    // 字幕（VTT）可能上百 KB，96KB 的 payload 上限会让整部剧的字幕
    // 根本传不上去。聊天/信令都很小，放到 1MB 不影响限流效果。
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  const limiter = new RateLimiter({ windowMs: 10_000, max: 80 });
  const chatLimiter = new RateLimiter({ windowMs: 10_000, max: 12 });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const code = url.searchParams.get("code") || "";
    const token = url.searchParams.get("token") || "";
    const room = rooms.get(code);
    const member = room?.getMemberByToken(token);
    if (!room || !member) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { room, member });
    });
  });

  wss.on("connection", (ws, req, { room, member }) => {
    if (typeof ws._wpLimiterKey !== "string") ws._wpLimiterKey = `${member.id}:${Date.now()}:${Math.random()}`;

    if (member.ws && member.ws !== ws) {
      try {
        member.ws.close(4002, "replaced");
      } catch {
        // ignore
      }
    }
    member.ws = ws;
    member.online = true;
    const recentReconnect = member.hasConnected && Date.now() - member.lastSeen < 8000;
    if (member.leaveTimer) {
      clearTimeout(member.leaveTimer);
      member.leaveTimer = null;
    }
    member.hasConnected = true;
    member.lastSeen = Date.now();
    // 回来人了，取消「所有人都掉了」的待定休眠，token 还有效。
    room.cancelSleep();
    if (member.isHost) {
      room.hostId = member.id;
      room.hostOfflineSince = null;
    }

    // 睡了很久的房间，播放会话可能已经过期，连上时补一次。
    // 续期后 room.video.src 已更新，init 里带的就是新地址。
    refreshRoomVideo(room, resolvedStore.sessions);
    send(ws, { type: "init", state: room.stateFor(member) });
    if (!recentReconnect) {
      const joinMessage = room.addSystem(`${member.name} 已进入放映室`);
      if (joinMessage) broadcast(room, { type: "chat", message: joinMessage }, { exceptId: member.id });
    }
    broadcastMembers(room);

    ws.on("message", (raw) => {
      const key = ws._wpLimiterKey;
      if (!limiter.take(key)) {
        send(ws, { type: "error", code: "rate_limited", message: "操作太快了，歇一下" });
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", code: "bad_json", message: "消息格式错误" });
        return;
      }
      if (!message || typeof message.type !== "string") return;
      member.lastSeen = Date.now();
      room.touch();

      const hostOnly = () => {
        if (!member.isHost) {
          send(ws, { type: "error", code: "host_only", message: "只有主持人可以操作" });
          return false;
        }
        return true;
      };

      const canControl = () => {
        if (!room.video) {
          send(ws, { type: "error", code: "no_video", message: "还没有添加影片" });
          return false;
        }
        if (room.settings.controlMode === "host" && !member.isHost) {
          send(ws, { type: "error", code: "host_only", message: "当前只有主持人可以控制播放" });
          return false;
        }
        return true;
      };

      // 切到指定集：换视频源、把进度归零、广播给所有人
      const playEpisode = (index) => {
        if (!canControl()) return;
        const list = room.playlist || [];
        if (!list.length) {
          send(ws, { type: "error", code: "no_playlist", message: "这部片子没有剧集列表" });
          return;
        }
        if (!Number.isInteger(index) || index < 0 || index >= list.length) {
          send(ws, { type: "error", code: "no_next", message: "没有这一集" });
          return;
        }
        if (index === room.playlistIndex && room.video) return;
        const item = list[index];
        try {
          // 直播频道列表复用 playEpisode 换台：item.isLive 让换台后仍是直播语义
          // （不 seek 归位、禁倍速），item.headers 带上 m3u 里解析出的 UA/Referer。
          const headers = {};
          if (typeof item.ua === "string" && item.ua && item.ua.length <= 512) {
            headers["user-agent"] = item.ua;
          }
          if (typeof item.referer === "string" && item.referer && /^https?:\/\//i.test(item.referer) && item.referer.length <= 512) {
            headers.referer = item.referer;
          }
          const isLive = item.isLive === true;
          const video = buildDirectVideo(resolvedStore.sessions, {
            url: item.url,
            title: item.title,
            isLive,
            headers,
          });
          room.playlistIndex = index;
          room.setVideo(video, {
            url: item.url,
            headers,
            kind: video.kind,
            isLive,
            title: item.title,
            duration: null,
            localPath: null,
          });
          room.play(0);
          broadcast(room, {
            type: "video",
            video,
            playlist: {
              index,
              total: list.length,
              title: item.title,
              items: list.map((entry, i) => ({ index: i, title: entry.title || `第 ${i + 1} 集` })),
            },
          });
          broadcast(room, {
            type: "playback",
            action: "play",
            playing: true,
            position: 0,
            rate: room.playback.rate,
            at: Date.now(),
          });
          const chat = room.addSystem(`${member.name} 切换到了《${item.title}》`);
          broadcast(room, { type: "chat", message: chat });
        } catch (error) {
          send(ws, { type: "error", code: "next_failed", message: "这一集打不开" });
        }
      };

      switch (message.type) {
        case "ping":
          send(ws, { type: "pong", t: message.t, now: Date.now() });
          break;

        case "chat": {
          if (!chatLimiter.take(key)) {
            send(ws, { type: "error", code: "chat_rate_limited", message: "慢一点，TA 快跟不上了" });
            return;
          }
          const image =
            typeof message.image === "string" &&
            /^\/uploads\/[a-f0-9]{32}\.(?:jpg|png|webp|gif)$/.test(message.image)
              ? message.image
              : "";
          const chat = room.addChat(member, message.text, image);
          if (chat) broadcast(room, { type: "chat", message: chat });
          broadcast(room, { type: "typing", memberId: member.id, name: member.name, typing: false });
          break;
        }

        case "typing":
          broadcast(
            room,
            { type: "typing", memberId: member.id, name: member.name, typing: Boolean(message.typing) },
            { exceptId: member.id },
          );
          break;

        case "play":
          if (!canControl()) return;
          clearBufferTimer(room);
          room.suppressAutoWaitUntil = Date.now() + 3000;
          room.play(Number(message.position), { clientTs: Number(message.clientTs) });
          broadcastPlayback(room, "play", { by: member.name });
          break;

        case "pause":
          if (!canControl()) return;
          clearBufferTimer(room);
          room.suppressAutoWaitUntil = Date.now() + 3000;
          room.pause(Number(message.position), { clientTs: Number(message.clientTs) });
          broadcastPlayback(room, "pause", { by: member.name });
          break;

        case "seek":
          if (!canControl()) return;
          room.seek(Number(message.position), { clientTs: Number(message.clientTs) });
          room.suppressAutoWaitUntil = Date.now() + 5000;
          broadcastPlayback(room, "seek", { by: member.name });
          break;

        case "rate":
          if (!canControl()) return;
          if (room.video?.isLive) {
            send(ws, { type: "error", code: "live_rate", message: "直播流不支持倍速" });
            return;
          }
          room.suppressAutoWaitUntil = Date.now() + 3000;
          room.setRate(Number(message.rate));
          broadcastPlayback(room, "rate", { by: member.name });
          break;

        case "ended":
          if (!canControl()) return;
          room.pause(room.video?.duration || room.positionAt());
          broadcastPlayback(room, "ended", { by: member.name });
          break;

        case "heartbeat":
          if (member.isHost) room.heartbeat(Number(message.position), { clientTs: Number(message.clientTs) });
          break;

        case "buffering": {
          const buffering = Boolean(message.buffering);
          if (member.buffering !== buffering) {
            member.buffering = buffering;
            member.bufferingSince = buffering ? Date.now() : 0;
            broadcastMembers(room);
            if (buffering) {
              // The stall must survive the hysteresis window before the room
              // pauses, so check once more after that window.
              // 但如果刚 play/seek 过，suppress 窗口还没走完——那就把检查
              // 推迟到窗口结束后，而不是干脆不查（曾经就是这样：对方真的
              // 卡住了，auto-wait 却被 suppress 吞掉，永远不暂停等待）。
              clearTimeout(room.bufferingCheckTimer);
              const runCheck = () => {
                room.bufferingCheckTimer = null;
                maybeAutoWait(room);
              };
              const suppressLeft = room.suppressAutoWaitUntil ? room.suppressAutoWaitUntil - Date.now() : 0;
              const delay = Math.max(550, suppressLeft + 50);
              room.bufferingCheckTimer = setTimeout(runCheck, delay);
              room.bufferingCheckTimer.unref?.();
            } else {
              clearTimeout(room.bufferingCheckTimer);
              room.bufferingCheckTimer = null;
              maybeAutoWait(room);
            }
          }
          break;
        }

        case "setVideo": {
          if (!hostOnly()) return;
          try {
            const video = resolvedStore.toVideo(message.token, message.candidateId, {
              title: typeof message.title === "string" ? message.title : "",
              poster: typeof message.poster === "string" ? message.poster : "",
            });
            room.setVideo(
              video,
              resolvedStore.describeSource(message.token, message.candidateId),
            );
            clearBufferTimer(room);
            broadcast(room, { type: "video", video });
            broadcastPlayback(room, "video");
            const chat = room.addSystem(`${member.name} 添加了《${video.title}》`);
            broadcast(room, { type: "chat", message: chat });
          } catch (error) {
            send(ws, { type: "error", code: error.code || "set_video_failed", message: error.message });
          }
          break;
        }

        case "settings": {
          if (!hostOnly()) return;
          const settings = message.settings || {};
          if (typeof settings.autoWait === "boolean") room.settings.autoWait = settings.autoWait;
          if (settings.controlMode === "shared" || settings.controlMode === "host") {
            room.settings.controlMode = settings.controlMode;
          }
          broadcast(room, { type: "settings", settings: room.settings });
          break;
        }

        case "rename": {
          const name = String(message.name || "").trim().replace(/\s+/g, " ").slice(0, 24);
          if (!name) return;
          member.name = name;
          broadcastMembers(room);
          break;
        }

        case "claimHost": {
          if (!room.claimHost(member)) {
            send(ws, { type: "error", code: "host_online", message: "主持人还在线，或刚离开不到 1 分钟，稍后再试" });
            return;
          }
          broadcastMembers(room);
          broadcastPlayback(room, "host", { by: member.name });
          const chat = room.addSystem(`${member.name} 接管了主持人`);
          broadcast(room, { type: "chat", message: chat });
          break;
        }

        case "voiceOn": {
          member.voice = true;
          const peers = [...room.members.values()]
            .filter((item) => item.online && item.voice && item.id !== member.id)
            .map((item) => ({ id: item.id, name: item.name }));
          send(ws, { type: "voicePeers", peers });
          broadcast(
            room,
            { type: "voiceState", memberId: member.id, name: member.name, on: true },
            { exceptId: member.id },
          );
          break;
        }

        case "voiceOff": {
          member.voice = false;
          broadcast(
            room,
            { type: "voiceState", memberId: member.id, name: member.name, on: false },
            { exceptId: member.id },
          );
          break;
        }

        case "voiceSignal": {
          const target = message.to ? room.members.get(String(message.to)) : null;
          if (!target || !target.ws || target.ws.readyState !== 1) break;
          send(target.ws, { type: "voiceSignal", from: member.id, data: message.data || null });
          break;
        }

        case "playDirect": {
          // 房间里直接换一个直链/直播频道（看电视入口用）：可选带上整份
          // 频道列表当播放列表，之后就能用「换台」在频道间切换。
          if (!hostOnly()) return;
          const url = String(message.url || "").trim();
          if (!/^https?:\/\//i.test(url)) {
            send(ws, { type: "error", code: "bad_url", message: "频道地址不对" });
            return;
          }
          try {
            const headers = {};
            if (typeof message.ua === "string" && message.ua && message.ua.length <= 512) {
              headers["user-agent"] = message.ua;
            }
            if (
              typeof message.referer === "string" &&
              message.referer &&
              /^https?:\/\//i.test(message.referer) &&
              message.referer.length <= 512
            ) {
              headers.referer = message.referer;
            }
            const isLive = message.isLive === true;
            const title = String(message.title || "").trim().slice(0, 80) || "直播";
            const video = buildDirectVideo(resolvedStore.sessions, { url, title, isLive, headers });
            const playlist = Array.isArray(message.playlist)
              ? message.playlist
                  .filter((item) => item && typeof item.url === "string" && /^https?:\/\//i.test(item.url))
                  .slice(0, 300)
                  .map((item) => ({
                    title: String(item.title || "频道").slice(0, 80),
                    url: item.url,
                    isLive: item.isLive === true,
                    ua: typeof item.ua === "string" ? item.ua.slice(0, 512) : "",
                    referer: typeof item.referer === "string" ? item.referer.slice(0, 512) : "",
                  }))
              : [];
            if (playlist.length) {
              room.playlist = playlist;
              room.playlistIndex = playlist.findIndex((item) => item.url === url);
              if (room.playlistIndex < 0) room.playlistIndex = 0;
            } else {
              room.playlist = [];
              room.playlistIndex = 0;
            }
            room.setVideo(video, {
              url,
              headers,
              kind: video.kind,
              isLive,
              title,
              duration: null,
              localPath: null,
            });
            room.play(0);
            clearBufferTimer(room);
            broadcast(room, {
              type: "video",
              video,
              playlist: room.playlist.length
                ? {
                    index: room.playlistIndex,
                    total: room.playlist.length,
                    title: room.playlist[room.playlistIndex]?.title || "",
                    items: room.playlist.map((item, i) => ({
                      index: i,
                      title: item.title || `频道 ${i + 1}`,
                    })),
                  }
                : null,
            });
            broadcastPlayback(room, "video");
            const chat = room.addSystem(`${member.name} 切换到了《${title}》`);
            broadcast(room, { type: "chat", message: chat });
          } catch (error) {
            send(ws, { type: "error", code: "play_direct_failed", message: "切换失败" });
          }
          break;
        }

        case "nextEpisode": {
          playEpisode((room.playlistIndex || 0) + 1);
          break;
        }

        case "selectEpisode": {
          playEpisode(Number(message.index));
          break;
        }

        case "subtitle": {
          const vtt = String(message.vtt || "");
          if (!vtt) {
            room.subtitle = null;
            broadcast(room, { type: "subtitle", subtitle: null });
            break;
          }
          if (vtt.length > 900000) {
            send(ws, { type: "error", code: "subtitle_too_big", message: "字幕文件太大了" });
            break;
          }
          room.subtitle = {
            name: String(message.name || "字幕").slice(0, 60),
            vtt,
          };
          broadcast(room, { type: "subtitle", subtitle: room.subtitle });
          break;
        }

        case "requestSync":
          send(ws, {
            type: "sync",
            playing: room.playback.playing,
            position: room.positionAt(),
            rate: room.playback.rate,
            at: Date.now(),
            requested: true,
          });
          break;

        // 房主模式下，观众想暂停/拖动进度不直接被拒，而是把请求递给主持人，
        // 由主持人弹窗批准后才真正执行。主持人离线时直接回绝。
        case "controlRequest": {
          const action = String(message.action || "");
          if (!["play", "pause", "seek", "rate"].includes(action)) {
            send(ws, { type: "controlResponse", approved: false, action, reason: "invalid" });
            break;
          }
          const host = room.getHost();
          if (!host || !host.online || !host.ws || host.ws.readyState !== 1) {
            send(ws, { type: "controlResponse", approved: false, action, reason: "host_offline", by: "" });
            break;
          }
          send(host.ws, {
            type: "controlRequest",
            fromId: member.id,
            fromName: member.name,
            action,
            position: Number(message.position) || 0,
            rate: Number(message.rate) || 1,
          });
          break;
        }

        // 主持人批准/拒绝后，把结果回给提出申请的观众。
        case "controlResponse": {
          const target = message.to ? room.members.get(String(message.to)) : null;
          if (!target || !target.ws || target.ws.readyState !== 1) break;
          send(target.ws, {
            type: "controlResponse",
            approved: Boolean(message.approved),
            action: String(message.action || ""),
            by: member.name,
            reason: String(message.reason || ""),
          });
          break;
        }

        default:
          break;
      }
    });

    ws.on("close", () => {
      if (member.ws !== ws) return;
      member.ws = null;
      member.online = false;
      member.buffering = false;
      member.lastSeen = Date.now();
      if (member.isHost) {
        room.hostOfflineSince = Date.now();
      }
      if (member.voice) {
        member.voice = false;
        broadcast(room, { type: "voiceState", memberId: member.id, name: member.name, on: false });
      }
      broadcastMembers(room);
      maybeAutoWait(room);
      if (member.leaveTimer) {
        clearTimeout(member.leaveTimer);
        member.leaveTimer = null;
      }
      // 最后一个人走了不立刻休眠：ws 抖动、iOS 切后台选图都会断一会儿，
      // 立刻睡会把成员表和 token 清光，回来重连直接 401，聊天永远连不上。
      // 2.5 分钟内有人回来就取消（scheduleSleep 内部会再确认一次人数）。
      if (room.onlineCount() === 0) {
        room.scheduleSleep();
        return;
      }
      member.leaveTimer = setTimeout(() => {
        member.leaveTimer = null;
        if (member.online) return;
        const message = room.addSystem(`${member.name} 离开了放映室`);
        if (message) broadcast(room, { type: "chat", message });
      }, 5000);
      member.leaveTimer.unref?.();
    });

    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  });

  const syncTimer = setInterval(() => {
    for (const room of rooms.rooms.values()) {
      if (room.sleeping || !room.video) continue;
      // 兜底：某端上报了「缓冲中」但恢复上报丢了（ws 断过、页面切后台、
      // 定时器被挂起），超过 12 秒还没恢复就视为缓冲完了。否则对方会
      // 一直显示「正在缓冲」，auto-wait 也会把大家反复暂停。
      const now = Date.now();
      let staleBuffering = false;
      for (const member of room.members.values()) {
        if (member.buffering && now - (member.bufferingSince || 0) > 12000) {
          member.buffering = false;
          member.bufferingSince = 0;
          staleBuffering = true;
        }
      }
      if (staleBuffering) broadcastMembers(room);
      // 兜底：bufferingCheckTimer 可能被 suppress 窗口推迟/漏掉，
      // 每轮 sync 顺带检查一次，保证真卡顿一定会触发等待。
      maybeAutoWait(room);
      const payload = {
        type: "sync",
        playing: room.playback.playing,
        position: room.positionAt(),
        rate: room.playback.rate,
        at: Date.now(),
      };
      broadcast(room, payload);
    }
  }, 2500);
  syncTimer.unref?.();

  const cleanupTimer = setInterval(() => {
    limiter.cleanup();
    chatLimiter.cleanup();
  }, 60 * 1000);
  cleanupTimer.unref?.();

  return wss;
}

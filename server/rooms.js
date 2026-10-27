import { randomCode, randomId, clamp } from "./utils.js";
import config from "./config.js";

const NAME_MAX = 24;
const CHAT_MAX = 800;
const CHAT_HISTORY = 200;
const MEMBER_COLORS = [
  "#ff6b9d",
  "#c084fc",
  "#7dd3fc",
  "#fbbf24",
  "#34d399",
  "#fb7185",
  "#a78bfa",
  "#38bdf8",
];

function sanitizeName(raw) {
  const value = String(raw || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\uFFFD/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
  return value || "访客";
}

function sanitizeText(raw) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, CHAT_MAX);
}

function colorForName(name, index) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return MEMBER_COLORS[(hash + index) % MEMBER_COLORS.length];
}

class Room {
  constructor(code, hostName) {
    this.code = code;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.hostToken = randomId(24);
    this.hostId = null;
    this.hostOfflineSince = null;
    this.members = new Map();
    this.tokens = new Map();
    this.chat = [];
    this.video = null;
    this.subtitle = null;
    this.playlist = [];
    this.playlistIndex = 0;
    // 播放会话 6 小时就过期，房间可能睡得更久。留着源信息，唤醒时重建。
    this.videoSource = null;
    this.playback = { playing: false, position: 0, rate: 1, updatedAt: Date.now() };
    this.settings = { autoWait: true, controlMode: "shared" };
    this.autoWaitPausedAt = 0;
    this.suppressAutoWaitUntil = 0;
    this.pausedForBuffer = false;
    this.bufferTimer = null;
    this.bufferingCheckTimer = null;
    this.memberSequence = 0;
    // 休眠：房间里一个人都没有时进入。播放计时冻结、成员表清空，
    // 但 video / playback / chat 原样保留，等人回来接着看。
    this.sleeping = false;
    this.sleptAt = 0;
    this.wokeAt = 0;
    this.sleepTimer = null;
    const host = this.addMember(hostName, { forceHost: true });
    this.hostId = host.id;
    this.createdBy = host.id;
  }

  addMember(name, { hostToken = "", memberToken = "", forceHost = false } = {}) {
    if (this.sleeping) this.wake();
    // 有人回来（重连/新加入）就取消待定的休眠
    this.cancelSleep();
    const existing = memberToken ? this.tokens.get(memberToken) : null;
    if (existing) {
      const member = this.members.get(existing);
      if (member) {
        member.name = sanitizeName(name || member.name);
        member.online = true;
        member.lastSeen = Date.now();
        if (hostToken && hostToken === this.hostToken) {
          for (const other of this.members.values()) other.isHost = other.id === member.id;
          this.hostId = member.id;
          member.isHost = true;
          this.hostOfflineSince = null;
        }
        return member;
      }
    }

    this.memberSequence += 1;
    const id = randomId(8);
    const token = randomId(20);
    const isHost = forceHost || (!this.hostId && ![...this.members.values()].some((item) => item.isHost)) ||
      (hostToken && hostToken === this.hostToken);
    const member = {
      id,
      name: sanitizeName(name),
      token,
      isHost: Boolean(isHost),
      online: false,
      ws: null,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      buffering: false,
      bufferingSince: 0,
      color: colorForName(name || "访客", this.memberSequence),
    };
    this.members.set(id, member);
    this.tokens.set(token, id);
    if (isHost) {
      for (const other of this.members.values()) other.isHost = other.id === id;
      this.hostId = id;
      this.hostOfflineSince = null;
    }
    this.touch();
    return member;
  }

  touch() {
    this.lastActive = Date.now();
  }

  getMemberByToken(token) {
    const id = this.tokens.get(token);
    if (!id) return null;
    const member = this.members.get(id);
    if (!member) return null;
    return member;
  }

  getHost() {
    if (!this.hostId) return null;
    return this.members.get(this.hostId) || null;
  }

  hostOnline() {
    const host = this.getHost();
    return Boolean(host?.online);
  }

  onlineCount() {
    let count = 0;
    for (const member of this.members.values()) {
      if (member.online) count += 1;
    }
    return count;
  }

  /**
   * 人都走光了：定格进度、停止计时，不占着广播资源。
   * 播放链接、进度、音量设置和聊天记录都留着。
   */
  sleep() {
    if (this.sleeping) return false;
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    // 先把「正在播」换算成确定的时间点，否则 clock 会一直跑下去。
    this.rebase();
    this.playback.playing = false;
    this.pausedForBuffer = false;
    this.suppressAutoWaitUntil = 0;
    this.autoWaitPausedAt = 0;
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.bufferTimer = null;
    }
    if (this.bufferingCheckTimer) {
      clearTimeout(this.bufferingCheckTimer);
      this.bufferingCheckTimer = null;
    }
    // 成员和令牌全部清掉，只留房主那条记录，方便他下次直接认回主持身份。
    const host = this.getHost();
    for (const [id, member] of this.members) {
      if (host && id === host.id) {
        member.online = false;
        member.buffering = false;
        member.ws = null;
        continue;
      }
      this.tokens.delete(member.token);
      this.members.delete(id);
    }
    if (host) {
      host.isHost = true;
      this.hostId = host.id;
    }
    this.hostOfflineSince = Date.now();
    this.sleeping = true;
    this.sleptAt = Date.now();
    return true;
  }

  wake() {
    if (!this.sleeping) return false;
    this.sleeping = false;
    this.sleptAt = 0;
    this.wokeAt = Date.now();
    this.lastActive = Date.now();
    this.hostOfflineSince = null;
    return true;
  }

  /**
   * 最后一个人掉线时不立刻睡：iOS 去相册选图、切后台、网络抖动都会让
   * ws 断一会儿，旧逻辑一断线就清空成员表，回来重连 token 已失效，
   * 聊天输入框永远停在「连接中」（用户看到的就是「按钮没了」）。
   * 给 2.5 分钟宽限（短于离线成员 3 分钟 TTL），有人回来就取消。
   */
  scheduleSleep(delayMs = 150_000) {
    if (this.sleeping || this.sleepTimer) return;
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      if (this.sleeping || this.onlineCount() > 0) return;
      this.sleep();
    }, delayMs);
    this.sleepTimer.unref?.();
  }

  cancelSleep() {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
  }

  ensureHost() {
    if (this.hostId && this.members.has(this.hostId)) return;
    const online = [...this.members.values()].filter((member) => member.online).sort((a, b) => a.joinedAt - b.joinedAt);
    const next = online[0] || [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) {
      for (const member of this.members.values()) member.isHost = false;
      next.isHost = true;
      this.hostId = next.id;
    }
  }

  claimHost(member) {
    const host = this.getHost();
    const canClaim =
      !host ||
      (!host.online && this.hostOfflineSince && Date.now() - this.hostOfflineSince > 60_000);
    if (!canClaim) return false;
    for (const item of this.members.values()) item.isHost = item.id === member.id;
    this.hostId = member.id;
    this.hostOfflineSince = null;
    this.addSystem(`${member.name} 成为了主持人`);
    return true;
  }

  setVideo(video, source = null) {
    this.video = video;
    if (source) this.videoSource = source;
    this.playback = { playing: false, position: 0, rate: 1, updatedAt: Date.now() };
    this.pausedForBuffer = false;
    this.suppressAutoWaitUntil = 0;
    this.touch();
  }

  positionAt(now = Date.now()) {
    if (!this.video) return 0;
    const limit = Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : Infinity;
    if (!this.playback.playing) return clamp(this.playback.position, 0, limit);
    const projected = this.playback.position + ((now - this.playback.updatedAt) / 1000) * this.playback.rate;
    return clamp(projected, 0, limit);
  }

  rebase(now = Date.now()) {
    const position = this.positionAt(now);
    this.playback.position = Number.isFinite(position) ? position : 0;
    this.playback.updatedAt = now;
    return this.playback.position;
  }

  // 房主上报的 position 是他「发出那一刻」的位置。消息在路上会花掉一点时间，
  // 这里把这一段上行延迟按倍速补回去（钳位 1.5 秒，顺便挡掉时钟偏差），
  // 这样服务端基线就是「收到这刻」的真实位置，下行再靠客户端的 at 补偿，
  // 整条链路的延迟都被吃掉了。clientTs 是房主用「服务器时间估计」填的
  // （本地时间 + 时钟偏移），所以 now - clientTs 就是纯粹的网络延迟。
  advanceByTransit(position, rate, clientTs) {
    let target = clamp(Number(position) || 0, 0, this.video?.duration || Infinity);
    if (Number.isFinite(clientTs)) {
      const transit = clamp(Date.now() - clientTs, -1500, 1500) / 1000;
      target = clamp(target + transit * rate, 0, this.video?.duration || Infinity);
    }
    return target;
  }

  play(position, { clientTs = null } = {}) {
    if (!this.video) return;
    const now = Date.now();
    const target = this.advanceByTransit(position, this.playback.rate, clientTs);
    if (Number.isFinite(position)) this.playback.position = target;
    this.playback.playing = true;
    this.playback.updatedAt = now;
    this.pausedForBuffer = false;
    this.touch();
  }

  pause(position, { clientTs = null } = {}) {
    if (!this.video) return;
    const now = Date.now();
    const target = Number.isFinite(position)
      ? this.advanceByTransit(position, this.playback.rate, clientTs)
      : this.positionAt(now);
    this.playback.position = target;
    this.playback.playing = false;
    this.playback.updatedAt = now;
    this.pausedForBuffer = false;
    this.touch();
  }

  seek(position, { clientTs = null } = {}) {
    if (!this.video) return;
    this.playback.position = this.advanceByTransit(position, this.playback.rate, clientTs);
    this.playback.updatedAt = Date.now();
    this.touch();
  }

  setRate(rate) {
    const value = clamp(Number(rate) || 1, 0.25, 3);
    if (!this.video) {
      this.playback.rate = value;
      return;
    }
    const now = Date.now();
    this.rebase(now);
    this.playback.rate = value;
    this.playback.updatedAt = now;
    this.touch();
  }

  heartbeat(position, { clientTs = null } = {}) {
    if (!this.video || !this.playback.playing) return;
    if (!Number.isFinite(position)) return;
    this.playback.position = this.advanceByTransit(position, this.playback.rate, clientTs);
    this.playback.updatedAt = Date.now();
    this.touch();
  }

  addChat(member, text, image = "") {
    if (this.sleeping) return null;
    const value = sanitizeText(text);
    if (!value && !image) return null;
    const message = {
      id: randomId(8),
      memberId: member.id,
      name: member.name,
      color: member.color,
      text: value,
      ts: Date.now(),
      ...(image ? { image } : {}),
    };
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.touch();
    return message;
  }

  addSystem(text) {
    // 房间已经休眠时不再写系统消息：它们只会在下次进入时变成一串没人看得懂的"已离开"。
    if (this.sleeping) return null;
    const message = { id: randomId(8), system: true, text: String(text).slice(0, 200), ts: Date.now() };
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY) this.chat.splice(0, this.chat.length - CHAT_HISTORY);
    this.touch();
    return message;
  }

  publicMembers() {
    return [...this.members.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((member) => ({
        id: member.id,
        name: member.name,
        color: member.color,
        isHost: member.isHost,
        online: member.online,
        buffering: member.buffering,
      }));
  }

  publicInfo() {
    return {
      code: this.code,
      title: this.video?.title || "",
      hasVideo: Boolean(this.video),
      memberCount: [...this.members.values()].filter((member) => member.online).length,
      hostOnline: this.hostOnline(),
      createdAt: this.createdAt,
      lastActive: this.lastActive,
    };
  }

  stateFor(member) {
    return {
      code: this.code,
      video: this.video,
      playback: {
        playing: this.playback.playing,
        position: this.positionAt(),
        rate: this.playback.rate,
        at: Date.now(),
      },
      settings: this.settings,
      subtitle: this.subtitle,
      playlist: this.playlist.length
        ? {
            index: this.playlistIndex,
            total: this.playlist.length,
            title: this.playlist[this.playlistIndex]?.title || "",
            items: this.playlist.map((item, index) => ({
              index,
              title: item.title || `第 ${index + 1} 集`,
            })),
          }
        : null,
      members: this.publicMembers(),
      hostId: this.hostId,
      hostOnline: this.hostOnline(),
      iceServers: config.iceServers,
      sleeping: this.sleeping,
      wokeAt: this.wokeAt,
      you: { id: member.id, name: member.name, color: member.color, isHost: member.isHost },
      chat: this.chat,
    };
  }

  removeIfStale(now = Date.now()) {
    if (this.sleeping) {
      // 休眠房间的计时从入睡那刻开始，比活跃房间保留得久。
      return now - this.sleptAt > config.sleepingRoomTtlMs;
    }
    if (now - this.lastActive > config.roomTtlMs) return true;
    for (const [id, member] of this.members) {
      if (member.isHost) continue; // 房主那条留着，休眠时要用
      if (!member.online && now - member.lastSeen > config.offlineMemberTtlMs) {
        this.members.delete(id);
        this.tokens.delete(member.token);
      }
    }
    return false;
  }
}

export class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.timer = setInterval(() => this.cleanup(), 60 * 1000);
    this.timer.unref?.();
  }

  create(hostName) {
    let code = randomCode(6);
    let attempts = 0;
    while (this.rooms.has(code) && attempts < 50) {
      code = randomCode(6);
      attempts += 1;
    }
    const room = new Room(code, hostName);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    if (!code) return null;
    return this.rooms.get(String(code).toUpperCase()) || null;
  }

  cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.removeIfStale(now)) {
        this.rooms.delete(code);
        continue;
      }
      // 兜底：断连事件偶尔会丢，靠每分钟巡检把空房间置为休眠。
      if (!room.sleeping && room.onlineCount() === 0 && now - room.lastActive > 60 * 1000) {
        room.sleep();
      }
    }
  }
}

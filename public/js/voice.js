// 连麦：浏览器之间点对点传音频，服务端只转发信令，不碰声音。
// 人数少（几个人的房间）时用 mesh 足够，谁开麦就跟其他开麦的人各建一条连接。

const FALLBACK_ICE = [
  { urls: "stun:stun.qq.com:3478" },
  { urls: "stun:stun.miwifi.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

export class VoiceChat {
  constructor({ send, onState, onError, selfId, iceServers = null }) {
    this.send = send;
    this.onState = onState;
    this.onError = onError;
    this.selfId = selfId;
    // 优先用服务器下发的 ICE（含 TURN 中继），拿不到就退回公共 STUN。
    this.iceServers = Array.isArray(iceServers) && iceServers.length ? iceServers : FALLBACK_ICE;
    this.stream = null;
    this.peers = new Map();
    this.enabled = false;
  }

  async enable() {
    if (this.enabled) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onError?.("这个浏览器不支持麦克风");
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (error) {
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      this.onError?.(denied ? "麦克风权限被拒绝，请在浏览器设置里允许" : "打不开麦克风");
      return;
    }
    this.enabled = true;
    this.onState?.(true, this.peers.size);
    this.send("voiceOn", {});
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.send("voiceOff", {});
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.onState?.(false, 0);
  }

  /** 服务端告诉我「已经在麦上的人」，由我这边主动发起。 */
  handlePeers(peers = []) {
    if (!this.enabled) return;
    for (const peer of peers) {
      if (peer.id && peer.id !== this.selfId) this.createOffer(peer.id);
    }
  }

  async handleSignal({ from, data }) {
    if (!data || !from || from === this.selfId) return;
    if (!this.enabled) return;
    if (data.type === "offer") {
      const peer = this.ensurePeer(from);
      try {
        await peer.pc.setRemoteDescription(data.sdp);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.send("voiceSignal", { to: from, data: { type: "answer", sdp: answer } });
      } catch {
        this.dropPeer(from);
      }
      return;
    }
    if (data.type === "answer") {
      const peer = this.peers.get(from);
      if (peer) await peer.pc.setRemoteDescription(data.sdp).catch(() => {});
      return;
    }
    if (data.type === "candidate" && data.candidate) {
      const peer = this.peers.get(from);
      if (peer) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  handleState({ memberId, on }) {
    if (on || !memberId) return;
    this.dropPeer(memberId);
  }

  ensurePeer(id) {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.dataset.voicePeer = id;
    audio.style.display = "none";
    document.body.appendChild(audio);

    const peer = { pc, audio };
    this.peers.set(id, peer);

    if (this.stream) {
      for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);
    }
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.send("voiceSignal", {
        to: id,
        data: { type: "candidate", candidate: event.candidate },
      });
    };
    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      audio.srcObject = stream;
      audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.dropPeer(id);
      }
    };
    this.onState?.(this.enabled, this.peers.size);
    return peer;
  }

  async createOffer(id) {
    const peer = this.ensurePeer(id);
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.send("voiceSignal", { to: id, data: { type: "offer", sdp: offer } });
    } catch {
      this.dropPeer(id);
    }
  }

  dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    try {
      peer.pc.close();
    } catch {
      // ignore
    }
    peer.audio.srcObject = null;
    peer.audio.remove();
    this.peers.delete(id);
    this.onState?.(this.enabled, this.peers.size);
  }
}

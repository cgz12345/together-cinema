import test from "node:test";
import assert from "node:assert/strict";
import { extractFromHtml, parseHlsPlaylist, cookieHeaderForHost } from "../server/resolver.js";
import { RoomManager } from "../server/rooms.js";

test("extractFromHtml finds MacCMS player_aaaa URL", () => {
  const html = `
    <html><head><title>测试影片</title><meta property="og:image" content="/cover.jpg"></head>
    <body><script>
      var player_aaaa={"flag":"play","encrypt":0,"url":"https%3A%2F%2Fcdn.example.com%2Fhls%2Fmaster.m3u8"};
    </script></body></html>`;
  const result = extractFromHtml(html, "https://movies.example.com/vod/play/1/1");
  assert.equal(result.title, "测试影片");
  assert.ok(result.streams.includes("https://cdn.example.com/hls/master.m3u8"));
  assert.equal(result.poster, "https://movies.example.com/cover.jpg");
});

test("extractFromHtml handles escaped and relative media URLs", () => {
  const html = `
    <video><source src="/media/ep1/index.m3u8"></video>
    <script>const cfg = {"url":"https:\\/\\/cdn.example.net\\/a\\/b.mp4?token=1&amp;x=2"};</script>
    <iframe src="/player/embed/9"></iframe>`;
  const result = extractFromHtml(html, "https://site.example.com/watch/9");
  assert.ok(result.streams.includes("https://site.example.com/media/ep1/index.m3u8"));
  assert.ok(result.streams.includes("https://cdn.example.net/a/b.mp4?token=1&x=2"));
  assert.ok(result.iframes.includes("https://site.example.com/player/embed/9"));
});

test("parseHlsPlaylist reads master variants", () => {
  const playlist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080
1080.m3u8
`;
  const parsed = parseHlsPlaylist(playlist, "https://cdn.example.com/master.m3u8");
  assert.equal(parsed.isMaster, true);
  assert.equal(parsed.variants.length, 2);
  assert.equal(parsed.height, 1080);
  assert.equal(parsed.variants[0].url, "https://cdn.example.com/720.m3u8");
  assert.equal(parsed.isLive, false);
});

test("parseHlsPlaylist reads VOD duration and live flag", () => {
  const vod = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:6,
a.ts
#EXTINF:4.5,
b.ts
#EXT-X-ENDLIST
`;
  const parsed = parseHlsPlaylist(vod, "https://cdn.example.com/vod/index.m3u8");
  assert.equal(parsed.duration, 10.5);
  assert.equal(parsed.isLive, false);

  const live = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6,
a.ts
#EXTINF:6,
b.ts
`;
  assert.equal(parseHlsPlaylist(live, "https://cdn.example.com/live/index.m3u8").isLive, true);
});

test("cookieHeaderForHost understands Netscape cookie files", () => {
  const netscape = `# Netscape HTTP Cookie File
.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc123
.other.com\tTRUE\t/\tFALSE\t0\tsid\tnope
`;
  assert.equal(cookieHeaderForHost(netscape, "video.example.com"), "sid=abc123");
  assert.equal(cookieHeaderForHost("a=1; b=2", "video.example.com"), "a=1; b=2");
});

test("room playback position extrapolates from rate", () => {
  const manager = new RoomManager();
  const room = manager.create("测试");
  room.setVideo({ title: "x", duration: 100, isLive: false });
  room.play(10);
  const fiveSecondsLater = room.playback.updatedAt + 5000;
  assert.ok(room.positionAt(fiveSecondsLater) >= 14.9);
  assert.ok(room.positionAt(fiveSecondsLater) <= 15.1);
  room.setRate(2);
  const twoSecondsLater = room.playback.updatedAt + 2000;
  assert.ok(room.positionAt(twoSecondsLater) >= 13.9);
  assert.ok(room.positionAt(twoSecondsLater) <= 14.1);
  room.pause(20);
  assert.equal(room.positionAt(room.playback.updatedAt + 5000), 20);
  manager.timer.unref?.();
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseM3U } from "../server/live.js";

test("parseM3U reads attributes, groups, headers and skips bad URLs", () => {
  const input = `\uFEFF#EXTM3U
#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV-1" tvg-logo="data:image/svg+xml,<svg,a></svg>" group-title="央视",CCTV-1 综合
#EXTVLCOPT:http-user-agent=TestPlayer/1.0
#EXTVLCOPT:http-referrer=https://example.com/
https://cdn.example.com/live/cctv1.m3u8
#EXTINF:-1,湖南卫视
#EXTGRP:地方
https://cdn.example.com/live/hunan.m3u8
#EXTINF:-1,Bad
http://user:pass@example.com/private.m3u8
#EXTINF:-1,Duplicate
https://cdn.example.com/live/cctv1.m3u8
#EXTINF:-1,Not http
ftp://example.com/a.m3u8
`;
  const channels = parseM3U(input);
  assert.equal(channels.length, 2);
  assert.deepEqual(channels[0], {
    name: "CCTV-1 综合",
    group: "央视",
    url: "https://cdn.example.com/live/cctv1.m3u8",
    logo: "data:image/svg+xml,<svg,a></svg>",
    ua: "TestPlayer/1.0",
    referer: "https://example.com/",
  });
  assert.equal(channels[1].name, "湖南卫视");
  assert.equal(channels[1].group, "地方");
});

test("parseM3U reads TVBox-style JSON lists", () => {
  const input = JSON.stringify({
    lives: [
      { name: "CCTV1", group: "央视", url: "https://cdn.example.com/1/index.m3u8" },
      {
        name: "CCTV2",
        group: "央视",
        urls: [
          { url: "https://cdn.example.com/2/index.m3u8" },
          "https://cdn.example.com/2/backup.m3u8",
        ],
      },
      { name: "duplicate", url: "https://cdn.example.com/1/index.m3u8" },
    ],
  });
  const channels = parseM3U(input);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].name, "CCTV1");
  assert.equal(channels[1].url, "https://cdn.example.com/2/index.m3u8");
});

test("parseM3U reads plain text channel lines", () => {
  const input = `央视,CCTV1,https://cdn.example.com/1.m3u8
湖南,卫视,https://cdn.example.com/2.m3u8
# comment
invalid line
https://cdn.example.com/3.m3u8
`;
  const channels = parseM3U(input);
  assert.equal(channels.length, 3);
  assert.equal(channels[0].name, "CCTV1");
  assert.equal(channels[0].group, "央视");
  assert.equal(channels[1].name, "卫视");
  assert.equal(channels[2].name, "频道 3");
});

test("parseM3U respects maxChannels", () => {
  const lines = ["#EXTM3U"];
  for (let i = 0; i < 10; i += 1) {
    lines.push(`#EXTINF:-1,Channel ${i}`, `https://cdn.example.com/${i}.m3u8`);
  }
  assert.equal(parseM3U(lines.join("\n"), { maxChannels: 3 }).length, 3);
});

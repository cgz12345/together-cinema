// Curated live channels that were verified to allow browser CORS playback
// (both the playlist and the first media segment) from mainland China.
// Keeping this list small and HTTPS-only means live TV can run direct without
// touching the server's media proxy. Add more only after testing CORS and the
// segment, otherwise the player will fall back to the proxy.
export const BUILTIN_LIVE_CHANNELS = [
  {
    name: "CCTV-13 新闻",
    group: "央视",
    url: "https://event.pull.hebtv.com/jishi/cp1.m3u8",
  },
  {
    name: "CCTV-14 少儿",
    group: "央视",
    url: "https://event.pull.hebtv.com/jishi/cp2.m3u8",
  },
  {
    name: "东方卫视国际",
    group: "卫视",
    url: "https://restream.pdtvhd.com/memfs/0b1b95c9-3543-4af9-9fdb-cf45f1602f17.m3u8",
  },
  {
    name: "广东卫视",
    group: "卫视",
    url: "https://h5cul1yar48um3t.wcetv.com/hls/gdsatellite.m3u8",
  },
  {
    name: "河北卫视",
    group: "卫视",
    url: "https://event.pull.hebtv.com/live/live101.m3u8",
  },
  {
    name: "浙江国际",
    group: "卫视",
    url: "https://ali-m-l.cztv.com/channels/lantian/channel10/1080p.m3u8",
  },
  {
    name: "西藏卫视",
    group: "卫视",
    url: "https://pili-live-hls-zdzz-tv.zzxwcm.cn/zdzz-tv/nqzh.m3u8",
  },
  {
    name: "内蒙古卫视",
    group: "卫视",
    url: "https://cdn4.skygo.mn/live/disk1/NeigMGL/HLSv3-FTA/NeigMGL.m3u8",
  },
  {
    name: "广州综合",
    group: "地方",
    url: "https://tencentplaybusiness.gztv.com/live/zonghes.m3u8",
  },
  {
    name: "兰州新闻综合",
    group: "地方",
    url: "https://liveplus.lzr.com.cn/xwzh/HD/live.m3u8",
  },
  {
    name: "哈尔滨新闻综合",
    group: "地方",
    url: "https://stream.hrbtv.net/xwzh/playlist.m3u8",
  },
  {
    name: "哈尔滨影视",
    group: "地方",
    url: "https://stream.hrbtv.net/yspd/playlist.m3u8",
  },
  {
    name: "东莞新闻综合",
    group: "地方",
    url: "https://stream.sun0769.com/dgrtv1/mp4tv1_800/index.m3u8",
  },
];

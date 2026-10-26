# 两人放映室 (Together Cinema)

[![test](https://github.com/cgz12345/together-cinema/actions/workflows/test.yml/badge.svg)](https://github.com/cgz12345/together-cinema/actions/workflows/test.yml)

一个可以自己部署的、给两个人异地同步看片的轻量放映室：

- 粘贴视频页链接，自动嗅探页面里的 `.m3u8` / `.mp4` 播放地址
- 支持 yt-dlp 可解析的站点（YouTube、Bilibili 等）
- HLS 反向代理：自动补 Referer / Cookie / UA，处理防盗链和 CORS
- 不转码，保留源站原始码率；HLS 多码率可在播放器里切换
- 播放 / 暂停 / 拖动 / 倍速实时同步；对方缓冲时自动暂停等待
- 实时聊天、图片、正在输入、成员列表；全屏时也能看聊天
- 资源站搜索、按标题聚合、选集、播完自动下一集
- 直播频道：导入 m3u / txt IPTV 列表，房间内换台
- 连麦：浏览器之间 WebRTC 点对点传音频，可选 TURN
- 字幕：支持 `.srt` / `.vtt`，房间内共享
- 房间码 + 通行码；无人在线时房间休眠，第二天回来还能接着看
- 可添加到主屏幕的 PWA；移动端手势调亮度/音量/进度
- 视频默认优先直连源站（省服务器带宽），源站不允许时自动回退代理

## 技术栈

- Node.js 20+ + Express + ws（HTTP 与 WebSocket）
- 原生 JS + hls.js（前端播放器）
- yt-dlp（站点解析，可选）
- Caddy（HTTPS、反向代理、自动证书）

没有数据库。房间和聊天保存在内存中，服务重启后房间消失；影片解析结果和媒体会话有 TTL。房间无人时会冻结进度并保留 7 天。

## 本地运行

```bash
npm ci
cp .env.example .env
# 编辑 .env，至少设置 ACCESS_CODE 和 SECRET
npm start
# 打开 http://127.0.0.1:3010
```

本地测试时，如果目标地址在局域网/本机（例如本地 HLS 测试文件），可以临时：

```bash
ALLOW_PRIVATE_URLS=1 npm start
```

**不要在生产环境开启 `ALLOW_PRIVATE_URLS`。**

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；由 Caddy 反代时保持 127.0.0.1 |
| `PORT` | `3010` | 监听端口 |
| `ACCESS_CODE` | 空 | 通行码；为空则不校验。生产环境务必设置 |
| `SECRET` | 随机 | 媒体子地址签名密钥；生产环境务必固定 |
| `DATA_DIR` | `./data` | 缓存、上传和运行时数据目录 |
| `YTDLP` | `yt-dlp` | yt-dlp 可执行文件路径 |
| `FFMPEG` | `ffmpeg` | ffmpeg 路径 |
| `RESOLVE_CONCURRENCY` | `2` | 同时解析数；小内存机器建议 1 |
| `RESOLVE_TIMEOUT_MS` | `70000` | 单次解析超时 |
| `SESSION_TTL_MS` | `21600000` | 媒体会话有效期（6 小时） |
| `SLEEPING_ROOM_TTL_MS` | `604800000` | 休眠房间保留期（7 天） |
| `SEGMENT_CACHE_MAX_BYTES` | `1073741824` | 共享分片缓存上限（1 GB） |
| `MAX_UPLOAD_BYTES` | `6291456` | 聊天图片最大字节数 |
| `ICE_SERVERS` | 公共 STUN | WebRTC ICE 配置 JSON；严格 NAT 建议加 TURN |
| `SNIFFER_URL` | 空 | 可选的外部浏览器嗅探服务地址 |
| `BUILTIN_LIVE_LIST` | 空 | 留空使用内置精选 CORS 直连频道；填入 m3u 地址则改为导入外部列表 |
| `BUILTIN_LIVE_NAME` | `内置 · 精选直连` | 内置直播源显示名称 |
| `MERGE_ENABLED` | `0` | 预留：高清合并（未启用） |

## 部署（Ubuntu + systemd + Caddy）

以下命令假设应用目录是 `/opt/watchparty`，域名是 `watch.example.com`。

### 1. 安装 Node.js、yt-dlp、ffmpeg

```bash
# 以 Node.js 22 为例
curl -fLO https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.xz
sudo mkdir -p /opt/node
sudo tar -xJf node-v22.23.4-linux-x64.tar.xz -C /opt/node --strip-components=1

# yt-dlp 独立二进制
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp
sudo chmod 755 /usr/local/bin/yt-dlp

sudo apt-get update
sudo apt-get install -y ffmpeg
```

### 2. 创建服务用户并部署代码

```bash
sudo useradd --system --home-dir /opt/watchparty --shell /usr/sbin/nologin watchparty || true
sudo mkdir -p /opt/watchparty
sudo tar -xzf watchparty.tar.gz -C /opt/watchparty
cd /opt/watchparty
sudo -u watchparty /opt/node/bin/npm ci --omit=dev
sudo mkdir -p data/tmp data/cache data/home data/cache-ytdlp
sudo chown -R watchparty:watchparty /opt/watchparty
```

### 3. 配置

```bash
sudo -u watchparty cp .env.example .env
sudo -u watchparty nano .env
# 设置 ACCESS_CODE、SECRET，必要时设置 YTDLP / ICE_SERVERS
```

生成随机值：

```bash
openssl rand -hex 32   # SECRET
openssl rand -hex 4    # 通行码
```

### 4. systemd

```bash
sudo cp deploy/watchparty.service /etc/systemd/system/watchparty.service
sudo systemctl daemon-reload
sudo systemctl enable --now watchparty
sudo systemctl status watchparty --no-pager
sudo journalctl -u watchparty -f
```

### 5. Caddy

把 `deploy/Caddyfile.snippet` 的站点块追加到 `/etc/caddy/Caddyfile`，替换域名：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy 会自动申请 Let's Encrypt 证书。确认 80/443 端口在云厂商安全组里开放。

## 使用

1. 打开站点，输入通行码。
2. 粘贴视频页链接（或 `.m3u8` / `.mp4` 直链），点“解析并开播”。
3. 选择播放源，进入房间。
4. 点“邀请 TA”，把链接和通行码发给对方。
5. 对方打开链接、输入通行码，就能同步播放、聊天，必要时连麦。

### 需要登录 / 会员的站点

在解析弹窗里展开“需要登录的站点？填 Cookie”，粘贴 Netscape 格式的 Cookie 文件内容，或 `a=1; b=2` 形式的 Cookie 头。Cookie 只用于本次解析和播放会话，不写入磁盘。

获取 Netscape Cookie：浏览器安装 “Get cookies.txt LOCALLY” 等扩展，在目标站点导出。

### 直连模式

新版本默认优先让浏览器直接向源站请求视频，服务器只保留页面、聊天和同步流量。设置里可以单独关闭。

- 源站是 HTTPS、允许浏览器跨域/防盗链时，视频流量不经过服务器。
- 源站要求 Referer / Cookie、禁止 CORS，或地址是 HTTP 时，浏览器会自动回退到服务器代理。
- 直连失败会给出提示并自动回退，不会中断播放。

### 直播 / IPTV

“看电视”里可以粘贴 m3u 文本、填写列表链接或添加单个频道。频道列表存在 `DATA_DIR/live-sources.json`，不上传到第三方。直播不支持倍速和精确拖动。

首次打开且没有任何直播源时，会自动加载内置的 **精选直连频道**：CCTV-13、CCTV-14、东方卫视国际、广东卫视、河北卫视、浙江国际、西藏卫视、内蒙古卫视和几个地方新闻/影视频道。这些源都已实测 HTTPS、CORS 和首个分片可直连，正常情况不经过服务器代理。

也可以用环境变量换成完整的第三方 m3u 列表。列表里如果存在 HTTP/CORS 受限频道，会自动回退代理：

```env
BUILTIN_LIVE_LIST=https://example.com/iptv/cn.m3u
```

主输入框也支持直播：直接粘贴 m3u8、直播页链接，或没有后缀的直播地址（服务端会尝试把输入地址当作媒体流探测）。

### 连麦

点击聊天框旁边的麦克风按钮开麦。默认使用公共 STUN；对称 NAT、部分 4G/公司网络下需要配置 TURN：

```env
ICE_SERVERS=[{"urls":"turn:turn.example.com:3478","username":"user","credential":"pass"}]
```

### 浏览器嗅探（可选）

静态嗅探和 yt-dlp 都拿不到时，可以接一个独立的外部浏览器嗅探服务（例如 [hipy-sniffer](https://github.com/hjdhnx/hipy-sniffer)，GPL-3.0，独立进程，不随本项目分发）：

```env
SNIFFER_URL=http://127.0.0.1:5708
SNIFFER_EXCLUDE=obj/tos|loadjs|byteimg
```

## 架构

```
浏览器 ──HTTPS/WSS──> Caddy ──> Node/Express/ws
                                 ├── /api/resolve      页面嗅探 + yt-dlp
                                 ├── /api/discover     资源站搜索
                                 ├── /api/live         直播源
                                 ├── /api/rooms        房间、成员、播放状态
                                 ├── /p/:sid/...       HLS/MP4 代理（签名子地址）
                                 └── 内存房间 + 聊天 + 同步 + WebRTC 信令
```

- HLS 播放列表会被重写：分片、密钥、初始化段走同源代理；直连模式下则直接请求源站。
- 媒体子地址带 HMAC 签名，防止被当成开放代理。
- SSRF 防护：默认拒绝内网、回环、链路本地和云元数据地址；解析和代理都会检查。
- 访问控制：通行码 + 房间码；房间码 6 位随机生成。

## 已知限制

- 这是给两个人的私人工具，不适合公开大规模使用或公开注册。
- 直连模式需要源站允许浏览器访问；不允许时仍会走服务器代理，服务器带宽决定流畅度。
- DRM（Netflix、Disney+ 等）无法播放，不要尝试绕过。
- 页面如果只通过 JS 动态生成播放地址、且没有任何可嗅探的 m3u8/mp4，需要配置可选的浏览器嗅探 sidecar。
- 直播流不支持倍速和精确拖动。
- 房间在内存里；服务重启会清空房间。无人在线的房间会休眠 7 天。
- 请只对自己有权观看的内容使用。

## 目录

```
server/
  index.js        HTTP 路由、静态资源、错误处理
  resolver.js     页面嗅探、yt-dlp、HLS 解析
  proxy.js        HLS/MP4 代理、播放列表改写、分片缓存
  live.js         直播 m3u/txt/JSON 解析与频道管理
  sessions.js     媒体会话、解析结果、签名、房间续期
  rooms.js        房间、成员、播放状态、休眠
  ws.js           WebSocket 同步、聊天、字幕、连麦信令
public/
  index.html      页面骨架 + SVG 图标
  css/style.css   深色放映室 UI
  js/             app / player / chat / voice / api / ws / ui
  vendor/         hls.js（Apache-2.0）
deploy/
  watchparty.service
  Caddyfile.snippet
test/
  resolver.test.js
  live.test.js
```

## License

MIT。第三方依赖的许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

# Third-party notices

This project includes or depends on the following third-party software.

## hls.js

- Vendored file: `public/vendor/hls.min.js`
- License: Apache License 2.0
- Project: https://github.com/video-dev/hls.js
- Copyright: Dailymotion and hls.js contributors

hls.js is used unmodified as the browser HLS playback engine. The Apache-2.0
license text is included in `public/vendor/hls.LICENSE`.

## Express

- License: MIT
- Project: https://github.com/expressjs/express

## ws

- License: MIT
- Project: https://github.com/websockets/ws

## yt-dlp (optional runtime tool)

- License: Unlicense
- Project: https://github.com/yt-dlp/yt-dlp

yt-dlp is executed as a separate process and is not bundled.

## hipy-sniffer (optional external service)

- License: GPL-3.0
- Project: https://github.com/hjdhnx/hipy-sniffer

The optional browser sniffer is a separate HTTP service and is not included in
this repository or linked into the application. If you deploy it, comply with
its GNU GPL-3.0 license.

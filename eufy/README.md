# Eufy Camera Viewer

Browser viewer for live Eufy camera feeds — the Eufy counterpart to
`../cam-frontend` (which serves Wyze cameras). It shows two camera tiles by
default, each playing a low-latency live stream.

## How it works

Eufy cameras don't expose WebRTC like Wyze. This server uses
[`eufy-security-client`](https://github.com/bropat/eufy-security-client) to:

1. Log into the Eufy cloud and open a P2P session to the station.
2. Start a camera livestream, which arrives as raw H.264/H.265 video + AAC audio
   (Node `Readable` streams).
3. Pipe those through FFmpeg (bundled via `ffmpeg-static`) into an MPEG-TS
   stream pushed over a WebSocket.
4. Play it in the browser with [`mpegts.js`](https://github.com/xqq/mpegts.js)
   (Media Source Extensions). H.265 is transcoded to H.264 for browser support;
   H.264 is copied as-is.

## Setup

```bash
cd eufy
npm install
cp .env.example .env   # then fill in your Eufy cloud credentials
npm start
```

Open http://localhost:3040.

### First-run 2FA / captcha (handled in the browser)

The Eufy cloud usually requires a one-time verification on first login. The
viewer page handles this directly — no terminal interaction:

- **Captcha**: the page shows the captcha image; type the characters and submit.
- **2FA**: the page shows an input; enter the code emailed/texted to you.

If the code is wrong or expired, the page automatically shows the next captcha
the cloud issues. Once verified, the camera grid appears.

The session token is cached in `EUFY_PERSIST_DIR` (default `./persist`), so
subsequent launches connect silently (the auth panel won't appear).

## Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `EUFY_USERNAME` / `EUFY_PASSWORD` | Eufy cloud account login |
| `EUFY_COUNTRY` / `EUFY_LANGUAGE` | Cloud region (e.g. `US` / `en`) |
| `EUFY_PERSIST_DIR` | Session/token cache dir (default `./persist`) |
| `EUFY_CAMERA_SERIALS` | Optional comma-separated serials to show, in order. Empty = first two cameras |
| `EUFY_VIEWER_PORT` | Viewer port (default `3040`) |

## Notes & limitations

- **Not verified end-to-end** here — it requires a real Eufy account and at
  least one online camera. Logic and library API calls are wired per the
  `eufy-security-client` docs.
- Battery cameras only stream while awake/triggered; always-on doorbells and
  wired cams stream on demand.
- Eufy stations allow a limited number of concurrent P2P streams; two cameras on
  the *same* station may contend.

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
| `EUFY_SNAPSHOT_DIR` | Cached snapshot JPEGs (default `$EUFY_PERSIST_DIR/snapshots`) |
| `EUFY_CAMERA_SERIALS` | Optional comma-separated serials to show, in order. Empty = first two cameras |
| `EUFY_VIEWER_PORT` | Viewer port (default `3040`) |

## Battery-friendly thumbnails (snapshots without keeping the camera awake)

Battery-powered Eufy cams drain fast under continuous live view, so the
dashboard never auto-streams them. Instead each tile shows a thumbnail by
default, and the live stream only starts when you click ▶ Start. Three
mechanisms keep the thumbnail current:

- **A — Cloud event thumbnail (zero battery cost).** The Eufy cloud already
  stores a JPEG every time the camera detects motion. This server subscribes
  to the SDK's `picture` property and caches each one to disk under
  `EUFY_SNAPSHOT_DIR`. No extra wake-ups — the camera was already awake for
  the event that produced the image. Pushed to the dashboard over SSE so
  open tabs update live.
- **B — On-demand snapshot (low battery cost).** Click the **🔄 Refresh**
  button on a tile: the server briefly wakes the camera, captures one H.264
  frame, transcodes it to JPEG with ffmpeg, and stops the livestream
  immediately. One short wake per click.
- **C — Periodic snapshot (medium battery cost).** Each Eufy tile has an
  **Auto** dropdown (`Off / 1 / 5 / 15 / 30 / 60 min`). When set, the server
  runs a single timer per camera that triggers the same on-demand capture on
  that cadence. Server-side so two open tabs share one wake per tick. Pauses
  automatically while a live viewer is active on that camera. The schedule
  is persisted to `EUFY_PERSIST_DIR/autosnap.json` and restored on restart.

With the dropdown set to **Off** (default), only A + B are active — A keeps
the thumb fresh on real motion, B refreshes on demand.

A green/amber/red **🔋 N%** badge in each tile's header shows the live
battery level (turns ⚡ blue while charging). It refreshes whenever the SDK
reports a property change or after any snapshot capture (A/B/C).

### HTTP API additions

| Endpoint | Description |
| --- | --- |
| `GET  /api/snapshot/:sn` | Latest cached JPEG for camera `sn`. 404 until at least one image exists. |
| `POST /api/snapshot/:sn/refresh` | Trigger an on-demand snapshot (option B). Returns the new JPEG. Refuses (502 "Live viewer active…") if a viewer is streaming the same camera. |
| `GET  /api/autosnap` | `{ allowed: [1,5,15,30,60], config: { <sn>: minutes, ... } }` — full schedule. |
| `POST /api/autosnap/:sn` | Body: `{ minutes: 0\|1\|5\|15\|30\|60 }`. `0` disables the schedule for that camera. |

`GET /api/cameras` payload now also includes `battery` (0-100 or `null` for
wired models) and `batteryCharging` (boolean).

The existing `GET /api/events` SSE stream gained two event types:
`{ type: "snapshot", sn, ts }` after every snapshot save, and
`{ type: "battery", sn, battery, batteryCharging }` after each property
change or snapshot.

## Notes & limitations

- **Not verified end-to-end** here — it requires a real Eufy account and at
  least one online camera. Logic and library API calls are wired per the
  `eufy-security-client` docs.
- Battery cameras only stream while awake/triggered; always-on doorbells and
  wired cams stream on demand.
- Eufy stations allow a limited number of concurrent P2P streams; two cameras on
  the *same* station may contend.

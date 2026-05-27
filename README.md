# wyze-cams

> **This project is a fork of [jfarmer08/wyze-api](https://github.com/jfarmer08/wyze-api).**
> It keeps the underlying library and adds **cam-frontend** — a browser dashboard for live
> camera feeds and device control — plus Docker packaging to run it as a container.

[![Chat](https://img.shields.io/discord/1134601590762913863)](https://discord.gg/Mjkpq2x9)

## Camera Dashboard (cam-frontend)

`cam-frontend/` is a self-contained web app that shows all your cameras on one page
(<http://localhost:3030>):

- **Wyze** cameras stream over WebRTC, with per-camera controls (siren, motion/recording,
  notifications, flood/spotlight on supported models, plus experimental two-way talk). This
  runs on top of the library in `src/`.
- **Eufy** cameras stream from a separate backend process (`eufy/`) that logs into the Eufy
  cloud, opens a P2P session, and transcodes to MPEG-TS with ffmpeg. The dashboard proxies
  that backend (`/api/eufy/*` and the `/eufy-stream` WebSocket), so the browser only ever
  talks to a single origin. Eufy tiles appear in the same grid, tagged with an **Eufy** chip.

Both apps read a **single shared `.env` at the repo root** — credentials live in one place.

### Run locally

```bash
# 1. Install dependencies (repo root = library; each app has its own deps)
npm install
cd cam-frontend && npm install && cd ..
cd eufy && npm install && cd ..

# 2. Add your credentials — one shared file at the repo root
cp .env.example .env        # then edit .env with your Wyze (and Eufy) credentials

# 3a. Start the Eufy backend (skip if you have no Eufy cameras)
cd eufy && node server.js          # backend on :3040 — keep this running

# 3b. In a second terminal, start the dashboard
cd cam-frontend && node server.js  # http://localhost:3030  ← open this
```

The Eufy backend must stay running while you use the dashboard — it does the cloud login,
P2P session, and ffmpeg transcode. The first Eufy login may need a captcha or 2FA code; the
dashboard shows the challenge inline (no terminal interaction). If you only have Wyze
cameras, skip step 3a — the Eufy tiles simply won't appear, and the dashboard still works.

`KEY_ID` and `API_KEY` come from the Wyze developer portal
(<https://developer-api-console.wyze.com/> → API Key Management) — your account password
alone is not enough to authenticate.

### Run with Docker

A `Dockerfile`, `.dockerignore`, and `docker-compose.yml` live at the repo root. The image
bundles the library source, the frontend, and a static ffmpeg (via `ffmpeg-static`) — no
system ffmpeg needed.

> **Note — Eufy is not containerized.** The Docker image serves the **Wyze** dashboard only.
> Eufy streaming relies on P2P (UDP hole-punching) that needs to be on the real network — it
> does **not** work from inside a container's NAT'd bridge (verified: it never establishes).
> So run the Eufy backend on the **host** (`cd eufy && node server.js`); the dashboard
> container reaches it via `host.docker.internal:3040` (already wired up in
> `docker-compose.yml`). Skip the host backend if you only have Wyze cameras.

**Using docker compose (recommended):**

```bash
# 1. Put your credentials in the repo-root .env first (cp from .env.example)

# 2. (Eufy only) start the Eufy backend on the host and leave it running
cd eufy && npm install && node server.js   # :3040 — in its own terminal

# 3. Build + run the dashboard container
docker compose up -d --build          # build + run in the background
docker compose logs -f                # follow logs
docker compose down                   # stop and remove the container
```

Open <http://localhost:3030>. Wyze login tokens are stored in the named `wyze-tokens` volume,
so the container won't re-authenticate on every restart.

**Using plain docker:**

```bash
docker build -t wyze-cams .

docker run -d --name wyze-cams \
  -p 3030:3030 \
  --env-file .env \
  -e PERSIST_PATH=/data \
  -e EUFY_BASE_URL=http://host.docker.internal:3040 \
  --add-host host.docker.internal:host-gateway \
  -v wyze-tokens:/data \
  wyze-cams
```

(Drop the `EUFY_BASE_URL` and `--add-host` lines if you aren't running the Eufy backend.)

To change the published port, map it explicitly, e.g. `-p 8080:3030`.

---

## Library (wyze-api)

[![npm](https://img.shields.io/npm/dt/wyze-api)](https://www.npmjs.com/package/wyze-api)
[![npm](https://img.shields.io/npm/v/wyze-api.svg?style=flat-square)](https://www.npmjs.com/package/wyze-api)
[![GitHub last commit](https://img.shields.io/github/last-commit/jfarmer08/wyze-api)](https://github.com/jfarmer08/wyze-api)


# Funding   [![Donate](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=flat-square&maxAge=2592000)](https://www.paypal.com/paypalme/AllenFarmer) [![Donate](https://img.shields.io/badge/Donate-Venmo-blue.svg?style=flat-square&maxAge=2592000)](https://venmo.com/u/Allen-Farmer) [![Donate](https://img.shields.io/badge/Donate-Cash_App-blue.svg?style=flat-square&maxAge=2592000)](https://cash.app/$Jfamer08)

This is an unofficial Wyze API. This library uses the internal APIs from the Wyze mobile app. A list of all Wyze devices can be retrieved to check the status of Cameras, Senors, Bulbs, Plugs, Locks and more. This API can turn on and off cameras, lightbulbs and plugs and more.

## Setup
`npm install wyze-api --save`

## Example
```
const Wyze = require('wyze-api')

const options = {
  username: process.env.username,
  password: process.env.password,
  keyId: process.env.keyId,
  apiKey: process.env.apiKey,
  persistPath: "./",
  logLevel: "none"
}
const wyze = new Wyze(options)

  ; (async () => {
    let device, state, result

    // Get all Wyze devices
    const devices = await wyze.getDeviceList()
    console.log(devices); // you could also use apiLogEnabled in options instead of your own console.log

    // Get a Wyze Bulb by name and turn it off.
    device = await wyze.getDeviceByName('Porch Light')
    result = await wyze.lightTurnOff(device.mac, device.product_model)
    console.log(result)

    // Get the state of a Wyze Sense contact sensor
    device = await wyze.getDeviceByName('Front Door')
    state = await wyze.getDeviceState(device)
    console.log(`${device.nickname} is ${state}`)

  })()
```

## Run
`username=first.last@email.om password=123456 keyId=2222222 apiKey=222222 node index.js`

## Helper methods

Use these helper methods to interact with wyze-api.

### Generic Device Methods
- wyze.getDeviceList()
- wyze.getDeviceByName(nickname)
- wyze.getDeviceByMac(mac)
- wyze.getDevicesByType(type)
- wyze.getDevicesByModel(model)
- wyze.getDeviceGroupsList()
- wyze.getDeviceSortList()
- wyze.getDeviceStatus(device)
- wyze.getDeviceState(device)
- wyze.getDevicePID(device.mac, device.product_model)
- wyze.getDeviceStatePID(device.mac, device.product_model, pid)

### Camera Methods
- wyze.cameraPrivacy(device.mac, device.product_model, value)
- wyze.cameraTurnOn(device.mac, device.product_model)
- wyze.cameraTurnOff(device.mac, device.product_model)
- wyze.cameraSiren(device.mac, device.product_model, value)
- wyze.cameraSirenOn(device.mac, device.product_model)
- wyze.cameraSirenOff(device.mac, device.product_model)
- wyze.cameraFloodLight(device.mac, device.product_model, value)
- wyze.cameraFloodLightOn(device.mac, device.product_model)
- wyze.cameraFloodLightOff(device.mac, device.product_model)
- wyze.cameraSpotLight(device.mac, device.product_model, value)
- wyze.cameraSpotLightOn(device.mac, device.product_model)
- wyze.cameraSpotLightOff(device.mac, device.product_model)
- wyze.cameraMotionOn(device.mac, device.product_model)
- wyze.cameraMotionOff(device.mac, device.product_model)
- wyze.cameraSoundNotificationOn(device.mac, device.product_model)
- wyze.cameraSoundNotificationOff(device.mac, device.product_model)
- wyze.cameraNotifications(device.mac, device.product_model, value)
- wyze.cameraNotificationsOn(device.mac, device.product_model)
- wyze.cameraNotificationsOff(device.mac, device.product_model)
- wyze.cameraMotionRecording(device.mac, device.product_model, value)
- wyze.cameraMotionRecordingOn(device.mac, device.product_model)
- wyze.cameraMotionRecordingOff(device.mac, device.product_model)

### Camera Stream Methods (WebRTC)

These return the credentials a WebRTC client (werift, go2rtc, Kinesis Video Streams WebRTC SDK) needs to negotiate a live stream — they do **not** return a playable URL on their own.

**Primary**:
- wyze.getCameraWebRTCConnectionInfo(mac, model, [options]) — bundled, ready-to-use shape: `{signalingUrl, iceServers, authToken, clientId, mac, model, substream, cached}`. `iceServers` are normalized to the `{urls, ...}` shape `RTCPeerConnection` expects; `signalingUrl` has any double-encoding decoded and (by default) the generated `clientId` injected as `X-Amz-ClientId`. Cached for 60s per `(mac, substream)`. Options: `substream`, `includeClientId`, `clientId`, `clientIdPrefix`, `noCache`, `cacheTtlMs`.
- wyze.getCameraWebRTCConnectionInfoWithReconnect(mac, model, [options], [retryOptions]) — same, with exponential-backoff retry. `retryOptions`: `{maxAttempts=3, baseDelayMs=2000, onRetry}`.

**Lower-level**:
- wyze.cameraGetStreamInfo(mac, model, [options]) — raw API shape `{signaling_url, ice_servers, auth_token, ...}`. `options.substream` requests the lower-bitrate sub stream.
- wyze.cameraGetSignalingUrl(mac, model, [options]) — just the raw signaling URL string
- wyze.cameraGetIceServers(mac, model, [options]) — just the raw ICE/STUN/TURN server list

**Helpers**:
- wyze.createCameraStreamClientId(deviceOrMac, [prefix="viewer"]) — generate a unique viewer client ID
- wyze.normalizeCameraSignalingUrl(url) — fix double-encoded Kinesis URLs
- wyze.sanitizeCameraIceServers(iceServers) — convert `{url}` entries to `{urls}` for `RTCPeerConnection`
- wyze.parseCameraStatus(streamInfoResponse) — non-throwing parse → `{online, powered}` or `null`
- wyze.cameraStreamWithReconnect(fn, [retryOptions]) — exponential-backoff retry wrapper for any stream call
- wyze.clearCameraStreamCache([mac]) — clear cached stream info (one camera or all)
- WyzeAPI.StreamStatus — lifecycle constants (`OFFLINE`, `STOPPING`, `DISABLED`, `STOPPED`, `CONNECTING`, `CONNECTED`)

### Camera Helper Methods

Pure (sync, take a device object):
- wyze.cameraIsOnline(device) — true if `device.device_params.status === 1`
- wyze.cameraGetThumbnail(device) — first thumbnail URL, or null
- wyze.cameraGetSnapshot(device) — first thumbnail object (`{url, type, ts, ...}`), or null
- wyze.cameraToSummary(device) — `{mac, productModel, nickname, online, thumbnail}`
- wyze.cameraGetSignalStrength(device) / cameraGetIp(device) / cameraGetFirmware(device) / cameraGetTimezone(device) / cameraGetLastSeen(device)

Lookups (async):
- wyze.getCameras() — list of all camera devices
- wyze.getOnlineCameras() / getOfflineCameras()
- wyze.getCamera(mac) — by MAC, or undefined
- wyze.getCameraByName(nickname) — by nickname (case-insensitive)
- wyze.getCameraSnapshot(mac) — cloud snapshot metadata object (or null)
- wyze.getCameraSnapshotUrl(mac) — cloud snapshot URL only
- wyze.getCameraSummaries() — summaries for all cameras
- wyze.cameraCaptureSnapshot(mac, model, [options]) — capture a JPEG frame from the live WebRTC stream. ffmpeg is provided by the bundled `ffmpeg-static` npm dep — no system install. Cached per-mac for `cacheTtlMs` (default 10s). Returns a `Buffer`.
- wyze.getCameraSnapshotImage(mac, [options]) — returns `{buffer, source}` where `source` is `"cloud"` or `"capture"`. Tries the cloud thumbnail first; on missing or download failure, falls back to `cameraCaptureSnapshot`. Pass `skipCloud: true` to go straight to live capture.

### Plug Methods
- wyze.plugPower(device.mac, device.product_model, value)
- wyze.plugTurnOn(device.mac, device.product_model)
- wyze.plugTurnOff(device.mac, device.product_model)

### Light Bulb Methods
- wyze.lightPower(device.mac, device.product_model, value)
- wyze.lightTurnOn(device.mac, device.product_model)
- wyze.lightTurnOff(device.mac, device.product_model)
- wyze.setBrightness(device.mac, device.product_model, value)
- wyze.setColorTemperature(device.mac, device.product_model, value)

### Mesh Light/Plug Methods
- wyze.turnMeshOn(device.mac, device.product_model)
- wyze.turnMeshOff(device.mac, device.product_model)
- wyze.lightMeshPower(device.mac, device.product_model, value)
- wyze.lightMeshOn(device.mac, device.product_model)
- wyze.lightMeshOff(device.mac, device.product_model)
- wyze.setMeshBrightness(device.mac, device.product_model, value)
- wyze.setMeshColorTemperature(device.mac, device.product_model, value)
- wyze.setMeshHue(device.mac, device.product_model, value)
- wyze.setMeshSaturation(device.mac, device.product_model, value)

### Wall Switch Methods
- wyze.wallSwitchPower(device.mac, device.product_model, value)
- wyze.wallSwitchPowerOn(device.mac, device.product_model)
- wyze.wallSwitchPowerOff(device.mac, device.product_model)
- wyze.wallSwitchIot(device.mac, device.product_model, value)
- wyze.wallSwitchIotOn(device.mac, device.product_model)
- wyze.wallSwitchIotOff(device.mac, device.product_model)
- wyze.wallSwitchLedStateOn(device.mac, device.product_model)
- wyze.wallSwitchLedStateOff(device.mac, device.product_model)
- wyze.wallSwitchVacationModeOn(device.mac, device.product_model)
- wyze.wallSwitchVacationModeOff(device.mac, device.product_model)

### Lock Methods
- wyze.lockLock(device)
- wyze.unlockLock(device)
- wyze.lockInfo(device)

### Lock Bolt V2 Methods (DX_LB2)
- wyze.lockBoltV2GetProperties(device.mac, device.product_model)
- wyze.lockBoltV2Lock(device.mac, device.product_model)
- wyze.lockBoltV2Unlock(device.mac, device.product_model)

### Palm Lock Methods (DX_PVLOC)
- wyze.palmLockGetProperties(device.mac, device.product_model)

### Garage Door Methods
- wyze.garageDoor(device.mac, device.product_model)

### Home Monitoring System (HMS) Methods
- wyze.getHmsID()
- wyze.setHMSState(hms_id, mode)
- wyze.getHmsUpdate(hms_id)

### Thermostat Methods
- wyze.thermostatGetIotProp(device.mac)
- wyze.thermostatSetIotProp(device.mac, device.product_model, propKey, value)

### Irrigation (Sprinker) Methods
- wyze.irrigationGetDeviceInfo(device.mac)
- wyze.irrigationGetZones(device.mac)
- wyze.irrigationQuickRun(device.mac, zoneNumber, duration)
- wyze.irrigationStop(device.mac)
- wyze.irrigationGetScheduleRuns(device.mac)
- wyze.irrigationGetIotProp(device.mac)

## Internal methods
- wyze.login()
- wyze.maybeLogin()
- wyze.refreshToken()
- wyze.getObjectList()
- wyze.getPropertyList(device.mac, device.product_model)
- wyze.setProperty(device.mac, device.product_model, propertyId, propertyValue)
- wyze.runAction(device.mac, device.product_model, actionKey)
- wyze.runActionList(device.mac, device.product_model, propertyId, propertyValue, actionKey)
- wyze.controlLock(device.mac, device.product_model, action)
- wyze.getLockInfo(device.mac, device.product_model)
- wyze.getIotProp(device.mac)
- wyze.setIotProp(device.mac, device.product_model, propKey, value)
- wyze.getUserProfile()
- wyze.disableRemeAlarm(hms_id)
- wyze.getPlanBindingListByUser()
- wyze.monitoringProfileStateStatus(hms_id)
- wyze.monitoringProfileActive(hms_id, home, away)
- wyze.iot3GetProperties(deviceMac, deviceModel, props)
- wyze.iot3RunAction(deviceMac, deviceModel, action)

## Other Info

Special thanks to the following projects for reference and inspiration:

- [ha-wyzeapi](https://github.com/JoshuaMulliken/ha-wyzeapi), a Wyze integration for Home Assistant.
- [wyze-node](https://github.com/noelportugal/wyze-node), a Node library for the Wyze API.
- [wyzeapy](https://github.com/SecKatie/wyzeapy), a Python library for the Wyze API.

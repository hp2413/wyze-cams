# wyze-api — Complete Understanding Guide

> A deep, source-verified walkthrough of what this project is, what it can do, and
> exactly *how* it does it. Every mechanism described here was traced through the
> actual code in `src/` (v1.1.14).

---

## Table of Contents

1. [What This Project Is](#1-what-this-project-is)
2. [The Core Problem It Solves](#2-the-core-problem-it-solves)
3. [Feature Inventory](#3-feature-inventory)
4. [Codebase Map](#4-codebase-map)
5. [The Big Picture — Request Lifecycle](#5-the-big-picture--request-lifecycle)
6. [Authentication Deep Dive](#6-authentication-deep-dive)
7. [Token Persistence & Refresh](#7-token-persistence--refresh)
8. [The Six Backend Services & Their Signing Schemes](#8-the-six-backend-services--their-signing-schemes)
9. [Error Handling, Retries & Rate Limiting](#9-error-handling-retries--rate-limiting)
10. [Device Discovery](#10-device-discovery)
11. [Feature Walkthroughs (with worked examples)](#11-feature-walkthroughs-with-worked-examples)
12. [Camera Streaming & Snapshot Capture](#12-camera-streaming--snapshot-capture)
13. [Local Bulb Control & Encryption](#13-local-bulb-control--encryption)
14. [Quick Reference Tables](#14-quick-reference-tables)
15. [Glossary](#15-glossary)

---

## 1. What This Project Is

**wyze-api** is an **unofficial Node.js client library** for the Wyze smart-home
ecosystem. Wyze does not publish a real public API, so this library
**reverse-engineers and emulates the official Wyze mobile app**: it talks to the
same private backend servers, sends the same headers/signatures the app sends,
and thereby lets your own Node.js code list, query, and control Wyze devices.

It is published to npm as `wyze-api` and is consumed as a class:

```javascript
const WyzeAPI = require("wyze-api");
const wyze = new WyzeAPI({ username, password, keyId, apiKey, persistPath: "./" });
const devices = await wyze.getDeviceList();
```

**Key facts:**

| Property | Value |
|---|---|
| Type | Unofficial REST/WebRTC client wrapper |
| Runtime | Node.js |
| Entry point | `src/index.js` → exports a single `WyzeAPI` class |
| Main dependency | `axios` (HTTP), `werift` + `ffmpeg-static` (WebRTC/snapshot), `crypto-js`/Node `crypto` (signing), `aws-sdk` (Roku/Cognito auth path) |
| License | MIT |

---

## 2. The Core Problem It Solves

Wyze's app communicates with **multiple independent backend services**, each with
its **own authentication signature algorithm**. A naïve HTTP call to any of them
fails — they reject anything that doesn't look exactly like the official app,
including a per-service cryptographic signature.

This library's value is that it hides all of that. You call `wyze.lockLock(device)`
and the library:

1. Ensures you have a valid access token (logging in / refreshing if needed).
2. Picks the correct backend service for that device type.
3. Builds the exact payload shape that service expects.
4. Computes the correct signature with the correct secret and algorithm.
5. Sends the request, parses the response, handles rate limits and token expiry,
   and retries when appropriate.

```
            Your one-line call
                   │
                   ▼
   ┌───────────────────────────────────────┐
   │  wyze-api hides ALL of this complexity │
   ├───────────────────────────────────────┤
   │ • which of 6 backends to hit           │
   │ • which signing algorithm (5 variants) │
   │ • which secret key                     │
   │ • exact payload field names/casing     │
   │ • token lifecycle + retry + rate limit │
   └───────────────────────────────────────┘
                   │
                   ▼
            Wyze cloud / device
```

---

## 3. Feature Inventory

What the library can actually do, grouped by capability:

- **Account & session** — login (username/password + API key/keyId), automatic
  token refresh, on-disk token persistence, login debounce.
- **Device discovery** — list all devices, find by name / MAC / type / model,
  list device groups and sort order, read raw device params.
- **Generic device control** — read property lists, set properties, run "actions"
  (single and batched action lists).
- **Cameras** — turn on/off, privacy mode, siren, floodlight, spotlight, motion
  detection toggle, motion recording toggle, sound/general notifications,
  garage-door toggle, snapshot URL, **live snapshot capture via WebRTC+FFmpeg**,
  and **full WebRTC connection bootstrapping** (signaling URL + ICE servers).
- **Lights / bulbs** — on/off, brightness, color temperature; **mesh** bulbs
  (brightness/temp/hue/saturation); **local-network** bulb control with cloud
  fallback.
- **Plugs** — on/off.
- **Wall switches** — classic power, IoT/smart control, LED indicator, vacation mode.
- **Locks** — original Wyze Lock v1 (Ford service), Lock Bolt V2 & Palm Lock
  (IoT3 service): lock/unlock + read status.
- **Thermostats** — read all IoT props, set any IoT prop (mode, setpoints, fan…).
- **Robot vacuum (JA_RO2)** — full state snapshot, start/pause/dock/stop/cancel,
  clean specific rooms, set suction level, read maps/position/sweep history, plus
  optional analytics "event tracking" ping.
- **Irrigation / sprinkler** — read zones & device info, quick-run a zone, stop,
  read schedule runs.
- **Home Monitoring System (HMS)** — get HMS id, set armed state, get updates,
  monitoring-profile activation, plan/binding lookups, disable alarm.
- **Roku-branded Wyze devices** — separate AWS Cognito + SigV4 auth path
  (`rokuAuth.js`).
- **Conversion / helper utilities** — battery checks, Kelvin↔Mired, range↔float,
  °F↔°C, brightness/color clamping, device-state parsing.

---

## 4. Codebase Map

```
src/
├── index.js              ← The WyzeAPI class. ~3,440 lines. Everything orchestrates here.
├── constants.js          ← Hard-coded app-emulation values, secrets, base URLs.
├── crypto.js             ← The 5 signing algorithms (Ford, Olive, Venus, IoT3, Web) + password hash helpers.
├── payloadFactory.js     ← Builds the request-body shapes for Ford / Olive / IoT3 endpoints.
├── util.js               ← AES-128-CBC encrypt/decrypt for local bulbs + createPassword (3× MD5).
├── types.js              ← Enums & lookup tables: property IDs, vacuum status/mode/fault codes, etc.
├── cameraStreamCapture.js← Headless WebRTC client (werift) → pipes H.264 to FFmpeg → 1 JPEG frame.
└── rokuAuth.js           ← AWS Cognito identity + SigV4-signed login for Roku-branded devices.
```

**Dependency / call graph:**

```
                       ┌──────────────────────────┐
   your app ─────────▶ │        index.js          │
                       │       (WyzeAPI class)     │
                       └───┬───┬───┬───┬───┬───┬───┘
            require()      │   │   │   │   │   │
        ┌──────────────────┘   │   │   │   │   └──────────────┐
        ▼                      ▼   │   ▼   │                  ▼
   constants.js          crypto.js │ util.js │          cameraStreamCapture.js
   (URLs, secrets,    (5 signature │ (AES +  │          (werift WebRTC + ffmpeg)
    app emulation)     algorithms) │ pwd hash)│
                                   ▼          ▼
                          payloadFactory.js  types.js
                          (body builders)    (enums/lookups)

   rokuAuth.js  ← used only by authenticateAndFetchData() (Roku path)
```

The architecture is deliberately a **fat single class** (`WyzeAPI`) with small
pure helper modules. There is no per-device-type class hierarchy; instead, each
device capability is just a method that knows which backend + signer + payload to use.

---

## 5. The Big Picture — Request Lifecycle

Most "standard" calls (device list, properties, actions, plugs, lights, switches,
cameras' simple controls) flow through one pipeline. The "special" services
(locks, thermostats, vacuums, irrigation, camera streams) bypass it and build
their own signed `axios` calls directly (covered in §8).

### The standard pipeline

```
  wyze.someMethod(...)                       e.g. setProperty(mac, model, "P3", "1")
        │
        ▼
  request(url, data)                         index.js:101
        │  await maybeLogin()  ◀── guarantees this.access_token is set
        ▼
  _handleRequest(url, data)                  index.js:117
        │  wraps data with getRequestData()  ◀── injects app-emulation fields + ts + token
        ▼
  _performRequest(url, fullData, config)     index.js:166
        │  axios POST → baseURL https://api.wyzecam.com
        │  _checkRateLimit(headers)          ◀── sleeps if quota nearly exhausted
        ▼
  _handleApiResponse(result, url, data)      index.js:266
        │  inspect result.data.code
        │   • code === 1            → success → { ...result, ok:true }
        │   • invalid credentials   → clear token + throw
        │   • 3044 / "too many…"    → mark retryAfter = now+10min
        │   • 2001 / token error    → refresh token, mark retryAfter
        │   • 1001 / 1004           → bad-request throw
        │   • anything else         → throw
        ▼
  back in _handleRequest:
        if response.ok → return
        if response.error.retryAfter → _handleRetry()  (waits, re-logs-in, retries once)
        else → throw
```

### `getRequestData` — the "look like the app" envelope

Every standard request is wrapped with these fields (`index.js:77`):

```javascript
{
  access_token: this.access_token,
  app_name:     "com.hualai.WyzeCam",   // official Android app package id
  app_ver:      "wyze_developer_api",
  app_version:  "wyze_developer_api",
  phone_id:     "wyze_developer_api",
  phone_system_type: "1",               // 1 = Android
  sc:           "wyze_developer_api",    // "service code"
  sv:           "wyze_developer_api",    // "service version"
  ts:           Date.now(),
  ...yourData
}
```

These constants come from `constants.js`. They exist purely so the request is
accepted as if it came from the real app.

---

## 6. Authentication Deep Dive

### What you must provide

Wyze requires **two credential pairs** plus optional MFA:

1. `username` + `password` — your Wyze account.
2. `keyId` + `apiKey` — developer API key pair from https://developer.wyze.com.
3. `mfaCode` — only if your account has 2FA.

### Password is never sent in plaintext — `createPassword` (`util.js:55`)

```javascript
createPassword(password) {
  const hex1 = md5(password);
  const hex2 = md5(hex1);
  return md5(hex2);          // triple-MD5, 32-char hex
}
```

So the login body sends `password: md5(md5(md5(rawPassword)))`.

### `maybeLogin()` — the gatekeeper (`index.js:420`)

Called at the top of essentially every public method. Logic:

```
maybeLogin()
   │
   ├─ this.access_token already set? ─── yes ──▶ return (nothing to do)
   │            │ no
   │            ▼
   ├─ _loadPersistedTokens()  (read ./wyze-<uuid>.json from disk)
   │            │
   │   token now set? ─── yes ──▶ return
   │            │ no
   │            ▼
   ├─ Debounce check (prevent hammering the login endpoint / lockout):
   │     isDebounceCleared(now)?  i.e.  lastAttempt + debounceMs < now
   │         ├─ YES: resetDebounceIfNeeded(now)  ── if >12h since last try, reset debounce to 1s
   │         │       tryLogin(now)               ── record attempt time, call login()
   │         │
   │         └─ NO : waitForDebounceClearance()  ── sleep in 2s steps up to debounceMs
   │                 still no token?
   │                    updateDebounceAndLogin() ── double debounceMs (cap 5 min), login()
   ▼
 done — this.access_token populated
```

The **debounce** is an exponential backoff on *login attempts*: starts at 1s,
doubles each failed cycle up to a 5-minute ceiling, and resets to 1s if 12 hours
pass with no attempts. This protects against account lockout and API throttling.

### `login()` → `_performLoginRequest()` (`index.js:368`, `389`)

```
POST https://auth-prod.api.wyze.com/api/user/login
Headers:
   x-api-key: <authApiKey constant>     (WMXHYf79...)
   apikey:    <your apiKey>
   keyid:     <your keyId>
   User-Agent: unofficial-wyze-api/<version>
Body:
   { email: username, password: tripleMd5(password) }
Response:
   { access_token, refresh_token }   → handed to _updateTokens()
```

---

## 7. Token Persistence & Refresh

### Where tokens live (`_tokenPersistPath`, `index.js:592`)

```
<persistPath>/wyze-<uuid>.json
```

`uuid` is generated by the `uuid-by-string` package from your **username** — a
deterministic UUID, so the same account always maps to the same file, and the
filename doesn't leak the raw email.

File contents (`_persistTokens`, `index.js:604`):

```json
{ "access_token": "...", "refresh_token": "..." }
```

Persistence and loading both retry once on failure. Loading is best-effort: a
missing/corrupt file simply leaves the tokens empty (which triggers a fresh login).

### Refresh (`refreshToken`, `index.js:528`)

```
POST app/user/refresh_token   (on the standard api.wyzecam.com base)
Body: getRequestData() + { refresh_token }
On success: _updateTokens(result.data.data) → new access+refresh tokens persisted
Retries: up to 2 attempts, 2s apart.
```

Two ways refresh is triggered:

1. **Reactively** — a request comes back with a token error (code `2001` or a
   message containing `accesstokenerror` / `access token is error`).
   `_handleAccessTokenError` clears the token, calls `refreshToken()`, and signals
   the caller to retry.
2. **Proactively (opt-in)** — if you pass `refreshTokenTimerEnabled: true`, the
   constructor sets `setInterval(refreshToken, 172800)`. (Note: the interval value
   is in **milliseconds**, so this actually fires ~every 172.8 *seconds*, not 48
   hours as the comment suggests — a known quirk.)

---

## 8. The Six Backend Services & Their Signing Schemes

This is the heart of "how it does what it does." Wyze devices are served by
different microservices, and **each rejects requests without its own correct
signature**. The library implements five distinct signing algorithms (`crypto.js`).

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Service     │ Used for            │ Base URL                  │ Signer    │
├─────────────┼─────────────────────┼───────────────────────────┼───────────┤
│ Auth        │ login / refresh     │ auth-prod.api.wyze.com    │ (none)    │
│ Standard    │ device list, props, │ api.wyzecam.com           │ (token in │
│  (app)      │ actions, plugs,     │                           │  body)    │
│             │ lights, switches,   │                           │           │
│             │ cameras (simple)    │                           │           │
│ Ford        │ Lock v1             │ yd-saas-toc.wyzecam.com   │ Ford sig  │
│ Olive       │ thermostat, switch  │ wyze-sirius-service /     │ HMAC-MD5  │
│  (sirius)   │ IoT props, HMS,     │ wyze-platform-service /   │ via       │
│             │ user profile,       │ wyze-lockwood (irrigation)│ signature2│
│             │ irrigation          │                           │           │
│ Venus       │ Robot vacuum JA_RO2 │ wyze-venus-service-vn     │ Venus sig │
│ IoT3        │ Lock Bolt V2,       │ app.wyzecam.com           │ IoT3 sig  │
│             │ Palm Lock,          │ (/app/v4/...)             │ +Signature2│
│             │ camera streams (web)│                           │ web sig   │
└─────────────────────────────────────────────────────────────────────────┘
```

The secrets/app-ids for each live in `constants.js`. Below, each algorithm with
its exact recipe.

### 8.1 Ford signing — Locks v1 (`crypto.js:7` / `69`, `payloadFactory.js:4`)

```
recipe:
  body = METHOD + URL_PATH                       e.g. "post/openapi/lock/v1/control"
  for each key sorted alphabetically:
       body += key + "=" + value + "&"
  drop trailing "&"
  body += fordAppSecret                          ("4deekof1...")
  urlencoded = encodeURIComponent(body)
  sign = md5(urlencoded)                          32-char hex
```

Critical subtlety encoded in `fordCreatePayload`: **GET requests put the token in
`access_token` (snake_case); POST requests use `accessToken` (camelCase)**. Sending
the wrong casing returns `PARAM_SIGN_INVALID` even when the signature is otherwise
correct. The signature is computed over the *augmented* payload (which includes
`token`, `key: fordAppKey`, and `timestamp`), not the bare payload.

```javascript
// controlLock → builds { uuid, action } then:
payload = fordCreatePayload(access_token, payload, "/openapi/lock/v1/control", "post");
axios.post("https://yd-saas-toc.wyzecam.com/openapi/lock/v1/control", payload);
```

### 8.2 Olive signing — thermostat / switch IoT / HMS / irrigation (`crypto.js:31`,`22`,`51`)

```
recipe:
  secret_digest = md5(access_token + oliveSigningSecret)   ("wyze_app_secret_key_132")
  signature     = HMAC_MD5(key = secret_digest, message = body)

  body for GET / object payloads = sorted "k=v&k=v&..." string
  body for POST set_iot_prop     = JSON.stringify(payload)   (oliveCreateSignatureSingle)
```

Sent in the **`signature2`** header, alongside `appid: oliveAppId`,
`appinfo`, `phoneid`, and `access_token`. Example from `getIotProp` (`index.js:815`):

```javascript
const payload = oliveCreateGetPayload(deviceMac, keys);     // { keys, did, nonce }
const signature = oliveCreateSignature(payload, access_token);
axios.get("https://wyze-sirius-service.wyzecam.com/plugin/sirius/get_iot_prop", {
  headers: { appid, appinfo, phoneid, access_token, signature2: signature },
  params: payload,
});
```

There are three near-identical olive functions (`oliveCreateSignature`,
`oliveCreateSignatureSingle`, `olive_create_signature`) — they differ only in
whether the body is pre-stringified or sorted-from-object. `web_create_signature`
is the same algorithm with a different secret (`webSigningSecret`) used for camera
streams.

### 8.3 Venus signing — robot vacuum (`crypto.js:97`,`104`; `index.js:1603`)

```
per request:
  nonce      = Date.now()                         (ms)
  requestid  = md5(md5(String(nonce)))            header
  key        = md5(access_token + venusSigningSecret)   ("CVCSNoa0...")
  signature2 = HMAC_MD5(key, body)

  GET : body = sorted "k=v&k=v" of {params..., nonce}   (raw, no URL-encoding)
  POST: body = JSON.stringify({payload..., nonce: String(nonce)})  (signed body == sent body)
```

`_venusRequest(method, path, payload)` centralizes this and is reused by all the
vacuum methods.

### 8.4 IoT3 signing — Lock Bolt V2 / Palm Lock (`crypto.js:85`; `index.js:2127`)

```
  secret    = md5(access_token + oliveSigningSecret)
  Signature2 = HMAC_MD5(secret, JSON.stringify(body))
```

Sent to `https://app.wyzecam.com/app/v4/iot3/get-property` and `/run-action`, with
headers including `appversion: 3.11.0.758`, `env: "Prod"`, and a random hex
`requestid`. Payloads (built by `iot3CreateGetPayload` / `iot3CreateRunActionPayload`)
carry a `nonce`, an inner `payload` (with `cmd`, `props`/`action`, random `tid`/
`action_id`, `ts`, `ver`), and `targetInfo: { id: mac, model }`.

Property/action keys are namespaced strings, e.g. `lock::lock-status`,
`lock::lock`, `battery::battery-level`, `iot-device::iot-state`.

### 8.5 Web signing — camera streams (`crypto.js:109`; `index.js:2403`)

Same HMAC-MD5 shape as Olive but with `webSigningSecret` and `webAppId`/`webAppInfo`.
Used by `cameraGetStreamInfo` (POST to `/app/v4/camera/get-streams`) to obtain the
WebRTC signaling URL + ICE servers. See §12.

---

## 9. Error Handling, Retries & Rate Limiting

All in `_handleApiResponse` and friends (`index.js:266`–`366`).

Wyze returns a `code` field in the JSON body; **`code === 1` means success.**
Anything else is an error, classified as:

| Condition | Detection | Action |
|---|---|---|
| Invalid credentials | msg contains `UserNameOrPasswordError`, `UserIsLocked`, `Invalid User Name or Password` | clear token, **throw** (no retry — avoids lockout) |
| Rate limited | `code === 3044`, or `code === 1000` + "too many failed attempts" | set `retryAfter = now + 10 min`, return `ok:false` so pipeline waits & retries |
| Access token expired | `code === 2001`, or msg contains `accesstokenerror` / `access token is error` | clear token, call `refreshToken()`, signal retry |
| Bad request | `code === 1001` or `1004` | **throw** with full request context |
| Anything else | — | **throw** generic error |

### HTTP-header rate limiting (`_checkRateLimit`, `index.js:240`)

Independently of the body `code`, the library inspects response headers:

```
x-ratelimit-remaining  →  if < 7, sleep until x-ratelimit-reset-by
```

So it proactively backs off *before* getting hard-blocked, then naturally resumes.

### Retry mechanics (`_handleRetry`, `index.js:143`)

When a recoverable error sets `retryAfter`, `_handleRequest` waits the computed
delay, calls `maybeLogin()` again (picking up a freshly refreshed token), and
re-issues the request **once**. A second failure throws.

---

## 10. Device Discovery

Everything starts from one endpoint: `app/v2/home_page/get_object_list`
(`getObjectList`, `index.js:664`). It returns the full account inventory.

```
getObjectList()  → { data: { device_list, device_group_list, device_sort_list, ... } }
       │
       ├─ getDeviceList()        → result.data.device_list  (or [])
       ├─ getDeviceGroupsList()  → device_group_list
       └─ getDeviceSortList()    → device_sort_list
```

Convenience finders (all just filter the device list in memory):

```javascript
await wyze.getDeviceByName("Porch Light");   // case-insensitive nickname match
await wyze.getDeviceByMac("AABBCCDDEEFF");    // exact .mac match
await wyze.getDevicesByType("Camera");        // .product_type (case-insensitive)
await wyze.getDevicesByModel("WLPA19C");      // .product_model (case-insensitive)
```

**A real device object** (the fields the code actually reads) looks like:

```javascript
{
  mac: "AABBCCDDEEFF",          // ← note: .mac (not .device_mac) on list entries
  nickname: "Front Door",
  product_type: "Camera",
  product_model: "WYZE_CAKP2JFUS",
  conn_state: 1,                // 1 = online (cameras)
  device_params: {              // raw live params; shape varies by device
    power_switch: 1,
    open_close_state: 0,
    battery: "95",
    ...
  }
}
```

`getDeviceStatus(device)` simply returns `device.device_params`.
`getDeviceState(device)` interprets it into `"on"/"off"` (from `power_switch`) or
`"open"/"closed"` (from `open_close_state`).

---

## 11. Feature Walkthroughs (with worked examples)

### 11.1 The three generic control primitives

Almost every simple control is sugar over one of these:

| Primitive | Endpoint | Used by |
|---|---|---|
| `setProperty(mac, model, pid, value)` | `app/v2/device/set_property` | plugs, lights, cameras' floodlight/notifications |
| `runAction(mac, model, actionKey)` | `app/v2/auto/run_action` | camera on/off, privacy, siren, garage door |
| `runActionList(mac, model, pid, value, actionKey)` | `app/v2/auto/run_action_list` | mesh bulbs, local-bulb cloud fallback |

Property IDs (`types.js`): `P3` = on/off, `P1` = notification, `P1501` = brightness,
`P1502` = color temp, `P1049` = siren, `P1056` = floodlight.

**Example — turn a plug on** (`plugTurnOn`, `index.js:2950`):

```javascript
await wyze.plugTurnOn(mac, model);
// → setProperty(mac, model, "P3", "1")
// → POST api.wyzecam.com/app/v2/device/set_property
//   body: { device_mac, device_model, pid:"P3", pvalue:"1", + getRequestData() }
```

**Example — turn a camera on** (`cameraTurnOn`, `index.js:1972`):

```javascript
await wyze.cameraTurnOn(mac, model);
// → runAction(mac, model, "power_on")
// → POST .../app/v2/auto/run_action
//   body: { instance_id:mac, provider_key:model, action_key:"power_on",
//           action_params:{}, custom_string:"" }
```

### 11.2 Lights & bulbs

```javascript
await wyze.lightTurnOn(mac, model);              // setProperty P3 = 1
await wyze.setBrightness(mac, model, 75);        // checked/clamped, setProperty P1501
await wyze.setColorTemperature(mac, model, 4000);// clamped 2700–6500K, P1502
```

**Mesh bulbs** (newer, networked) use `runActionList` with the `set_mesh_property`
family so multiple props apply atomically:

```javascript
await wyze.setMeshBrightness(mac, model, 80);
await wyze.setMeshHue(mac, model, 240);
await wyze.setMeshSaturation(mac, model, 100);
await wyze.setMeshColorTemperature(mac, model, 3500);
```

### 11.3 Locks — three different protocols

```javascript
// Original Wyze Lock v1  → Ford service (§8.1)
await wyze.lockLock(device);     // controlLock(mac, model, "remoteLock")
await wyze.unlockLock(device);   // controlLock(mac, model, "remoteUnlock")
const info = await wyze.lockInfo(device);   // getLockInfo → GET /openapi/lock/v1/info

// Lock Bolt V2 & Palm Lock → IoT3 service (§8.4)
await wyze.lockBoltV2Lock(mac, model);      // iot3RunAction "lock::lock"
await wyze.lockBoltV2Unlock(mac, model);    // "lock::unlock"
const p = await wyze.lockBoltV2GetProperties(mac, model);
const palm = await wyze.palmLockGetProperties(mac, model);
```

`getUuid(mac, model)` (`index.js:1912`) strips the model prefix some lock MACs
carry: `getUuid("DX_LOCK.AABBCC", "DX_LOCK") → "AABBCC"`.

### 11.4 Thermostat (Olive service)

```javascript
const props = await wyze.thermostatGetIotProp(mac);                // reads temp, humidity, modes…
await wyze.thermostatSetIotProp(mac, model, "heat_sp", 72);        // heat setpoint
await wyze.thermostatSetIotProp(mac, model, "mode_sys", "auto");   // off/heat/cool/auto
```

`types.js` maps human modes: `off:0, heat:1, cool:2, auto:3`; units `C:0, F:1`.

### 11.5 Robot vacuum (Venus service)

The flagship example of multi-source merging. `getVacuumInfo(mac)`
(`index.js:1710`) assembles one object from *five* sub-fetches, each wrapped so a
single failure never throws:

```
getVacuumInfo(mac)
   ├─ getVacuum(mac)            ── base list entry
   ├─ getVacuumIotProp          ── battery, mode, chargeState, cleanTime, fault… (Venus GET)
   ├─ getVacuumDeviceInfo       ── mac, ip, type, mcu version
   ├─ getVacuumStatus           ── event/heartbeat
   ├─ getVacuumCurrentPosition  ──
   └─ getVacuumCurrentMap       ──  → merged into one object
```

Controls go through `vacuumControl(mac, type, value)` → `_venusRequest`:

```javascript
await wyze.vacuumClean(mac);                 // type GLOBAL_SWEEPING(0), value START(1)
await wyze.vacuumPause(mac);                 // value PAUSE(2)
await wyze.vacuumDock(mac);                  // RETURN_TO_CHARGING(3)
await wyze.vacuumSweepRooms(mac, [1, 3]);    // AREA_CLEAN(6) with room ids
await wyze.vacuumSetSuctionLevel(mac, model, 2); // QUIET=1 / STANDARD=2 / STRONG=3
```

`types.js` decodes the device's raw numeric `mode` via `parseVacuumMode(code)`
(many codes → one label) and maps `fault_code` to human strings.
`vacuumEventTracking` is optional — it only mimics the app's analytics ping.

### 11.6 Irrigation / sprinkler (Olive / lockwood)

```javascript
const zones = await wyze.irrigationGetZones(mac);
await wyze.irrigationQuickRun(mac, 1, 10);   // zone 1, 10 minutes
await wyze.irrigationStop(mac);
const runs = await wyze.irrigationGetScheduleRuns(mac);
```

### 11.7 Home Monitoring System (HMS)

```javascript
const hmsId = await wyze.getHmsID();         // via getPlanBindingListByUser
await wyze.setHMSState(hmsId, "disarm");      // disarm / home / away
await wyze.monitoringProfileActive(hmsId, true, false); // home on, away off
```

---

## 12. Camera Streaming & Snapshot Capture

This is the most technically involved feature. Two layers:

### Layer 1 — get the WebRTC credentials (`cameraGetStreamInfo`, `index.js:2403`)

```
POST https://app.wyzecam.com/app/v4/camera/get-streams      (web signing, §8.5)
body: { device_list:[{ device_id, device_model, provider:"webrtc",
                        parameters:{ use_trickle:true, sub_stream? } }], nonce }

validates the response:
   property["iot-device::iot-state"] === 1   else "Camera is offline"
   property["iot-device::iot-power"] === 1   else "Camera is off"
returns entry.params → { signaling_url, ice_servers, auth_token }
```

`getCameraWebRTCConnectionInfo` (`index.js:2823`) wraps this with:
- **60-second in-memory cache** (keyed by mac+model+substream),
- URL normalization + ICE-server sanitization,
- a generated `clientId` (e.g. `viewer-…`),
- `getCameraWebRTCConnectionInfoWithReconnect` adds exponential-backoff retry.

So a browser/app can take `{ signalingUrl, iceServers, clientId }` and open its
own WebRTC session. (`example/viewer.js` is a browser demo of this.)

### Layer 2 — capture a still frame server-side (`cameraStreamCapture.js`)

`cameraCaptureSnapshot` / `getCameraSnapshotImage` actually negotiate WebRTC *in
Node* and pull one JPEG:

```
captureStreamFrame({ signalingUrl, iceServers })
   │
   ├─ pick a free UDP port on 127.0.0.1, write a tiny SDP file
   ├─ spawn FFmpeg (from ffmpeg-static): read RTP from that port → 1 MJPEG frame → stdout
   ├─ open RTCPeerConnection (werift), force H.264 baseline 3.1
   │      (Wyze rejects VP8/VP9 → werift's defaults would fail)
   ├─ connect signaling WebSocket:
   │      send SDP_OFFER, receive SDP_ANSWER, exchange ICE_CANDIDATEs
   │      (messages are JSON envelopes with base64 messagePayload)
   ├─ incoming H.264 RTP packets → forwarded to the local UDP port → FFmpeg
   └─ FFmpeg emits the JPEG buffer → returned to caller
   (everything torn down in finally{}: ws, pc, socket, ffmpeg, temp file)
```

```
 Wyze cam ──WebRTC/H.264──▶ werift (Node) ──RTP/UDP──▶ FFmpeg ──JPEG──▶ your code
      ▲                          │
      └──── signaling WS (SDP+ICE)┘
```

`getCameraSnapshotImage(mac)` is the smart entry point: it tries the **cloud
thumbnail URL** first and falls back to **live WebRTC capture**, returning
`{ buffer, source: "cloud" | "capture" }`.

---

## 13. Local Bulb Control & Encryption

`localBulbCommand` (`index.js:1506`) talks to a bulb **directly on the LAN** (no
cloud round-trip) and falls back to the cloud if that fails.

```
build characteristics { mac, index:"1", ts, plist:[{pid,pvalue}] }
   │
   ▼
encrypt with wyzeEncrypt(deviceEnr, json)        ── util.js:21
   │  AES-128-CBC, PKCS-style padding with 0x05 bytes,
   │  KEY == IV == deviceEnr, base64, then "/" → "\/"
   ▼
POST http://<deviceIp>:88/device_request
   body: { request:"set_status", isSendQueue:0, characteristics:<encrypted> }
   │
   ├─ success → done (no cloud needed)
   └─ HTTP error → fallback to runActionList(...) via the cloud
```

`wyzeDecrypt` reverses it (strips the `0x05` padding). `deviceEnr` is the
per-device secret obtained from the device list. Note: `util.js`/`crypto.js` both
contain `console.log` debug statements that print plaintext/ciphertext.

---

## 14. Quick Reference Tables

### Constants (`constants.js`)

| Constant | Purpose |
|---|---|
| `fordAppKey` / `fordAppSecret` | Lock v1 signing |
| `oliveSigningSecret` / `oliveAppId` | Thermostat, switch IoT, HMS, irrigation, IoT3 |
| `webSigningSecret` / `webAppId` / `webAppInfo` | Camera WebRTC stream info |
| `venusSigningSecret` / `venusAppId` | Robot vacuum |
| `authApiKey` | Static key sent on the login request |
| `appName` (`com.hualai.WyzeCam`), `phoneId`, `sc`, `sv` | App emulation envelope |
| `authBaseUrl` / `apiBaseUrl` / `irrigationBaseUrl` / `iot3BaseUrl` / `venusBaseUrl` | Service base URLs |
| `vacuumModels` (`["JA_RO2"]`) | Which models route to Venus |

### Signing algorithms at a glance

| Name | Key derivation | Message | Header |
|---|---|---|---|
| Ford | — | `method+path+sortedKV+secret`, url-encoded, md5 | `sign` field in payload |
| Olive / Web | `md5(token + secret)` | sorted `k=v&…` or JSON | `signature2` |
| IoT3 | `md5(token + oliveSecret)` | `JSON.stringify(body)` | `Signature2` |
| Venus | `md5(token + venusSecret)` | JSON (POST) / sorted KV (GET), with nonce | `signature2` + `requestid` |

### Key constructor options

```javascript
new WyzeAPI({
  username, password, keyId, apiKey,   // required credentials
  mfaCode,                             // if 2FA enabled
  persistPath: "./",                   // where wyze-<uuid>.json is written
  apiLogEnabled: false,                // verbose request/response logging
  refreshTokenTimerEnabled: false,     // periodic refresh timer (see §7 caveat)
  lowBatteryPercentage: 30,            // threshold for checkLowBattery
  // plus overrides for every base URL / app-emulation constant / secret
});
```

---

## 15. Glossary

- **Access token / refresh token** — short-lived bearer credential and the
  long-lived token used to mint new ones.
- **`pid` / `pvalue`** — Wyze "property id" and its value (e.g. `P3` = power).
- **Action key** — a named command for the `run_action` endpoint (e.g. `power_on`).
- **Ford / Olive / Sirius / Venus / IoT3** — internal Wyze service names; each is a
  separate backend with its own signing.
- **Signature2** — the HTTP header most signed services expect the HMAC in.
- **Nonce** — a per-request timestamp folded into the signature to prevent replay.
- **Mesh bulb** — a bulb on Wyze's mesh network; controlled via action lists, not
  plain `set_property`.
- **ICE / STUN / TURN / SDP** — standard WebRTC negotiation pieces; the library
  fetches the servers and signaling URL so a peer connection can be established.
- **`deviceEnr`** — a per-device secret used as the AES key/IV for LAN bulb control.

---

### Summary

`wyze-api` is, in essence, **a faithful re-implementation of the Wyze mobile app's
network layer**. Its difficulty — and its value — is entirely in the details it
hides: six backends, five signing algorithms, exact payload casing, token
lifecycle, rate-limit backoff, and a full headless WebRTC pipeline for snapshots.
Everything funnels through the single `WyzeAPI` class, which keeps the public API
trivially simple (`wyze.lockLock(device)`) while doing the precise, brittle work
required to make Wyze's servers believe they're talking to the real app.

---

## 16. Would Rewriting in Rust Help Scaling? (Analysis)

> Short verdict: **For what this project is — an I/O-bound API client gated by
> Wyze's own server-side rate limits — a Rust rewrite brings essentially no
> scaling benefit.** It helps only in a few narrow, high-concurrency or
> correctness-focused scenarios. The single highest-ROI improvement is a
> **TypeScript** rewrite, not Rust.

To answer honestly you have to be precise about what "scaling" means here. This
is a **client library** that mostly makes HTTPS calls to Wyze and does tiny crypto
signatures. The one CPU-adjacent path (WebRTC snapshot) already offloads the heavy
work to a native FFmpeg subprocess. That shape determines everything below.

### 16.1 Why Rust would NOT meaningfully improve scaling

1. **The workload is network-bound, not CPU-bound.** Latency is dominated by the
   round-trip to Wyze's servers (tens to hundreds of ms each). The local
   JS execution per call is microseconds. Making the local part faster optimizes
   the ~0.1% that isn't the bottleneck.

2. **The throughput ceiling is server-side and external.** The code already
   honors `x-ratelimit-remaining` (sleeps when `< 7`) and handles `code 3044`
   ("rate limited") and `1000`/"too many failed attempts". Wyze decides how many
   requests/minute you get. No client language can raise that ceiling — Rust would
   hit the exact same 429/3044 wall.

3. **The crypto is trivial.** MD5 and HMAC-MD5 over a few hundred bytes per request
   take microseconds in any language. Signing is not a hotspot, so SIMD/zero-copy
   gains are irrelevant.

4. **Node's async I/O already handles the concurrency this library needs.** A
   single event loop can keep thousands of in-flight HTTP requests in the air.
   For controlling a home's worth of devices (or even many homes), you are nowhere
   near needing OS threads or work-stealing schedulers.

5. **It is a library consumed by the Node ecosystem.** The primary real-world
   consumers are Node apps — Homebridge plugins, home-automation scripts, small
   Express/IoT services. A pure-Rust rewrite **breaks every existing consumer**
   unless you also ship NAPI (native addon) or WASM bindings — which reintroduces
   a Node layer and much of its overhead, defeating the purpose. That's a large
   migration cost for near-zero runtime payoff.

6. **The heavy media work is already native.** Frame extraction runs in FFmpeg
   (`ffmpeg-static`), a separate C process. Rewriting the orchestration around it
   in Rust doesn't speed up the actual decoding/encoding — that's already outside
   the VM.

7. **Ecosystem maturity is a lateral move, not an upgrade.** `werift` is a capable
   pure-JS WebRTC stack that this project depends on heavily. Rust's `webrtc-rs`
   exists and is good, but porting the signaling/SDP/ICE plumbing is effort spent
   reaching the *same* capability, not gaining new ground.

8. **Reverse-engineered APIs churn.** Wyze changes endpoints, signatures, and
   payload shapes without notice. A dynamic, fast-to-edit language is an *asset*
   for a project whose whole job is chasing an undocumented moving target;
   recompiling/re-releasing a binary toolchain slows that loop.

9. **Secrets don't get safer.** The embedded app secrets (`fordAppSecret`,
   `oliveSigningSecret`, etc.) are equally extractable from a compiled Rust binary
   as from JS. "Compiled" ≠ "secret". No security/scaling win there.

### 16.2 Where Rust genuinely WOULD help (the niche "yes")

These are real, but they apply only to specific deployment shapes — not to the
typical "control my devices" use case.

1. **Massively concurrent live streaming / snapshot ingestion.** If you build a
   *service* that holds hundreds–thousands of simultaneous WebRTC sessions (e.g. a
   fleet NVR or a multi-tenant camera backend), Rust's true multicore parallelism,
   lower per-connection memory, and **no GC pauses** become a decisive advantage
   over Node. This is the one scenario where "scaling" genuinely improves.

2. **Memory footprint & cold-start.** A single static binary with low RSS and
   instant startup is better on tiny SBCs (e.g. a Pi Zero), in slim containers, or
   in serverless/FaaS where Node cold starts and `node_modules` size hurt.

3. **Predictable real-time latency.** No garbage-collection pauses matters for the
   media path (jitter in RTP forwarding). For one-off snapshots it's irrelevant;
   for sustained live relay it can matter.

4. **Compile-time correctness — kills entire bug classes.** This is arguably the
   strongest *non-performance* argument. The current code has bugs a type system
   would have prevented:
   - The **Ford GET=`access_token` vs POST=`accessToken`** casing trap
     (`payloadFactory.js`) — a typed request model makes this impossible to get
     wrong.
   - The **`setInterval(refreshToken, 172800)` ms-vs-seconds bug** (`index.js:73`)
     — a `Duration` type forces the unit to be explicit.
   - **Stringly-typed property IDs and modes** (`"P3"`, `"heat_sp"`, `mode_sys`
     values) — Rust `enum`s + exhaustive `match` catch typos and missing cases at
     compile time.
   - Per-service signing/payload mismatches — a sealed trait per backend service
     would make "wrong signer for this endpoint" a compile error.

5. **Single-artifact distribution & supply chain.** One binary, no npm install,
   no transitive-dependency supply-chain surface (`aws-sdk`, `axios`, `werift`,
   etc. all disappear from the trust boundary).

### 16.3 The realistic recommendation (better than a full rewrite)

| Option | Effort | Scaling gain | Correctness gain | Keeps Node consumers |
|---|---|---|---|---|
| **Fix the specific bugs in place** | Tiny | ~none | Medium | ✅ |
| **TypeScript rewrite** (typed props/modes/services, typed signing layer) | Medium | ~none | **High** | ✅ |
| **Rust hot-path via NAPI** (only the WebRTC/stream engine; JS keeps the API) | High | High *only if* you run many streams | Medium | ✅ |
| **Full Rust rewrite** | Very high | High *only* at fleet/streaming scale | High | ❌ (breaks ecosystem) |

**Bottom line:** Rust is the right tool only if you are building a high-concurrency
*streaming/ingestion service* on top of Wyze cameras. For the library's actual
purpose — a convenient, correct wrapper over Wyze's private APIs — the bottleneck
is the network and Wyze's rate limits, both of which Rust cannot move. Spend the
effort on **TypeScript + fixing the known bugs** for the best return; reach for a
**Rust NAPI core on the streaming path** only when measured stream concurrency
actually demands it.

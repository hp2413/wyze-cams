# Wyze API - Complete Understanding Guide

## 📋 Table of Contents
1. [Overview](#overview)
2. [What It Does](#what-it-does)
3. [Supported Devices](#supported-devices)
4. [Architecture & Components](#architecture--components)
5. [How It Works](#how-it-works)
6. [Internal Logic & Mechanisms](#internal-logic--mechanisms)
7. [Authentication & Security](#authentication--security)
8. [API Communication Protocols](#api-communication-protocols)
9. [Key Features Explained](#key-features-explained)

---

## Overview

**wyze-api** is an **unofficial Node.js wrapper** for the Wyze smart home ecosystem. It reverse-engineers the internal APIs used by the official Wyze mobile app to provide programmatic control over Wyze devices.

**Key Points:**
- Unofficial library (not supported by Wyze)
- Built for Node.js environments
- Emulates the official Wyze mobile app to communicate with Wyze servers
- Supports 50+ different Wyze device types
- Version: 1.1.14

---

## What It Does

### High-Level Functionality

The library allows you to:

1. **List & Discover Devices** - Get all Wyze devices on your account
2. **Query Device Status** - Check current state, battery, signal strength, etc.
3. **Control Devices** - Turn devices on/off, change settings, capture snapshots
4. **Manage Properties** - Set properties like brightness, color, temperature
5. **Stream Video** - Get WebRTC stream credentials for live camera feeds
6. **Advanced Features** - Control vacuums, locks, thermostats, irrigation systems

### Example Usage Flow

```javascript
const Wyze = require('wyze-api');

// 1. Initialize with credentials
const wyze = new Wyze({
  username: 'user@email.com',
  password: 'password',
  keyId: 'YOUR_KEY_ID',
  apiKey: 'YOUR_API_KEY'
});

// 2. Get all devices
const devices = await wyze.getDeviceList();

// 3. Find and control a device
const bulb = await wyze.getDeviceByName('Living Room Light');
await wyze.lightTurnOn(bulb.mac, bulb.product_model);
```

---

## Supported Devices

### Device Categories

| Category | Examples | API Methods |
|----------|----------|-------------|
| **Cameras** | Wyze Cam v3, Cam Pan | `cameraTurnOn()`, `cameraPrivacy()`, `getCameraWebRTCConnectionInfo()` |
| **Lights** | Color Bulb, White Bulb | `lightTurnOn()`, `setBrightness()`, `setColorTemperature()` |
| **Plugs** | Smart Plug | `plugTurnOn()`, `plugTurnOff()` |
| **Sensors** | Motion, Contact, Temp | `getDeviceStatus()` |
| **Locks** | Smart Lock v1 & v2 | `lockLock()`, `unlockLock()`, `lockInfo()` |
| **Thermostats** | Smart Thermostat | `thermostatSetIotProp()` |
| **Vacuums** | Robot Vacuum (JA_RO2) | `vacuumClean()`, `vacuumPause()`, `getVacuumInfo()` |
| **Irrigation** | Sprinkler System | `irrigationQuickRun()`, `irrigationGetZones()` |
| **Garage Door** | Smart Garage Door | `garageDoor()` |
| **Wall Switches** | Smart Switch | `wallSwitchPower()` |

---

## Architecture & Components

### File Structure

```
src/
├── index.js              # Main WyzeAPI class (3441 lines)
├── constants.js          # API endpoints, keys, secrets
├── crypto.js             # Cryptographic functions for signing
├── payloadFactory.js     # Builds request payloads
├── util.js               # Encryption/decryption utilities
├── types.js              # Constants and enumerations
├── cameraStreamCapture.js # Video capture utilities
└── rokuAuth.js           # Additional auth mechanism
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Code                         │
│           (Your code using wyze-api)                        │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│                    WyzeAPI Class                             │
│  (index.js - Main orchestrator)                             │
├─────────────────────────────────────────────────────────────┤
│  • Device Management (getDeviceList, etc.)                  │
│  • Authentication (login, refreshToken)                      │
│  • Request Handling (request, _handleRequest)               │
│  • Device Control (lightTurnOn, cameraTurnOff, etc.)       │
└────────┬─────────┬──────────┬─────────┬──────────────────────┘
         │         │          │         │
    ┌────▼──┐ ┌───▼────┐ ┌───▼────┐ ┌─▼──────┐
    │Crypto │ │Payload │ │Util    │ │Types   │
    │Module │ │Factory │ │Module  │ │Module  │
    └───────┘ └────────┘ └────────┘ └────────┘
         │
    ┌────▼─────────────────┐
    │   External Services   │
    ├───────────────────────┤
    │ Wyze Auth API         │
    │ Wyze Device API       │
    │ Ford Lock API         │
    │ Olive Service         │
    │ Venus Service         │
    │ IoT3 Service          │
    └───────────────────────┘
```

---

## How It Works

### 1. Authentication Flow

#### Step 1: User Initialization
```javascript
const wyze = new Wyze({
  username: 'email@example.com',
  password: 'mypassword',
  keyId: 'PROVIDED_BY_WYZE',
  apiKey: 'PROVIDED_BY_WYZE',
  persistPath: './'
});
```

#### Step 2: First Request Triggers Login
When any API call is made, `maybeLogin()` is called automatically:

```
┌─────────────────────┐
│ Check if token      │
│ exists in memory    │
└──────────┬──────────┘
           │
      ┌────▼─────┐
      │ No token? │
      └────┬──────┘
           │
    ┌──────▼──────────┐
    │ Load from disk  │
    │ (token file)    │
    └──────┬──────────┘
           │
      ┌────▼─────┐
      │ Still no? │
      └────┬──────┘
           │
    ┌──────▼──────────────────┐
    │ Call login()            │
    │ • MD5 hash password     │
    │ • Send to auth API      │
    │ • Receive tokens        │
    │ • Save to disk          │
    └──────┬──────────────────┘
           │
    ┌──────▼──────────┐
    │ Tokens ready    │
    │ (access_token & │
    │  refresh_token) │
    └─────────────────┘
```

#### Step 3: Token Management
- **Access Token**: Valid for ~60 hours
- **Refresh Token**: Used to get new access tokens
- **Persistence**: Tokens saved to `wyze-{UUID}.json` file
- **Auto-refresh**: Optional timer can refresh before expiration

```javascript
// Automatic token refresh every 48 hours
const wyze = new Wyze({
  ...options,
  refreshTokenTimerEnabled: true  // Sets up 48-hour refresh
});
```

### 2. Request Processing Flow

Every API request goes through this pipeline:

```
User calls API method
       │
       ▼
┌──────────────────────┐
│ maybeLogin()         │ Ensure token exists
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ request(url, data)   │ Add request metadata
├──────────────────────┤
│ getRequestData()     │
│ • access_token       │
│ • app_name           │
│ • app_version        │
│ • timestamp          │
│ • phone_id           │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ _handleRequest()     │ Handle retry logic
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ _performRequest()    │ Make HTTP POST
│ (axios)              │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ _handleApiResponse() │ Parse response
├──────────────────────┤
│ • Check error codes  │
│ • Handle rate limits │
│ • Validate tokens    │
└──────────┬───────────┘
           │
           ▼
Success or Error
```

### 3. Device Control Flow

#### Example: Turning on a Light Bulb

```javascript
// Client code
const device = await wyze.getDeviceByName('Porch Light');
await wyze.lightTurnOn(device.mac, device.product_model);
```

**Behind the scenes:**

```
lightTurnOn(mac, model)
    │
    ▼
runAction(mac, model, 'power_on')
    │
    ├─ Create payload:
    │  {
    │    instance_id: mac,
    │    provider_key: model,
    │    action_key: 'power_on',
    │    action_params: {}
    │  }
    │
    ▼
request('app/v2/auto/run_action', payload)
    │
    ├─ Ensure authentication
    ├─ Add standard headers & timestamp
    ├─ POST to: https://api.wyzecam.com/app/v2/auto/run_action
    │
    ▼
Server processes command
    │
    ▼
Device receives signal
    │
    ▼
Light turns on
    │
    ▼
Response returned to client
```

---

## Internal Logic & Mechanisms

### 1. Cryptographic Signing

Wyze uses **multiple signing schemes** depending on the endpoint:

#### A. Ford Signing (Locks)
Used for Lock devices and Ford API endpoints.

```javascript
// Process:
1. Build string: METHOD + URL_PATH + SORTED_PARAMS + FORD_SECRET
2. URL encode the string
3. MD5 hash the encoded string
4. Send as signature header

Example signature:
fordCreateSignature('/openapi/lock/v1/control', 'post', payload)
    ↓
Creates string: "post/openapi/lock/v1/control..." + sorted params + secret
    ↓
MD5 hash
    ↓
Returns 32-char hex string
```

#### B. Olive Signing (Thermostat, Switch, etc.)
```javascript
// Process:
1. MD5(access_token + OLIVE_SIGNING_SECRET) = secret_digest
2. HMAC-MD5(secret_digest, sorted_params_string) = signature
3. Send as signature2 header

Keys sorted and formatted as: "k1=v1&k2=v2&k3=v3"
```

#### C. Venus Signing (Robot Vacuum)
```javascript
// Process:
1. MD5(access_token + VENUS_SIGNING_SECRET) = secret_digest
2. Nonce = current timestamp in milliseconds
3. For GET: sort params + nonce → HMAC-MD5
4. For POST: JSON.stringify(payload + nonce) → HMAC-MD5
```

#### D. IoT3 Signing (Lock Bolt V2, Palm Lock)
```javascript
// Process:
1. MD5(access_token + OLIVE_SIGNING_SECRET) = secret_digest
2. HMAC-MD5(secret_digest, JSON.stringify(body)) = signature
```

### 2. Payload Structure

Different endpoints expect different payload structures:

#### Standard Device API Payload
```javascript
{
  device_mac: "AABBCCDDEEFF",
  device_model: "WYZEDEV",
  pid: "P3",              // Property ID
  pvalue: "1",            // Property value
  access_token: "...",    // From login
  app_name: "...",        // Emulates mobile app
  ts: 1234567890,         // Timestamp
  phone_id: "..."         // Device identifier
}
```

#### Property Query Payload
```javascript
{
  device_mac: "AABBCCDDEEFF",
  device_model: "WYZEDEV",
  access_token: "...",
  app_name: "...",
  ts: 1234567890
}
```

#### Action Payload
```javascript
{
  instance_id: "AABBCCDDEEFF",
  provider_key: "WYZEDEV",
  action_key: "power_on",
  action_params: {},
  custom_string: "",
  access_token: "...",
  app_name: "..."
}
```

### 3. Rate Limiting & Retry Logic

```javascript
// Headers checked for rate limits:
X-RateLimit-Remaining: 47      // Requests remaining
X-RateLimit-Reset-By: ISO8601  // When quota resets

// Logic:
IF remaining < 7:
    WAIT until reset time
    Log warning

IF error.code === 3044:         // Rate limit error
    WAIT 10 minutes
    RETRY request

IF error.code === 2001:         // Token expired
    REFRESH token
    RETRY request
```

### 4. Error Handling

```javascript
// Error codes and handling:

3044        → Rate limited (wait 10 min)
2001        → Access token expired (refresh)
1001/1004   → Bad request (throw error)
Other       → Generic API error

// Special error messages handled:
"UserNameOrPasswordError"   → Invalid credentials
"UserIsLocked"             → Account locked
"accesstokenerror"         → Token issue
"too many failed attempts" → Rate limited
```

### 5. Device UUID Generation

Some endpoints (like locks) require UUID instead of MAC:

```javascript
// The getUuid function:
getUuid(deviceMac, deviceModel) {
  // Removes model prefix from MAC
  return deviceMac.replace(`${deviceModel}.`, "");
}

// Example:
Input:  mac="DX_LOCK.AABBCCDDEEFF", model="DX_LOCK"
Output: "AABBCCDDEEFF"
```

### 6. Local Encryption (Smart Bulbs)

For local network commands:

```javascript
// AES-128-CBC encryption with PKCS7 padding
wyzeEncrypt(deviceEnr, characteristicsString) {
    1. Pad text to 16-byte blocks with 0x05
    2. Create cipher with AES-128-CBC
    3. Use deviceEnr as both key and IV
    4. Encrypt and base64 encode
    5. Replace "/" with "\/" in base64
}

// Used for local bulb control
```

---

## Authentication & Security

### Credentials Required

To use wyze-api, you need:

1. **username** - Your Wyze account email
2. **password** - Your Wyze account password
3. **keyId** - Special API key (obtained from Wyze developer)
4. **apiKey** - Special API secret (obtained from Wyze developer)
5. **mfaCode** (optional) - If 2FA is enabled

### How to Get API Credentials

```
1. Go to: https://developer.wyze.com
2. Sign in with Wyze account
3. Create/find your application
4. Copy keyId and apiKey
```

### Password Hashing

Passwords are never sent in plaintext:

```javascript
createPassword(rawPassword) {
    md5_1 = MD5(rawPassword)
    md5_2 = MD5(md5_1)
    final = MD5(md5_2)
    return final  // 32-char hex string sent instead of password
}
```

### Token Security

- **Tokens are persisted** to disk for reuse across sessions
- **Tokens are masked** in logs (replaced with `*******`)
- **Token files** are named with MD5 hash of username for privacy
- **Tokens auto-expire** after ~60 hours (refresh available)

---

## API Communication Protocols

### Multi-Service Architecture

Wyze uses multiple backend services, each with different protocols:

```
┌────────────────────────────────────────────────────┐
│            Wyze Backend Infrastructure              │
├────────────────────────────────────────────────────┤
│                                                    │
│  ┌──────────────────┐  ┌────────────────────┐    │
│  │  Auth Service    │  │  Device API        │    │
│  │  auth-prod.api   │  │  api.wyzecam.com   │    │
│  │  (Standard HTTP) │  │  (Standard HTTP)   │    │
│  └──────────────────┘  └────────────────────┘    │
│                                                    │
│  ┌──────────────────┐  ┌────────────────────┐    │
│  │  Ford Service    │  │  Olive Service     │    │
│  │  yd-saas-toc     │  │  wyze-sirius-      │    │
│  │  (Signing)       │  │  service           │    │
│  │                  │  │  (HMAC-MD5)        │    │
│  └──────────────────┘  └────────────────────┘    │
│                                                    │
│  ┌──────────────────┐  ┌────────────────────┐    │
│  │  Venus Service   │  │  IoT3 Service      │    │
│  │  (Vacuums)       │  │  (Lock Bolt V2)    │    │
│  │  Venus Signing   │  │  Standard signing  │    │
│  └──────────────────┘  └────────────────────┘    │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Endpoint Examples

```javascript
// Standard API
POST https://api.wyzecam.com/app/v2/device/get_property_list

// Ford API (Locks)
GET https://yd-saas-toc.wyzecam.com/openapi/lock/v1/info
POST https://yd-saas-toc.wyzecam.com/openapi/lock/v1/control

// Olive API (Thermostat, Switch, Sprinkler)
GET https://wyze-sirius-service.wyzecam.com/plugin/sirius/get_iot_prop
POST https://wyze-platform-service.wyzecam.com/app/v2/platform/get_user_profile

// Venus API (Robot Vacuum)
GET https://wyze-venus-service-vn.wyzecam.com/plugin/venus/get_iot_prop
POST https://wyze-venus-service-vn.wyzecam.com/plugin/venus/{mac}/control

// IoT3 API (Lock Bolt V2)
POST https://app.wyzecam.com/api/v1/action
```

---

## Key Features Explained

### 1. Device Discovery & Status

```javascript
// Get all devices on account
const allDevices = await wyze.getDeviceList();

// Find by name (case-insensitive)
const device = await wyze.getDeviceByName('Living Room');

// Find by MAC address
const device = await wyze.getDeviceByMac('AABBCCDDEEFF');

// Filter by type (camera, light, etc.)
const cameras = await wyze.getDevicesByType('Camera');

// Filter by model
const colorBulbs = await wyze.getDevicesByModel('WLPA19C');

// Get device status/state
const status = await wyze.getDeviceStatus(device);
const state = await wyze.getDeviceState(device);
```

**Device Object Structure:**
```javascript
{
  device_id: "123456789",
  device_mac: "AABBCCDDEEFF",
  product_model: "WYZECAM3",
  product_type: "Camera",
  nickname: "Front Door",
  status: 1,                    // 1=online, 0=offline
  device_params: {
    status: "1",
    battery: "95",
    signal_strength: "-45",
    ...
  }
}
```

### 2. Camera Features

#### WebRTC Streaming
```javascript
// Get stream credentials (for live playback)
const streamInfo = await wyze.getCameraWebRTCConnectionInfo(mac, model);

// Returns:
{
  signalingUrl: "wss://...",   // WebSocket for signaling
  iceServers: [                 // STUN/TURN servers
    { urls: "stun:...", ... }
  ],
  authToken: "...",             // Authentication
  clientId: "viewer-...",       // Unique viewer ID
  cached: false
}
```

#### Snapshot Capture
```javascript
// Get snapshot from cloud
const snapshot = await wyze.getCameraSnapshotUrl(mac);
// Returns URL to thumbnail image

// Capture from live stream
const buffer = await wyze.cameraCaptureSnapshot(mac, model);
// Returns JPEG buffer (uses ffmpeg internally)

// Smart fallback
const result = await wyze.getCameraSnapshotImage(mac);
// Returns { buffer, source: "cloud" | "capture" }
```

#### Controls
```javascript
await wyze.cameraTurnOn(mac, model);
await wyze.cameraTurnOff(mac, model);
await wyze.cameraPrivacy(mac, model, 'privacy_on');
await wyze.cameraSirenOn(mac, model);
await wyze.cameraMotionOn(mac, model);
await wyze.cameraNotificationsOn(mac, model);
```

### 3. Robot Vacuum Control

```javascript
// Get comprehensive vacuum state
const info = await wyze.getVacuumInfo(mac);
// Merges: device list + IoT props + device info + status + maps

// Control operations
await wyze.vacuumClean(mac);              // Start cleaning
await wyze.vacuumPause(mac);              // Pause
await wyze.vacuumDock(mac);               // Return to dock
await wyze.vacuumStop(mac);               // Stop docking
await wyze.vacuumSweepRooms(mac, [1, 3]); // Clean specific rooms

// Suction levels: 1=Quiet, 2=Standard, 3=Strong
await wyze.vacuumSetSuctionLevel(mac, model, 2);

// Maps & positioning
const maps = await wyze.getVacuumMaps(mac);
const currentMap = await wyze.getVacuumCurrentMap(mac);
const position = await wyze.getVacuumCurrentPosition(mac);

// History
const records = await wyze.getVacuumSweepRecords(mac, { limit: 20 });
```

**Vacuum Status Codes:**
```javascript
VacuumStatus:
  1 = STANDBY
  2 = CLEANING
  3 = RETURNING_TO_CHARGE
  4 = DOCKED
  5 = MAPPING
  6 = PAUSED
  7 = ERROR
```

### 4. Smart Lock Management

#### Standard Locks (v1)
```javascript
// Get lock status
const info = await wyze.lockInfo(device);
// Returns lock state, battery, last access, etc.

// Control
await wyze.lockLock(device);
await wyze.unlockLock(device);
```

#### Lock Bolt V2 & Palm Lock
```javascript
// IoT3-based API (newer protocol)
const props = await wyze.lockBoltV2GetProperties(mac, model);
await wyze.lockBoltV2Lock(mac, model);
await wyze.lockBoltV2Unlock(mac, model);
```

### 5. Thermostat Control

```javascript
// Get thermostat properties
const props = await wyze.thermostatGetIotProp(mac);
// Returns: temperature, humidity, mode, heat/cool setpoints, etc.

// Set thermostat properties
await wyze.thermostatSetIotProp(mac, model, 'heat_sp', 72);  // Heat setpoint
await wyze.thermostatSetIotProp(mac, model, 'mode_sys', 1);  // 0=Off, 1=Heat, 2=Cool, 3=Auto

// Property keys:
'temperature'       // Current temp
'humidity'          // Current humidity
'heat_sp'           // Heat setpoint
'cool_sp'           // Cool setpoint
'mode_sys'          // System mode
'fan_mode'          // Fan mode (0=Auto, 1=On)
'temp_unit'         // Unit (0=C, 1=F)
```

### 6. Irrigation/Sprinkler System

```javascript
// Get zones
const zones = await wyze.irrigationGetZones(mac);
// Returns array of zone info (name, current state, etc.)

// Quick run single zone
await wyze.irrigationQuickRun(mac, 1, 10);  // Zone 1, 10 minutes

// Stop irrigation
await wyze.irrigationStop(mac);

// Get schedule information
const schedules = await wyze.irrigationGetScheduleRuns(mac);

// Device info
const info = await wyze.irrigationGetDeviceInfo(mac);
```

### 7. Smart Bulb Control

```javascript
// On/Off
await wyze.lightTurnOn(mac, model);
await wyze.lightTurnOff(mac, model);

// Brightness (1-100)
await wyze.setBrightness(mac, model, 75);

// Color temperature (2700-6500K)
await wyze.setColorTemperature(mac, model, 4000);

// Mesh devices (newer bulbs with mesh network)
await wyze.setMeshBrightness(mac, model, 80);
await wyze.setMeshHue(mac, model, 240);       // Hue (0-360)
await wyze.setMeshSaturation(mac, model, 100); // Saturation (0-100)
```

### 8. Home Monitoring System (HMS)

```javascript
// Get HMS ID
const hmsId = await wyze.getHmsID();

// Set state (disarm, home_away, away)
await wyze.setHMSState(hmsId, 'disarm');

// Get updates
const update = await wyze.getHmsUpdate(hmsId);

// Monitoring profiles
const status = await wyze.monitoringProfileStateStatus(hmsId);
await wyze.monitoringProfileActive(hmsId, true, false);  // Home=on, Away=off
```

---

## Advanced Concepts

### 1. Token Persistence

Tokens are automatically saved to avoid repeated login:

```javascript
// Default behavior:
// 1. First request → login() → receive tokens
// 2. Tokens saved to: ./wyze-{UUID}.json
// 3. Next run → tokens loaded from file
// 4. Tokens reused if still valid

// File contents:
{
  "access_token": "...",
  "refresh_token": "..."
}

// UUID = MD5 hash of username
// Example: wyze-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6.json
```

### 2. Debounce & Retry Logic

Prevents rapid repeated login attempts:

```javascript
// First attempt: login immediately
// Failed attempt: wait 1 second
// Still failing: wait 2 seconds
// Continue doubling: 1s → 2s → 4s → 8s... → max 5 minutes
// Reset: after 12 hours of no attempts

// This prevents:
// - API throttling
// - Account lockout
// - Excessive network traffic
```

### 3. Request Metadata Injection

Every request includes app emulation headers:

```javascript
// Standard headers added to every request:
{
  access_token: "...",         // Auth token
  app_name: "com.hualai.WyzeCam",  // Official app identifier
  app_ver: "wyze_developer_api",
  app_version: "wyze_developer_api",
  phone_id: "wyze_developer_api",   // Device identifier
  phone_system_type: "1",      // 1 = Android
  sc: "wyze_developer_api",    // Version control
  sv: "wyze_developer_api",    // Build version
  ts: 1234567890,              // Timestamp (current time)
  ...customData
}

// Purpose: Make library appear as official mobile app
// Reason: Wyze API authentication tied to app version
```

---

## Flow Diagrams

### Complete Login Flow

```
User Code
  │
  ├─ new Wyze(options)
  │
  ├─ await wyze.getDeviceList()  ← First API call
  │
  └──→ maybeLogin()
      │
      ├─ Check if access_token in memory? → YES: return
      │
      ├─ NO: Load from disk (./wyze-{UUID}.json)
      │     │
      │     ├─ File found? → YES: parse & return
      │     │
      │     └─ NO: Proceed to login
      │
      ├─ Check debounce timer
      │ (prevent rapid attempts)
      │
      ├─ Call login()
      │     │
      │     ├─ Hash password (3× MD5)
      │     │
      │     ├─ POST to auth-prod.api.wyze.com/api/user/login
      │     │  Headers: x-api-key, apikey, keyid
      │     │
      │     ├─ Response:
      │     │  {
      │     │    access_token: "...",
      │     │    refresh_token: "..."
      │     │  }
      │     │
      │     └─ Update tokens
      │
      ├─ Save to disk (./wyze-{UUID}.json)
      │
      └─ Return (token ready)

      Subsequent calls use cached token
      When token expires:
        → refreshToken() is called
        → Uses refresh_token to get new access_token
        → Retries original request
```

### Device Control Request Flow

```
User: await wyze.lightTurnOn(mac, model)
  │
  ├─ lightTurnOn()
  │     └─ calls runAction(mac, model, 'power_on')
  │
  ├─ runAction()
  │     │
  │     ├─ Build payload:
  │     │  {
  │     │    instance_id: mac,
  │     │    provider_key: model,
  │     │    action_key: 'power_on',
  │     │    action_params: {}
  │     │  }
  │     │
  │     └─ calls request('app/v2/auto/run_action', data)
  │
  ├─ request()
  │     │
  │     ├─ await maybeLogin()  ← Ensure auth
  │     │
  │     └─ _handleRequest()
  │
  ├─ _handleRequest()
  │     │
  │     ├─ _performRequest()
  │     │
  │     └─ If error with retryAfter: wait & retry
  │
  ├─ _performRequest()
  │     │
  │     ├─ Add metadata: access_token, ts, app_name, etc.
  │     │
  │     ├─ Prepare config:
  │     │  {
  │     │    method: 'POST',
  │     │    url: 'app/v2/auto/run_action',
  │     │    baseURL: 'https://api.wyzecam.com',
  │     │    data: {...}
  │     │  }
  │     │
  │     ├─ axios(config)  ← HTTP POST
  │     │
  │     └─ Check headers for rate limits
  │
  ├─ _handleApiResponse()
  │     │
  │     ├─ Check response.code === 1 (success)?
  │     │
  │     ├─ If code !== 1:
  │     │  ├─ 2001 = Token expired → refresh & retry
  │     │  ├─ 3044 = Rate limited → wait 10min & retry
  │     │  └─ Other → throw error
  │     │
  │     └─ Return { ok: true, data: ... }
  │
  └─ Return to user
     Light is now ON on Wyze server
```

---

## Summary

This library provides a **complete abstraction** over the Wyze ecosystem by:

1. **Handling Authentication** - Login, token refresh, persistence
2. **Managing Requests** - Adding metadata, signing, error handling
3. **Abstracting Complexity** - Simple methods hide cryptographic signing
4. **Supporting 50+ Devices** - Multiple API protocols unified
5. **Providing Conveniences** - Caching, retry logic, rate limiting

The key insight: **Wyze doesn't expose an official API**, so this library reverse-engineered the mobile app's API and emulates it, allowing developers to control Wyze devices from Node.js applications.

/**
 * HTTP + WebSocket server backing public/viewer.html — a browser viewer for
 * live Eufy camera feeds. Mirrors the Wyze cam-frontend dashboard, but Eufy
 * cameras don't speak WebRTC: eufy-security-client logs into the Eufy cloud,
 * opens a P2P session to the station, and emits the camera's raw H.264/H.265
 * video + AAC audio as Node Readable streams. We pipe those through FFmpeg to
 * an MPEG-TS stream and push it over a WebSocket; the browser plays it with
 * mpegts.js (MSE). H.265 is transcoded to H.264 so any browser can decode it.
 *
 * Run:    node server.js   (from the eufy/ directory)
 * Open:   http://localhost:3040
 *
 * First launch usually needs a captcha or 2FA code. The viewer page shows the
 * challenge and submits your answer — no terminal interaction. The session
 * token is cached in EUFY_PERSIST_DIR so later launches connect silently.
 *
 * Routes:
 *   GET  /                  — serves viewer.html
 *   GET  /api/auth/status   — { status, message, captcha?, connected }
 *   POST /api/auth/submit   — { code } -> answers the pending captcha/2FA
 *   GET  /api/cameras       — { cameras: [{ sn, name, model, online }] }
 *   GET  /api/events        — Server-Sent Events: detection notifications
 *   GET  /api/health        — { ok, connected }
 *   WS   /stream?sn=<SN>    — binary MPEG-TS stream for one camera
 */

const path = require("path");

// Single shared env at the repo root (../.env) drives both this viewer and the
// sibling Wyze dashboard — credentials live in one place.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const http = require("http");
const fs = require("fs");
const { URL } = require("url");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const {
  EufySecurity,
  VideoCodec,
  AudioCodec,
} = require("eufy-security-client");

// In v3 the library funnels all internal logs through InternalLogger.logger
// and defaults the level to Off, so login failures are silently swallowed.
// These aren't re-exported from the package root, so reach them by absolute
// path (the package's "exports" map blocks the subpath specifier).
const eufyLogging = require(path.join(
  path.dirname(require.resolve("eufy-security-client")),
  "logging.js"
));

const ffmpegPath = resolveFfmpegPath();
const port = Number(process.env.EUFY_VIEWER_PORT || 3040);
const viewerHtmlPath = path.join(__dirname, "public", "viewer.html");

const config = {
  username: process.env.EUFY_USERNAME,
  password: process.env.EUFY_PASSWORD,
  country: process.env.EUFY_COUNTRY || "US",
  language: process.env.EUFY_LANGUAGE || "en",
  persistentDir: path.resolve(process.env.EUFY_PERSIST_DIR || "./persist"),
  p2pConnectionSetup: Number(process.env.EUFY_P2P_SETUP ?? 0),
  pollingIntervalMinutes: 10,
  eventDurationSeconds: 10,
  // Auto-accept pending family/guest invitations so shared devices show up.
  acceptInvitations: process.env.EUFY_ACCEPT_INVITATIONS === "true",
};

// One live session per camera serial: the open WebSocket, the FFmpeg child,
// and the eufy Readable streams. Keyed by device SN.
const sessions = new Map();
let eufy = null;
let connected = false;

// Last-known JPEG per camera (event thumbnail from the Eufy cloud, plus any
// on-demand snapshots we capture). Persisted to disk so restarts don't lose
// the cached thumbnails. Keyed by device SN.
const snapshotCache = new Map(); // sn -> { buffer, ts }
const snapshotDir = path.resolve(
  process.env.EUFY_SNAPSHOT_DIR ||
    path.join(process.env.EUFY_PERSIST_DIR || path.join(__dirname, "persist"), "snapshots")
);
// On-demand snapshot requests waiting on a fresh livestream frame.
const pendingSnapshots = new Map(); // sn -> { resolve, reject, timer, ff?, args? }

// Per-camera auto-snapshot interval (minutes). 0 = disabled. The server runs a
// single setInterval per camera; multiple browser tabs sharing the dashboard
// don't cause duplicate wakes. Persisted to autosnap.json next to the snapshot
// cache so the schedule survives restarts.
const autoSnapMinutes = new Map(); // sn -> integer minutes (>= 1) or absent
const autoSnapTimers = new Map(); // sn -> NodeJS.Timeout
const ALLOWED_AUTOSNAP_MINUTES = [1, 5, 15, 30, 60];
const autoSnapConfigPath = path.join(
  path.dirname(
    path.resolve(
      process.env.EUFY_SNAPSHOT_DIR ||
        path.join(process.env.EUFY_PERSIST_DIR || path.join(__dirname, "persist"), "snapshots")
    )
  ),
  "autosnap.json"
);

// Open Server-Sent Events connections (the viewer subscribes to /api/events to
// be told when a detection fires, so it can auto-pop the live view).
const sseClients = new Set();
function broadcastEvent(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

function resolveFfmpegPath() {
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch (_) {
    /* fall through to PATH */
  }
  return "ffmpeg";
}

function log(...args) {
  console.log(`[eufy ${new Date().toISOString()}]`, ...args);
}

// --- Snapshot cache (last event thumbnail + on-demand snaps) ----------------

function snapshotPath(sn) {
  return path.join(snapshotDir, `${sn}.jpg`);
}

function loadSnapshotsFromDisk() {
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
    for (const file of fs.readdirSync(snapshotDir)) {
      const m = file.match(/^(.+)\.jpg$/);
      if (!m) continue;
      const buffer = fs.readFileSync(path.join(snapshotDir, file));
      const stat = fs.statSync(path.join(snapshotDir, file));
      snapshotCache.set(m[1], { buffer, ts: stat.mtimeMs });
    }
    log(`Loaded ${snapshotCache.size} cached snapshot(s) from ${snapshotDir}`);
  } catch (err) {
    log(`Snapshot cache load failed: ${err.message}`);
  }
}

function saveSnapshot(sn, buffer) {
  const ts = Date.now();
  snapshotCache.set(sn, { buffer, ts });
  fs.writeFile(snapshotPath(sn), buffer, (err) => {
    if (err) log(`Persist snapshot ${sn} failed: ${err.message}`);
  });
  broadcastEvent({ type: "snapshot", sn, ts });
  // The SDK refreshes battery state whenever a camera wakes (motion event,
  // on-demand refresh, or scheduled auto-snap). Push the latest value to all
  // viewers so each thumbnail update also carries a fresh battery reading.
  broadcastBattery(sn);
}

function broadcastBattery(sn) {
  if (!eufy) return;
  eufy.getDevice(sn)
    .then((device) => {
      if (!device || !device.isCamera?.()) return;
      const bat = deviceBatteryInfo(device);
      broadcastEvent({
        type: "battery",
        sn,
        battery: bat.level,
        batteryCharging: bat.charging,
      });
    })
    .catch(() => { /* device not loaded yet */ });
}

// --- Auto-snapshot scheduler ------------------------------------------------

function loadAutoSnapConfig() {
  try {
    if (!fs.existsSync(autoSnapConfigPath)) return;
    const raw = JSON.parse(fs.readFileSync(autoSnapConfigPath, "utf8"));
    for (const [sn, minutes] of Object.entries(raw || {})) {
      const m = Number(minutes);
      if (Number.isFinite(m) && m >= 1) autoSnapMinutes.set(sn, m);
    }
    log(`Loaded auto-snap schedule for ${autoSnapMinutes.size} camera(s).`);
  } catch (err) {
    log(`Auto-snap config load failed: ${err.message}`);
  }
}

function persistAutoSnapConfig() {
  const obj = Object.fromEntries(autoSnapMinutes.entries());
  fs.writeFile(autoSnapConfigPath, JSON.stringify(obj, null, 2), (err) => {
    if (err) log(`Persist auto-snap config failed: ${err.message}`);
  });
}

function clearAutoSnapTimer(sn) {
  const t = autoSnapTimers.get(sn);
  if (t) clearInterval(t);
  autoSnapTimers.delete(sn);
}

function scheduleAutoSnap(sn) {
  clearAutoSnapTimer(sn);
  const minutes = autoSnapMinutes.get(sn);
  if (!minutes) return;
  const intervalMs = minutes * 60 * 1000;
  const timer = setInterval(() => {
    // Skip when a viewer is already streaming this camera — the live frames
    // are fresher than any poll could be, and refreshSnapshot() would reject.
    if (sessions.has(sn)) return;
    refreshSnapshot(sn).catch((err) => {
      log(`Auto-snap ${sn} failed: ${err.message}`);
    });
  }, intervalMs);
  autoSnapTimers.set(sn, timer);
  log(`Auto-snap scheduled for ${sn} every ${minutes} min.`);
}

function setAutoSnap(sn, minutes) {
  if (minutes === 0 || minutes === null) {
    autoSnapMinutes.delete(sn);
    clearAutoSnapTimer(sn);
  } else {
    if (!ALLOWED_AUTOSNAP_MINUTES.includes(minutes)) {
      throw new Error(`Interval must be one of: ${ALLOWED_AUTOSNAP_MINUTES.join(", ")} (or 0 to disable)`);
    }
    autoSnapMinutes.set(sn, minutes);
    scheduleAutoSnap(sn);
  }
  persistAutoSnapConfig();
}

// Reactivate persisted schedules once the cloud session is up and devices are
// known. Called from the "connect" handler.
function startAllAutoSnapTimers() {
  for (const sn of autoSnapMinutes.keys()) scheduleAutoSnap(sn);
}

// --- Eufy cloud login (captcha / 2FA solved from the web UI) ---------------
//
// The Eufy cloud may challenge login with a captcha image or a 2FA code.
// Rather than prompting in the terminal, we expose the current challenge over
// HTTP (GET /api/auth/status) and accept the answer from the page
// (POST /api/auth/submit). The cloud can re-issue captchas repeatedly, each
// with a new id/image — we always keep and answer the most recent one.

const auth = {
  status: "connecting", // connecting | captcha | tfa | connected | error
  message: "Connecting to Eufy cloud…",
  captchaId: null,
  captchaImage: null, // data: URI for an <img> tag
};

let loginFailTimer = null;

// Eufy returns the captcha either as a full data URI or as bare base64.
function normalizeCaptcha(captcha) {
  const s = String(captcha || "");
  return s.startsWith("data:") ? s : `data:image/png;base64,${s}`;
}

// If, after a login attempt, the cloud neither connects nor issues a challenge
// within a few seconds, surface an error instead of spinning forever.
function armLoginFailTimer(ms = 5000) {
  clearTimeout(loginFailTimer);
  loginFailTimer = setTimeout(() => {
    if (!connected && auth.status === "connecting") {
      auth.status = "error";
      auth.message =
        "No response from Eufy cloud — login likely failed. Check " +
        "EUFY_USERNAME / EUFY_PASSWORD / EUFY_COUNTRY, then reload to retry.";
      log(auth.message);
    }
  }, ms);
}

// Submit a captcha or 2FA answer coming from the web UI.
async function submitAuthCode(code) {
  if (!code) return { ok: false, error: "Empty code" };
  if (auth.status === "captcha") {
    const id = auth.captchaId; // matches the image currently shown
    auth.status = "connecting";
    auth.message = "Checking captcha…";
    armLoginFailTimer();
    try {
      await eufy.connect({ captcha: { captchaId: id, captchaCode: code } });
      return { ok: true };
    } catch (err) {
      log(`Captcha submit failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
  if (auth.status === "tfa") {
    auth.status = "connecting";
    auth.message = "Checking 2FA code…";
    armLoginFailTimer();
    try {
      await eufy.connect({ verifyCode: code });
      return { ok: true };
    } catch (err) {
      log(`2FA submit failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: "No pending challenge" };
}

async function initEufy() {
  if (!config.username || !config.password) {
    throw new Error("Set EUFY_USERNAME and EUFY_PASSWORD in the repo-root .env");
  }
  fs.mkdirSync(config.persistentDir, { recursive: true });

  // Surface the library's own logs (login errors, P2P state, etc.). Default
  // level Off hides them; raise via EUFY_LOG_LEVEL (trace|debug|info|warn|error).
  const levelName = (process.env.EUFY_LOG_LEVEL || "info").toLowerCase();
  const level =
    eufyLogging.LogLevel[levelName[0].toUpperCase() + levelName.slice(1)] ??
    eufyLogging.LogLevel.Info;
  eufyLogging.InternalLogger.logger = {
    trace: (...a) => log("[lib trace]", ...a),
    debug: (...a) => log("[lib debug]", ...a),
    info: (...a) => log("[lib info]", ...a),
    warn: (...a) => log("[lib warn]", ...a),
    error: (...a) => log("[lib error]", ...a),
  };
  eufyLogging.setLoggingLevel("all", level);

  eufy = await EufySecurity.initialize(config);

  // The cloud asks for a 2FA code (email/SMS) — surface it to the web UI.
  eufy.on("tfa request", () => {
    clearTimeout(loginFailTimer);
    auth.status = "tfa";
    auth.message = "Enter the 2FA verification code sent to your email/SMS.";
    log("2FA required — enter the code on the viewer page.");
  });

  // The cloud asks for a captcha — `captcha` is a base64 image. Keep the latest
  // id + image for the web UI. The cloud may fire this repeatedly with a new
  // id/image; we always keep the most recent.
  eufy.on("captcha request", (id, captcha) => {
    clearTimeout(loginFailTimer);
    auth.status = "captcha";
    auth.message = "Enter the characters shown in the image.";
    auth.captchaId = id;
    auth.captchaImage = normalizeCaptcha(captcha);
    log("Captcha required — solve it on the viewer page.");
  });

  eufy.on("connect", () => {
    connected = true;
    clearTimeout(loginFailTimer);
    auth.status = "connected";
    auth.message = "Connected.";
    auth.captchaImage = null;
    log("Connected to Eufy cloud — loading devices…");
    // Restart any persisted auto-snap schedules now that cloud calls work.
    startAllAutoSnapTimers();
  });
  eufy.on("close", () => {
    connected = false;
    if (auth.status === "connected") {
      auth.status = "connecting";
      auth.message = "Reconnecting to Eufy cloud…";
    }
    log("Eufy cloud connection closed.");
  });
  eufy.on("device added", (device) => {
    log(`Device: ${device.getName()} (${device.getSerial()}) camera=${device.isCamera()}`);
    // The cloud may already have a cached last-event thumbnail for this device;
    // grab it once so the dashboard has something to show before any motion.
    try {
      const pic = device.getPropertyValue("picture");
      if (pic && pic.data && Buffer.isBuffer(pic.data) && pic.data.length > 0) {
        saveSnapshot(device.getSerial(), pic.data);
      }
    } catch (_) { /* property not populated yet */ }
  });

  // Cloud-delivered event thumbnail: the SDK downloads the JPEG, attaches it to
  // the device's "picture" property, and emits this event. Free of battery cost
  // — the camera already woke for the motion event that produced this image.
  // Also surface battery-level changes so the UI badge stays in sync.
  eufy.on("device property changed", (device, name, value) => {
    if (!device.isCamera()) return;
    if (name === "picture") {
      if (!value || !Buffer.isBuffer(value.data) || value.data.length === 0) return;
      saveSnapshot(device.getSerial(), value.data);
      return;
    }
    if (name === "battery" || name === "batteryIsCharging") {
      const bat = deviceBatteryInfo(device);
      broadcastEvent({
        type: "battery",
        sn: device.getSerial(),
        battery: bat.level,
        batteryCharging: bat.charging,
      });
    }
  });

  // Push-delivered detection. `state` is true on start, false on end — we only
  // act on the rising edge. The viewer auto-pops the matching camera's live
  // view for a few seconds. (Requires Person Detection enabled for the camera
  // in the Eufy app.)
  eufy.on("device person detected", (device, state) => {
    if (!state || !device.isCamera()) return;
    const sn = device.getSerial();
    log(`👤 Person detected on ${device.getName()} (${sn}) — notifying viewers`);
    broadcastEvent({ type: "person", sn, name: device.getName(), ts: Date.now() });
  });

  // A livestream we requested has started — route its streams to the matching
  // WebSocket session and start FFmpeg.
  eufy.on("station livestream start", (station, device, metadata, videostream, audiostream) => {
    const sn = device.getSerial();

    // On-demand snapshot path takes priority: grab one frame as JPEG, then stop
    // the livestream so the camera goes back to sleep. Battery-conscious wake.
    const pending = pendingSnapshots.get(sn);
    if (pending) {
      log(`Snapshot capture ${sn} codec=${codecName(metadata)} ${metadata.videoWidth}x${metadata.videoHeight}`);
      captureSnapshotFromStream(sn, metadata, videostream)
        .then((buffer) => {
          saveSnapshot(sn, buffer);
          pending.resolve(buffer);
        })
        .catch((err) => pending.reject(err))
        .finally(() => {
          clearTimeout(pending.timer);
          pendingSnapshots.delete(sn);
          eufy.stopStationLivestream(sn).catch(() => {});
        });
      return;
    }

    const session = sessions.get(sn);
    if (!session) {
      log(`Livestream started for ${sn} with no active viewer — stopping it.`);
      eufy.stopStationLivestream(sn).catch(() => {});
      return;
    }
    log(`Livestream start ${sn} codec=${codecName(metadata)} ${metadata.videoWidth}x${metadata.videoHeight}`);
    startFfmpeg(session, metadata, videostream, audiostream);
  });

  eufy.on("station livestream stop", (station, device) => {
    log(`Livestream stop ${device.getSerial()}`);
  });

  // Kick off login. connect() resolves once api.login() returns, which is
  // BEFORE the "connect" event fires (devices load then). Any captcha/2FA
  // challenge surfaces via the events above and is answered from the web UI.
  armLoginFailTimer();
  await eufy.connect();
  log("Login attempt sent. Open the viewer to solve any captcha/2FA challenge.");
}

function codecName(metadata) {
  return metadata.videoCodec === VideoCodec.H265 ? "H265" : "H264";
}

function deviceOnline(device) {
  // DeviceState property: 1 = online. Fall back to "online" if the cloud
  // hasn't populated state yet, so the UI still lets you try to stream.
  try {
    const state = device.getPropertyValue("state");
    if (typeof state === "number") return state === 1;
  } catch (_) {
    /* ignore */
  }
  return true;
}

function deviceBatteryInfo(device) {
  // Battery-powered models expose 0-100 on the "battery" property. Wired
  // models return undefined; we surface that as null so the UI hides the
  // badge instead of showing 0%.
  let level = null;
  let charging = false;
  try {
    const v = device.getPropertyValue("battery");
    if (typeof v === "number" && v >= 0 && v <= 100) level = v;
  } catch (_) { /* not present */ }
  try {
    const c = device.getPropertyValue("batteryIsCharging");
    if (typeof c === "boolean") charging = c;
  } catch (_) { /* not present */ }
  return { level, charging };
}

async function getCameras() {
  const devices = await eufy.getDevices();
  return devices
    .filter((d) => d.isCamera())
    .map((d) => {
      const bat = deviceBatteryInfo(d);
      return {
        sn: d.getSerial(),
        name: d.getName(),
        model: d.getModel(),
        online: deviceOnline(d),
        battery: bat.level,
        batteryCharging: bat.charging,
      };
    });
}

// --- FFmpeg: raw eufy streams -> MPEG-TS over the WebSocket -----------------

function buildFfmpegArgs(metadata, hasAudio) {
  const isH265 = metadata.videoCodec === VideoCodec.H265;
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-fflags", "+nobuffer+genpts",
    "-flags", "low_delay",
    // video elementary stream on stdin (fd 0)
    "-f", isH265 ? "hevc" : "h264",
    "-i", "pipe:0",
  ];
  if (hasAudio) {
    // audio elementary stream on fd 3
    args.push("-f", "aac", "-i", "pipe:3");
  }

  // mpegts.js (MSE) can't decode H.265 — transcode it; copy H.264 as-is.
  if (isH265) {
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p");
  } else {
    args.push("-c:v", "copy");
  }

  if (hasAudio) {
    args.push("-c:a", "aac", "-ar", "16000", "-ac", "1");
  }

  args.push("-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "pipe:1");
  return args;
}

function startFfmpeg(session, metadata, videostream, audiostream) {
  const hasAudio =
    !!audiostream && metadata.audioCodec !== undefined && metadata.audioCodec !== AudioCodec.NONE;

  const args = buildFfmpegArgs(metadata, hasAudio);
  const ff = spawn(ffmpegPath, args, {
    stdio: ["pipe", "pipe", "pipe", hasAudio ? "pipe" : "ignore"],
  });
  session.ffmpeg = ff;
  session.videostream = videostream;
  session.audiostream = hasAudio ? audiostream : null;

  videostream.on("error", () => {});
  videostream.pipe(ff.stdin);
  ff.stdin.on("error", () => {}); // ignore EPIPE when ffmpeg exits first
  if (hasAudio) {
    audiostream.on("error", () => {});
    audiostream.pipe(ff.stdio[3]);
    ff.stdio[3].on("error", () => {});
  }

  ff.stdout.on("data", (chunk) => {
    if (session.ws.readyState === session.ws.OPEN) session.ws.send(chunk);
  });
  ff.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) log(`ffmpeg[${session.sn}] ${msg}`);
  });
  ff.on("close", (code) => {
    log(`ffmpeg[${session.sn}] exited (${code})`);
  });
}

// --- On-demand snapshot: short livestream → one JPEG frame → stop ----------
//
// Wake the camera just long enough to grab a single frame. Pipes the raw video
// elementary stream into FFmpeg with `-frames:v 1 -f mjpeg pipe:1`, collects
// stdout, and resolves with the resulting JPEG buffer.
function captureSnapshotFromStream(sn, metadata, videostream) {
  return new Promise((resolve, reject) => {
    const isH265 = metadata.videoCodec === VideoCodec.H265;
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-fflags", "+nobuffer+genpts",
      "-f", isH265 ? "hevc" : "h264",
      "-i", "pipe:0",
      "-frames:v", "1",
      "-q:v", "4",
      "-f", "mjpeg",
      "pipe:1",
    ];
    const ff = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let settled = false;
    const finish = (err, buffer) => {
      if (settled) return;
      settled = true;
      try { videostream.unpipe?.(ff.stdin); } catch (_) {}
      try { ff.kill("SIGKILL"); } catch (_) {}
      if (err) return reject(err);
      if (!buffer || buffer.length === 0) return reject(new Error("Empty snapshot"));
      resolve(buffer);
    };
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (d) => {
      const msg = d.toString().trim();
      if (msg) log(`ffmpeg[snap ${sn}] ${msg}`);
    });
    ff.on("close", () => finish(null, Buffer.concat(chunks)));
    ff.on("error", (e) => finish(e));
    videostream.on("error", () => {});
    videostream.pipe(ff.stdin);
    ff.stdin.on("error", () => {});
    // Watchdog: ffmpeg should emit a frame within a few seconds of livestream
    // start. If not, give up so the camera doesn't stay awake on a stuck pipe.
    setTimeout(() => finish(new Error("Snapshot capture timed out")), 10000);
  });
}

async function refreshSnapshot(sn) {
  if (!connected) throw new Error("Not connected to Eufy cloud");
  if (sessions.has(sn)) {
    throw new Error("Live viewer active — stop it first, or the existing stream is your snapshot.");
  }
  const existing = pendingSnapshots.get(sn);
  if (existing) return existing.promise;

  let resolveOuter, rejectOuter;
  const promise = new Promise((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });
  const timer = setTimeout(() => {
    pendingSnapshots.delete(sn);
    eufy.stopStationLivestream(sn).catch(() => {});
    rejectOuter(new Error("Snapshot timed out waiting for livestream"));
  }, 15000);
  pendingSnapshots.set(sn, { resolve: resolveOuter, reject: rejectOuter, timer, promise });

  try {
    await eufy.startStationLivestream(sn);
  } catch (err) {
    clearTimeout(timer);
    pendingSnapshots.delete(sn);
    throw err;
  }
  return promise;
}

async function startSession(sn, ws) {
  // Replace any existing session for this camera (a second viewer takes over).
  await stopSession(sn);

  const session = { sn, ws, ffmpeg: null, videostream: null, audiostream: null };
  sessions.set(sn, session);

  try {
    await eufy.connect(); // no-op if already connected; ensures token is fresh
    await eufy.startStationLivestream(sn);
    log(`Requested livestream for ${sn}`);
  } catch (err) {
    log(`startStationLivestream(${sn}) failed: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message: err.message }));
      ws.close();
    }
    sessions.delete(sn);
  }
}

async function stopSession(sn) {
  const session = sessions.get(sn);
  if (!session) return;
  sessions.delete(sn);

  try { session.videostream?.unpipe?.(); } catch (_) {}
  try { session.audiostream?.unpipe?.(); } catch (_) {}
  try { session.ffmpeg?.kill("SIGKILL"); } catch (_) {}
  try { await eufy.stopStationLivestream(sn); } catch (_) {}
}

// --- HTTP + WebSocket server ------------------------------------------------

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && requestUrl.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(viewerHtmlPath, "utf8"));
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, connected });
      return;
    }

    // Server-Sent Events: pushes detection notifications to the viewer.
    if (req.method === "GET" && requestUrl.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      const heartbeat = setInterval(() => {
        try {
          res.write(": hb\n\n");
        } catch (_) {
          /* closed */
        }
      }, 25000);
      req.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/auth/status") {
      sendJson(res, 200, {
        status: auth.status,
        message: auth.message,
        connected,
        // Only send the image when a captcha is actually pending.
        captcha: auth.status === "captcha" ? auth.captchaImage : null,
      });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/auth/submit") {
      const body = await readJsonBody(req);
      const code = (body.code || "").trim();
      if (!code) {
        sendJson(res, 400, { error: "Missing code" });
        return;
      }
      const result = await submitAuthCode(code);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error, status: auth.status, message: auth.message });
        return;
      }
      // Give the cloud a beat to emit connect / a fresh challenge before we
      // report the resulting status back to the page.
      await new Promise((r) => setTimeout(r, 600));
      sendJson(res, 200, {
        status: auth.status,
        message: auth.message,
        connected,
        captcha: auth.status === "captcha" ? auth.captchaImage : null,
      });
      return;
    }

    // Dump everything the cloud returned — use this to see why a device isn't
    // showing up (wrong type, under a station we didn't load, etc.).
    if (req.method === "GET" && requestUrl.pathname === "/api/debug/devices") {
      if (!connected) {
        sendJson(res, 503, { error: "Not connected yet" });
        return;
      }
      const devices = await eufy.getDevices();
      const stations = await eufy.getStations();
      sendJson(res, 200, {
        deviceCount: devices.length,
        devices: devices.map((d) => ({
          sn: d.getSerial(),
          name: d.getName(),
          model: d.getModel(),
          type: d.getDeviceType(),
          isCamera: d.isCamera(),
          isDoorbell: d.isDoorbell(),
          stationSn: d.getStationSerial(),
        })),
        stationCount: stations.length,
        stations: stations.map((s) => ({
          sn: s.getSerial(),
          name: s.getName(),
          model: s.getModel(),
        })),
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/cameras") {
      // Until the cloud session is fully up, getDevices() would block forever
      // (it awaits the library's internal "devices loaded"). Return a clear
      // status instead so the UI can retry and the user can check the terminal.
      if (!connected) {
        sendJson(res, 503, {
          error:
            "Not connected to Eufy cloud yet. Check the server terminal — it may " +
            "be waiting for a 2FA/captcha code, or login failed.",
        });
        return;
      }
      const all = await getCameras();
      const wanted = (process.env.EUFY_CAMERA_SERIALS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const cameras = wanted.length
        ? wanted.map((sn) => all.find((c) => c.sn === sn)).filter(Boolean)
        : all.slice(0, 2);
      sendJson(res, 200, { cameras });
      return;
    }

    // Last cached JPEG for a camera (event thumbnail from the cloud, or a
    // previous on-demand snap). Returns 404 until at least one image exists.
    const snapMatch = requestUrl.pathname.match(/^\/api\/snapshot\/([^/]+)$/);
    if (req.method === "GET" && snapMatch) {
      const sn = decodeURIComponent(snapMatch[1]);
      const entry = snapshotCache.get(sn);
      if (!entry) {
        sendJson(res, 404, { error: "No snapshot yet" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": entry.buffer.length,
        "Cache-Control": "no-store",
        "X-Snapshot-Ts": String(entry.ts),
      });
      res.end(entry.buffer);
      return;
    }

    // Force a fresh snapshot: wakes the camera briefly, captures one frame,
    // stops the livestream. Returns the new JPEG (and broadcasts an SSE event
    // so other viewers refresh their cached image).
    const refreshMatch = requestUrl.pathname.match(/^\/api\/snapshot\/([^/]+)\/refresh$/);
    if (req.method === "POST" && refreshMatch) {
      const sn = decodeURIComponent(refreshMatch[1]);
      try {
        const buffer = await refreshSnapshot(sn);
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": buffer.length,
          "Cache-Control": "no-store",
          "X-Snapshot-Ts": String(snapshotCache.get(sn)?.ts ?? Date.now()),
        });
        res.end(buffer);
      } catch (err) {
        sendJson(res, 502, { error: err.message });
      }
      return;
    }

    // List the full auto-snapshot schedule. UI uses this on tile build to set
    // each dropdown to the persisted value.
    if (req.method === "GET" && requestUrl.pathname === "/api/autosnap") {
      sendJson(res, 200, {
        allowed: ALLOWED_AUTOSNAP_MINUTES,
        config: Object.fromEntries(autoSnapMinutes.entries()),
      });
      return;
    }

    // Per-camera schedule update: { minutes: 0 | 1 | 5 | 15 | 30 | 60 }.
    // minutes=0 disables polling for that camera.
    const autosnapMatch = requestUrl.pathname.match(/^\/api\/autosnap\/([^/]+)$/);
    if (req.method === "POST" && autosnapMatch) {
      const sn = decodeURIComponent(autosnapMatch[1]);
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      const minutes = Number(body.minutes);
      if (!Number.isFinite(minutes) || minutes < 0) {
        sendJson(res, 400, { error: "minutes must be a non-negative number" });
        return;
      }
      try {
        setAutoSnap(sn, minutes);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      sendJson(res, 200, {
        sn,
        minutes: autoSnapMinutes.get(sn) ?? 0,
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname !== "/stream") {
    socket.destroy();
    return;
  }
  const sn = requestUrl.searchParams.get("sn");
  if (!sn) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    log(`Viewer connected for ${sn}`);
    startSession(sn, ws);
    ws.on("close", () => {
      log(`Viewer disconnected for ${sn}`);
      stopSession(sn).catch(() => {});
    });
    ws.on("error", () => {});
  });
});

(async () => {
  try {
    loadSnapshotsFromDisk();
    loadAutoSnapConfig();
    await initEufy();
  } catch (err) {
    console.error("Failed to initialize Eufy:", err.message);
    process.exit(1);
  }
  server.listen(port, () => {
    log(`Eufy viewer running: http://localhost:${port}`);
  });
})();

process.on("SIGINT", async () => {
  log("Shutting down…");
  for (const sn of [...autoSnapTimers.keys()]) clearAutoSnapTimer(sn);
  for (const sn of [...sessions.keys()]) await stopSession(sn).catch(() => {});
  try { await eufy?.close(); } catch (_) {}
  process.exit(0);
});

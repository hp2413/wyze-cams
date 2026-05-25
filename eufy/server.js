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

require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
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
  p2pConnectionSetup: 0,
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
    throw new Error("Set EUFY_USERNAME and EUFY_PASSWORD in eufy/.env");
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

async function getCameras() {
  const devices = await eufy.getDevices();
  return devices
    .filter((d) => d.isCamera())
    .map((d) => ({
      sn: d.getSerial(),
      name: d.getName(),
      model: d.getModel(),
      online: deviceOnline(d),
    }));
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
  for (const sn of [...sessions.keys()]) await stopSession(sn).catch(() => {});
  try { await eufy?.close(); } catch (_) {}
  process.exit(0);
});

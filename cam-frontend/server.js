/**
 * HTTP server backing public/viewer.html — a browser-based Wyze camera
 * dashboard that uses WebRTC to play live streams and control devices.
 *
 * Run:    node server.js   (from the cam-frontend/ directory)
 * Open:   http://localhost:3030
 *
 * Routes:
 *   GET /                              — serves viewer.html
 *   GET /api/cameras                   — { cameras: [...summaries] }
 *   GET /api/stream-params?mac=&productModel=&substream=&clientId=
 *                                      — { params: { signalingUrl, iceServers, clientId? }, cached }
 *   GET /api/snapshot?mac=             — { available, snapshot? }
 *   GET /api/events?since=&mac=        — { events: [...] } recent motion/person events
 *   GET /api/thumbnail?url=            — proxies a thumbnail image (CORS workaround)
 *   POST /api/camera/control           — { mac, productModel, action } toggles
 *                                        floodlight/spotlight/siren/motion/recording/notifications/power
 *   GET /api/health                    — { ok: true }
 */

const path = require("path");

// Single shared env at the repo root (../.env) drives both this dashboard and
// the sibling Eufy viewer — credentials live in one place.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const http = require("http");
const fs = require("fs");
const { URL } = require("url");
const https = require("https");
const { WebSocketServer, WebSocket } = require("ws");

// The Eufy cameras are served by a separate process (eufy/server.js) that does
// the cloud login, P2P session, and FFmpeg transcode. We don't reimplement any
// of that here — we just proxy its HTTP API and video WebSocket through this
// origin so the dashboard shows Wyze and Eufy cameras together on one page
// without the browser needing a second origin or CORS. That process must be
// running (default http://localhost:3040).
const eufyBaseUrl = new URL(process.env.EUFY_BASE_URL || "http://localhost:3040");

// Use the local fork's source (../src) so the dashboard runs against this
// repo's fixes rather than a separately published package.
const WyzeAPI = require("../src/index");

const wyze = new WyzeAPI({
  username: process.env.USERNAME,
  password: process.env.PASSWORD,
  keyId: process.env.KEY_ID,
  apiKey: process.env.API_KEY,
  persistPath: process.env.PERSIST_PATH,
  logLevel: process.env.LOG_LEVEL,
  apiLogEnabled: process.env.API_LOG_ENABLED,
});

const port = Number(process.env.VIEWER_PORT || 3030);
const viewerHtmlPath = path.join(__dirname, "public", "viewer.html");

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
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
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Forward a request to the Eufy viewer process untouched and stream its
// response straight back. Works for JSON routes and the SSE event stream alike
// (we just pipe the upstream body). The request body, if any, is piped through
// — so this must run before any handler that consumes `req`.
function proxyToEufy(req, res, eufyPath) {
  const upstream = http.request(
    {
      hostname: eufyBaseUrl.hostname,
      port: eufyBaseUrl.port,
      path: eufyPath,
      method: req.method,
      headers: { ...req.headers, host: eufyBaseUrl.host },
    },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: `Eufy server unreachable at ${eufyBaseUrl.origin} — is eufy/server.js running? (${err.message})`,
      });
    } else {
      res.end();
    }
  });
  req.pipe(upstream);
}

// Maps a control action to the wyze-api method that performs it; each takes
// (mac, model). Cameras silently no-op on unsupported features (e.g. a
// floodlight call to a camera without one), so the client surfaces any thrown
// error in its per-camera log.
const CAMERA_ACTIONS = {
  floodlight_on: "cameraFloodLightOn",
  floodlight_off: "cameraFloodLightOff",
  siren_on: "cameraSirenOn",
  siren_off: "cameraSirenOff",
  motion_on: "cameraMotionOn",
  motion_off: "cameraMotionOff",
  recording_on: "cameraMotionRecordingOn",
  recording_off: "cameraMotionRecordingOff",
  notifications_on: "cameraNotificationsOn",
  notifications_off: "cameraNotificationsOff",
  power_on: "cameraTurnOn",
  power_off: "cameraTurnOff",
};

// The Wyze Cam v4 (HL_CAM4) spotlight can ONLY be toggled over the camera's
// live TUTK connection — every cloud method (set_property P1056, sirius,
// devicemgmt run_action) is a no-op. The dashboard disables the Spot button for
// these models; this guard returns a clear message if it's requested anyway.
const APP_ONLY_ACTIONS = new Set(["spotlight_on", "spotlight_off"]);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && requestUrl.pathname === "/") {
      sendHtml(res, fs.readFileSync(viewerHtmlPath, "utf8"));
      return;
    }

    // --- Eufy passthrough: proxied to eufy/server.js (see eufyBaseUrl) -------
    // Mirrors that server's routes under /api/eufy/* so the dashboard can talk
    // to a single origin. The /eufy-stream WebSocket is handled in the
    // "upgrade" listener below, not here.
    const EUFY_PROXY = {
      "GET /api/eufy/cameras": "/api/cameras",
      "GET /api/eufy/auth/status": "/api/auth/status",
      "POST /api/eufy/auth/submit": "/api/auth/submit",
      "GET /api/eufy/events": "/api/events",
    };
    const eufyTarget = EUFY_PROXY[`${req.method} ${requestUrl.pathname}`];
    if (eufyTarget) {
      proxyToEufy(req, res, eufyTarget);
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/cameras") {
      await wyze.maybeLogin();
      sendJson(res, 200, { cameras: await wyze.getCameraSummaries() });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/stream-params") {
      const mac = requestUrl.searchParams.get("mac");
      const productModel = requestUrl.searchParams.get("productModel");
      const substream = requestUrl.searchParams.get("substream") === "true";

      if (!mac || !productModel) {
        sendJson(res, 400, { error: "Missing mac or productModel" });
        return;
      }

      await wyze.maybeLogin();
      // Use the signed URL as-is — never inject a client ID, which would
      // invalidate the AWS SigV4 signature and trigger WebSocket close 1006.
      const params = await wyze.getCameraWebRTCConnectionInfo(mac, productModel, {
        substream,
        noCache: true,
      });
      sendJson(res, 200, { params, cached: params.cached });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/snapshot") {
      const mac = requestUrl.searchParams.get("mac");
      if (!mac) {
        sendJson(res, 400, { error: "Missing mac" });
        return;
      }
      await wyze.maybeLogin();
      try {
        const { buffer, source } = await wyze.getCameraSnapshotImage(mac);
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": buffer.length,
          "Cache-Control": "public, max-age=10",
          "X-Snapshot-Source": source,
        });
        res.end(buffer);
      } catch (error) {
        sendJson(res, 502, { error: `Snapshot failed: ${error.message}` });
      }
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/thumbnail") {
      const thumbUrl = requestUrl.searchParams.get("url");
      if (!thumbUrl) {
        sendJson(res, 400, { error: "Missing url" });
        return;
      }
      const client = thumbUrl.startsWith("https") ? https : http;
      client
        .get(thumbUrl, (upstream) => {
          res.writeHead(upstream.statusCode, {
            "Content-Type": upstream.headers["content-type"] || "image/jpeg",
            "Cache-Control": "public, max-age=60",
          });
          upstream.pipe(res);
        })
        .on("error", (err) => sendJson(res, 502, { error: err.message }));
      return;
    }

    // Recent camera events (motion/person/sound). The browser polls this to
    // raise notifications locally, since Wyze cloud push only reaches the phone
    // app. `since` (epoch ms) returns only events newer than that timestamp.
    if (req.method === "GET" && requestUrl.pathname === "/api/events") {
      await wyze.maybeLogin();
      const sinceParam = requestUrl.searchParams.get("since");
      const macParam = requestUrl.searchParams.get("mac");
      const since = sinceParam ? Number(sinceParam) : Date.now() - 60 * 60 * 1000;

      const events = await wyze.getEventList({
        beginTime: since,
        count: 50,
        deviceMacList: macParam ? [macParam] : [],
      });

      let names = {};
      try {
        const cams = await wyze.getCameras();
        names = Object.fromEntries(cams.map((c) => [c.mac, c.nickname]));
      } catch {
        /* names are best-effort; fall back to MAC */
      }

      const normalized = events
        .map((e) => {
          const files = e.file_list || [];
          const image = files.find((f) => f.type === 1) || files[0];
          const video = files.find((f) => f.type === 2);
          const tags = (e.tag_list || [])
            .map((t) => t.name || t.tag_id)
            .filter(Boolean);
          return {
            id: e.event_id,
            mac: e.device_mac,
            model: e.device_model,
            nickname: names[e.device_mac] || e.device_mac,
            time: Number(e.event_ts),
            value: String(e.event_value ?? ""),
            category: e.event_category,
            tags,
            thumbnail: image?.url || null,
            video: video?.url || null,
          };
        })
        .filter((e) => e.time > since)
        .sort((a, b) => b.time - a.time);

      sendJson(res, 200, { events: normalized });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Debug: dump the raw device list so you can confirm which fields exist
    // (e.g., conn_state vs device_params.status). Useful when cameraIsOnline
    // is wrong.
    if (req.method === "GET" && requestUrl.pathname === "/api/debug/devices") {
      await wyze.maybeLogin();
      const cameras = await wyze.getCameras();
      sendJson(res, 200, { count: cameras.length, cameras });
      return;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/camera/control") {
      const body = await readJsonBody(req);
      const { mac, productModel, action } = body;
      if (!mac || !productModel || !action) {
        sendJson(res, 400, { error: "Missing mac, productModel, or action" });
        return;
      }
      if (APP_ONLY_ACTIONS.has(action)) {
        sendJson(res, 501, {
          error:
            "Spotlight can't be controlled over the web on this camera — use the Wyze app. " +
            "The Wyze Cam v4 spotlight is only reachable over the camera's live connection.",
        });
        return;
      }

      const method = CAMERA_ACTIONS[action];
      if (!method) {
        sendJson(res, 400, { error: `Unknown action: ${action}` });
        return;
      }
      await wyze.maybeLogin();
      try {
        await wyze[method](mac, productModel);
        sendJson(res, 200, { ok: true, action });
      } catch (error) {
        sendJson(res, 502, { error: `${action} failed: ${error.message}` });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error.message,
      response: error.response?.data || null,
    });
  }
});

// Proxy the Eufy video WebSocket (/eufy-stream?sn=) to eufy/server.js's
// /stream endpoint, piping binary MPEG-TS frames both directions. The browser
// only ever connects here, so it stays on a single origin.
const eufyWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname !== "/eufy-stream") {
    socket.destroy();
    return;
  }
  const sn = requestUrl.searchParams.get("sn");
  if (!sn) {
    socket.destroy();
    return;
  }
  eufyWss.handleUpgrade(req, socket, head, (client) => {
    const target = `ws://${eufyBaseUrl.host}/stream?sn=${encodeURIComponent(sn)}`;
    const upstream = new WebSocket(target);
    upstream.binaryType = "nodebuffer";

    // Queue anything the browser sends before the upstream socket is open.
    const pending = [];
    upstream.on("open", () => {
      for (const msg of pending) upstream.send(msg);
      pending.length = 0;
    });
    upstream.on("message", (data) => {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });
    upstream.on("close", () => {
      try { client.close(); } catch (_) {}
    });
    upstream.on("error", () => {
      try { client.close(); } catch (_) {}
    });

    client.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      else pending.push(data);
    });
    client.on("close", () => {
      try { upstream.close(); } catch (_) {}
    });
    client.on("error", () => {
      try { upstream.close(); } catch (_) {}
    });
  });
});

server.listen(port, () => {
  console.log(`Wyze viewer running: http://localhost:${port}`);
  console.log(`Proxying Eufy cameras from ${eufyBaseUrl.origin}`);
});

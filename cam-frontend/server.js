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
 *   GET /api/thumbnail?url=            — proxies a thumbnail image (CORS workaround)
 *   POST /api/camera/control           — { mac, productModel, action } toggles
 *                                        floodlight/spotlight/siren/motion/recording/notifications/power
 *   GET /api/health                    — { ok: true }
 */

require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const https = require("https");

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

// Maps a control action to the wyze-api method that performs it; each takes
// (mac, model). Cameras silently no-op on unsupported features (e.g. a
// floodlight call to a camera without one), so the client surfaces any thrown
// error in its per-camera log.
const CAMERA_ACTIONS = {
  floodlight_on: "cameraFloodLightOn",
  floodlight_off: "cameraFloodLightOff",
  spotlight_on: "cameraSpotLightOn",
  spotlight_off: "cameraSpotLightOff",
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

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && requestUrl.pathname === "/") {
      sendHtml(res, fs.readFileSync(viewerHtmlPath, "utf8"));
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

server.listen(port, () => {
  console.log(`Wyze viewer running: http://localhost:${port}`);
});

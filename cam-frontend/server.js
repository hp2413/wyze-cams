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

// docker-wyze-bridge sidecar. Some controls (e.g. the Wyze Cam v4 / HL_CAM4
// spotlight) cannot be performed over the cloud API — the camera only accepts
// them over its live TUTK connection. The bridge maintains that connection and
// exposes a REST control API, so those actions are proxied to it.
const bridgeUrl = (process.env.BRIDGE_URL || "http://localhost:5000").replace(/\/+$/, "");
const bridgeApiKey = process.env.BRIDGE_API || "";
const bridgeUriSeparator = ["-", "_", "#"].includes(process.env.URI_SEPARATOR)
  ? process.env.URI_SEPARATOR
  : "-";

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

// Derive the bridge's camera URI from a nickname, matching docker-wyze-bridge's
// clean_name(): spaces -> separator, drop chars outside [-\w+], lowercased.
function bridgeCamName(nickname, mac) {
  return (nickname || mac || "")
    .trim()
    .replace(/ /g, bridgeUriSeparator)
    .replace(/[^-\w+]/g, "")
    .toLowerCase();
}

// GET {BRIDGE_URL}/api/{cam}/{command}/{payload}?api={key}
function bridgeControl(camName, command, payload) {
  return new Promise((resolve, reject) => {
    const query = bridgeApiKey ? `?api=${encodeURIComponent(bridgeApiKey)}` : "";
    const url = `${bridgeUrl}/api/${encodeURIComponent(camName)}/${command}/${payload}${query}`;
    const client = url.startsWith("https") ? https : http;
    const request = client.get(url, (upstream) => {
      let body = "";
      upstream.on("data", (chunk) => (body += chunk));
      upstream.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
          reject(new Error(`bridge HTTP ${upstream.statusCode}: ${String(body).slice(0, 200)}`));
        } else if (parsed && parsed.status === "error") {
          reject(new Error(parsed.response || "bridge reported error"));
        } else {
          resolve(parsed);
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(10_000, () => request.destroy(new Error("bridge request timed out")));
  });
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

// Actions the cloud API can't perform on newer cameras (e.g. the v4 spotlight,
// which silently no-ops on set_property P1056). These are sent over the camera's
// live connection via the docker-wyze-bridge sidecar instead.
const BRIDGE_ACTIONS = {
  spotlight_on: { command: "spotlight", payload: "on" },
  spotlight_off: { command: "spotlight", payload: "off" },
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
      const bridgeAction = BRIDGE_ACTIONS[action];
      if (bridgeAction) {
        await wyze.maybeLogin();
        const camera = await wyze.getCamera(mac);
        const camName = bridgeCamName(camera?.nickname, mac);
        try {
          const result = await bridgeControl(
            camName,
            bridgeAction.command,
            bridgeAction.payload
          );
          sendJson(res, 200, { ok: true, action, via: "bridge", camName, result });
        } catch (error) {
          sendJson(res, 502, { error: `${action} failed via bridge: ${error.message}` });
        }
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

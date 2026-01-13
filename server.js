/**
 * Universal Clipboard Sync – Secure Server (FINAL)
 *
 * - Preserves existing behavior
 * - Adds revocation, offline queue, image support, E2EE-safe relay
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

/* =====================================================
   STORES
===================================================== */

/**
 * users:
 * userId -> Map(deviceId -> device)
 */
const users = new Map();

/**
 * pairingTokens:
 * token -> { userId, expiresAt }
 */
const pairingTokens = new Map();

/**
 * revokedDevices:
 * userId -> Set(deviceId)
 */
const revokedDevices = new Map();

/**
 * offlineQueue:
 * userId -> Map(deviceId -> [CLIP_SYNC messages])
 */
const offlineQueue = new Map();

/* =====================================================
   HELPERS
===================================================== */

function generateCode(len = 6) {
  return Math.random()
    .toString(36)
    .slice(2, 2 + len)
    .toUpperCase();
}

function isRevoked(userId, deviceId) {
  return revokedDevices.get(userId)?.has(deviceId);
}

function enqueue(userId, deviceId, msg) {
  if (!offlineQueue.has(userId)) offlineQueue.set(userId, new Map());
  const userQ = offlineQueue.get(userId);
  if (!userQ.has(deviceId)) userQ.set(deviceId, []);
  userQ.get(deviceId).push(msg);
}

function flushQueue(userId, device) {
  const userQ = offlineQueue.get(userId);
  if (!userQ) return;

  const queue = userQ.get(device.deviceId);
  if (!queue || queue.length === 0) return;

  for (const msg of queue) {
    if (device.ws.readyState === WebSocket.OPEN) {
      device.ws.send(JSON.stringify(msg));
    }
  }

  userQ.delete(device.deviceId);
}

function broadcastDevices(userId) {
  const deviceMap = users.get(userId);
  if (!deviceMap) return;

  const devices = [...deviceMap.values()].map((d) => ({
    deviceId: d.deviceId,
    name: d.name,
    platform: d.platform,
    rules: d.rules,
    lastSeen: d.lastSeen,
    revoked: isRevoked(userId, d.deviceId),
  }));

  for (const d of deviceMap.values()) {
    if (d.ws.readyState === WebSocket.OPEN) {
      d.ws.send(
        JSON.stringify({
          type: "DEVICE_LIST",
          devices,
        })
      );
    }
  }
}

/* =====================================================
   PAIRING API
===================================================== */

app.post("/pair", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).end();

  const token = generateCode();
  pairingTokens.set(token, {
    userId,
    expiresAt: Date.now() + 120_000,
  });

  res.json({
    pairingToken: token,
    expiresIn: 120,
  });
});

/* Cleanup expired pairing tokens */
setInterval(() => {
  const now = Date.now();
  for (const [token, record] of pairingTokens.entries()) {
    if (record.expiresAt < now) pairingTokens.delete(token);
  }
}, 60_000);

/* =====================================================
   WEBSOCKET
===================================================== */

wss.on("connection", (ws) => {
  let device = null;

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /* -------------------------------------------------
       AUTH / AUTH_PAIR
    ------------------------------------------------- */

    if (data.type === "AUTH" || data.type === "AUTH_PAIR") {
      let userId = data.userId;

      if (data.type === "AUTH_PAIR") {
        const record = pairingTokens.get(data.pairingToken);
        if (!record || record.expiresAt < Date.now()) {
          ws.send(JSON.stringify({ type: "AUTH_FAIL" }));
          return;
        }
        pairingTokens.delete(data.pairingToken);
        userId = record.userId;
      }

      if (isRevoked(userId, data.deviceId)) {
        ws.send(JSON.stringify({ type: "DEVICE_REVOKED" }));
        ws.close();
        return;
      }

      device = {
        ws,
        userId,
        deviceId: data.deviceId,
        platform: data.platform,
        name: data.name,
        rules: {
          text: true,
          image: true,
        },
        lastSeen: Date.now(),
      };

      if (!users.has(userId)) users.set(userId, new Map());
      users.get(userId).set(device.deviceId, device);

      ws.send(JSON.stringify({ type: "AUTH_OK", userId }));
      broadcastDevices(userId);
      flushQueue(userId, device);
      return;
    }

    if (!device) return;

    device.lastSeen = Date.now();

    /* -------------------------------------------------
       DEVICE REVOCATION (ADDON)
    ------------------------------------------------- */

    if (data.type === "REVOKE_DEVICE") {
      const set = revokedDevices.get(device.userId) || new Set();
      set.add(data.deviceId);
      revokedDevices.set(device.userId, set);

      const target = users.get(device.userId)?.get(data.deviceId);
      if (target) target.ws.close();

      broadcastDevices(device.userId);
      return;
    }

    /* -------------------------------------------------
       UPDATE RULES (UNCHANGED)
    ------------------------------------------------- */

    if (data.type === "UPDATE_RULES") {
      if (typeof data.rules === "object") {
        device.rules = { ...device.rules, ...data.rules };
        broadcastDevices(device.userId);
      }
      return;
    }

    /* -------------------------------------------------
       CLIPBOARD UPDATE (E2EE SAFE)
    ------------------------------------------------- */

    if (data.type === "CLIP_UPDATE") {
      const peers = users.get(device.userId);
      if (!peers) return;

      for (const d of peers.values()) {
        if (d.deviceId === device.deviceId) continue;

        if (data.contentType === "text" && !d.rules.text) continue;
        if (data.contentType === "image" && !d.rules.image) continue;

        const msg = {
          type: "CLIP_SYNC",
          payload: data.payload, // 🔐 opaque encrypted blob
          contentType: data.contentType,
          timestamp: data.timestamp, // used for LWW (client-side)
          from: {
            deviceId: device.deviceId,
            name: device.name,
            platform: device.platform,
          },
        };

        if (d.ws.readyState === WebSocket.OPEN) {
          d.ws.send(JSON.stringify(msg));
        } else {
          enqueue(device.userId, d.deviceId, msg);
        }
      }
    }
  });

  ws.on("close", () => {
    if (!device) return;
    const map = users.get(device.userId);
    map?.delete(device.deviceId);
    broadcastDevices(device.userId);
  });
});

/* =====================================================
   START SERVER
===================================================== */

server.listen(8080, () => {
  console.log("✅ Universal Clipboard Secure Server running on :8080");
});

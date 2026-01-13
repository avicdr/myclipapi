/**
 * Universal Clipboard Sync – WebSocket Server (FINAL)
 *
 * - HTTPS + WSS compatible (Render / reverse proxy)
 * - Short-lived pairing tokens
 * - Multi-device presence per user
 * - Rule-based clipboard relay
 * - No cleartext assumptions
 *
 * NOTE:
 * - In-memory store (OK for now)
 * - Stateless clients
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

/* =====================================================
   Server (Render-compatible)
===================================================== */

const server = http.createServer(app);

/**
 * IMPORTANT:
 * Render terminates TLS at the proxy.
 * Node receives plain HTTP, but WebSocket upgrades still work.
 */
const wss = new WebSocket.Server({
  server,
  path: "/", // allow root upgrades
});

/* =====================================================
   In-memory Stores
===================================================== */

/**
 * users:
 * userId -> Map(deviceId -> device)
 */
const users = new Map();

/**
 * pairingTokens:
 * token -> { userId, type, expiresAt }
 */
const pairingTokens = new Map();

/* =====================================================
   Utilities
===================================================== */

function generateCode(length = 6) {
  return Math.random()
    .toString(36)
    .slice(2, 2 + length)
    .toUpperCase();
}

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, record] of pairingTokens.entries()) {
    if (record.expiresAt <= now) {
      pairingTokens.delete(token);
    }
  }
}

// cleanup every minute
setInterval(cleanupExpiredTokens, 60_000);

/**
 * Send device list to all devices of a user
 */
function broadcastDeviceList(userId) {
  const deviceMap = users.get(userId);
  if (!deviceMap) return;

  const devices = [...deviceMap.values()].map((d) => ({
    deviceId: d.deviceId,
    platform: d.platform,
    rules: d.rules,
    lastSeen: d.lastSeen,
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
   HTTP API – Pairing
===================================================== */

app.post("/pair", (req, res) => {
  const { userId, type } = req.body;

  if (!userId || !["qr", "code"].includes(type)) {
    return res.status(400).json({
      error: "userId and valid type (qr | code) required",
    });
  }

  const token = generateCode(6);

  pairingTokens.set(token, {
    userId,
    type,
    expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes
  });

  res.json({
    pairingToken: token,
    expiresIn: 120,
  });
});

/* =====================================================
   WebSocket Handling
===================================================== */

wss.on("connection", (ws) => {
  let device = null;

  ws.on("message", (raw) => {
    let data;

    try {
      data = JSON.parse(raw.toString());
    } catch {
      ws.send(
        JSON.stringify({
          type: "ERROR",
          message: "Invalid JSON",
        })
      );
      return;
    }

    /* ---------------- AUTH (trusted / host) ---------------- */

    if (data.type === "AUTH") {
      const { userId, deviceId, platform } = data;
      if (!userId || !deviceId) return;

      device = {
        ws,
        userId,
        deviceId,
        platform,
        rules: { text: true, image: false },
        lastSeen: Date.now(),
      };

      if (!users.has(userId)) {
        users.set(userId, new Map());
      }

      users.get(userId).set(deviceId, device);

      ws.send(JSON.stringify({ type: "AUTH_OK", userId }));
      broadcastDeviceList(userId);
      return;
    }

    /* ---------------- AUTH_PAIR (QR / code) ---------------- */

    if (data.type === "AUTH_PAIR") {
      const { pairingToken, deviceId, platform } = data;

      const record = pairingTokens.get(pairingToken);
      if (!record || record.expiresAt <= Date.now()) {
        ws.send(JSON.stringify({ type: "AUTH_FAIL" }));
        return;
      }

      pairingTokens.delete(pairingToken);

      device = {
        ws,
        userId: record.userId,
        deviceId,
        platform,
        rules: { text: true, image: false },
        lastSeen: Date.now(),
      };

      if (!users.has(record.userId)) {
        users.set(record.userId, new Map());
      }

      users.get(record.userId).set(deviceId, device);

      ws.send(
        JSON.stringify({
          type: "AUTH_OK",
          userId: record.userId,
        })
      );

      broadcastDeviceList(record.userId);
      return;
    }

    /* ---------------- Reject unauthenticated ---------------- */

    if (!device) {
      ws.send(
        JSON.stringify({
          type: "ERROR",
          message: "Not authenticated",
        })
      );
      return;
    }

    device.lastSeen = Date.now();

    /* ---------------- Update rules ---------------- */

    if (data.type === "UPDATE_RULES" && typeof data.rules === "object") {
      device.rules = { ...device.rules, ...data.rules };
      broadcastDeviceList(device.userId);
      return;
    }

    /* ---------------- Clipboard relay ---------------- */

    if (data.type === "CLIP_UPDATE") {
      const peers = users.get(device.userId);
      if (!peers) return;

      for (const d of peers.values()) {
        if (d.deviceId === device.deviceId) continue;
        if (d.ws.readyState !== WebSocket.OPEN) continue;

        if (data.contentType === "text" && !d.rules.text) continue;
        if (data.contentType === "image" && !d.rules.image) continue;

        d.ws.send(
          JSON.stringify({
            type: "CLIP_SYNC",
            from: device.deviceId,
            timestamp: data.timestamp,
            contentType: data.contentType,
            payload: data.payload,
          })
        );
      }
    }
  });

  ws.on("close", () => {
    if (!device) return;

    const deviceMap = users.get(device.userId);
    if (!deviceMap) return;

    deviceMap.delete(device.deviceId);

    if (deviceMap.size === 0) {
      users.delete(device.userId);
    } else {
      broadcastDeviceList(device.userId);
    }
  });
});

/* =====================================================
   Start Server (Render)
===================================================== */

const PORT = process.env.PORT || 8080;

server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Universal Clipboard Server running");
  console.log(`HTTP  https://abracadabra-0n55.onrender.com`);
  console.log(`WSS   wss://abracadabra-0n55.onrender.com`);
});

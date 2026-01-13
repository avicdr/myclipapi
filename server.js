/**
 * Universal Clipboard Sync – WebSocket Server
 *
 * Responsibilities:
 * - Maintain user ↔ device connections
 * - Issue short-lived pairing tokens (QR / code)
 * - Authenticate devices (AUTH / AUTH_PAIR)
 * - Maintain live device presence
 * - Enforce per-device sync rules
 * - Relay clipboard updates (content-type aware)
 *
 * IMPORTANT:
 * - Server does NOT know host vs client
 * - Server does NOT inspect clipboard payloads
 * - Server is a trusted relay + state manager only
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

/* =====================================================
   In-memory Stores
===================================================== */

/**
 * users:
 * userId -> Map(deviceId -> device)
 *
 * device = {
 *   ws,
 *   userId,
 *   deviceId,
 *   platform,
 *   rules,
 *   lastSeen
 * }
 */
const users = new Map();

/**
 * pairingTokens:
 * pairingToken -> {
 *   userId,
 *   type: "qr" | "code",
 *   expiresAt
 * }
 */
const pairingTokens = new Map();

/* =====================================================
   Utilities
===================================================== */

function generateCode(length = 6) {
  return Math.random()
    .toString(36)
    .substring(2, 2 + length)
    .toUpperCase();
}

function cleanupExpiredTokens() {
  const now = Date.now();
  for (const [token, record] of pairingTokens.entries()) {
    if (record.expiresAt < now) {
      pairingTokens.delete(token);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredTokens, 60 * 1000);

/**
 * Broadcast current device list to all devices of a user
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
    d.ws.send(
      JSON.stringify({
        type: "DEVICE_LIST",
        devices,
      })
    );
  }
}

/* =====================================================
   HTTP API – Pairing
===================================================== */

/**
 * POST /pair
 * Body:
 * {
 *   userId: string,
 *   type: "qr" | "code"
 * }
 */
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

    /* -----------------------------------------------
       AUTH – Direct (Host or pre-trusted device)
    ------------------------------------------------ */
    if (data.type === "AUTH") {
      const { userId, deviceId, platform } = data;
      if (!userId || !deviceId) return;

      device = {
        ws,
        userId,
        deviceId,
        platform,
        rules: {
          text: true,
          image: false,
        },
        lastSeen: Date.now(),
      };

      if (!users.has(userId)) {
        users.set(userId, new Map());
      }

      users.get(userId).set(deviceId, device);

      ws.send(
        JSON.stringify({
          type: "AUTH_OK",
          userId,
        })
      );

      broadcastDeviceList(userId);
      return;
    }

    /* -----------------------------------------------
       AUTH_PAIR – Paired client devices
    ------------------------------------------------ */
    if (data.type === "AUTH_PAIR") {
      const { pairingToken, deviceId, platform } = data;

      const record = pairingTokens.get(pairingToken);
      if (!record || record.expiresAt < Date.now()) {
        ws.send(JSON.stringify({ type: "AUTH_FAIL" }));
        return;
      }

      pairingTokens.delete(pairingToken);

      device = {
        ws,
        userId: record.userId,
        deviceId,
        platform,
        rules: {
          text: true,
          image: false,
        },
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

    /* -----------------------------------------------
       Reject unauthenticated actions
    ------------------------------------------------ */
    if (!device) {
      ws.send(
        JSON.stringify({
          type: "ERROR",
          message: "Not authenticated",
        })
      );
      return;
    }

    // Update heartbeat
    device.lastSeen = Date.now();

    /* -----------------------------------------------
       Update per-device sync rules
    ------------------------------------------------ */
    if (data.type === "UPDATE_RULES") {
      if (typeof data.rules === "object") {
        device.rules = {
          ...device.rules,
          ...data.rules,
        };
        broadcastDeviceList(device.userId);
      }
      return;
    }

    /* -----------------------------------------------
       Clipboard Update Relay
    ------------------------------------------------ */
    if (data.type === "CLIP_UPDATE") {
      const peers = users.get(device.userId);
      if (!peers) return;

      for (const d of peers.values()) {
        if (d.deviceId === device.deviceId) continue;

        // Enforce per-device rules
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
   Start Server
===================================================== */

server.listen(8080, "0.0.0.0", () => {
  console.log("✅ Universal Clipboard Server running");
  console.log("HTTP  http://0.0.0.0:8080");
  console.log("WS    ws://<your-local-ip>:8080");
});

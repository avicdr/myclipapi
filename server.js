/**
 * Universal Clipboard Sync – Secure Server (FINAL + FILE SUPPORT)
 *
 * - Preserves all existing behavior
 * - Adds file sharing (≤5MB, online-only)
 * - Images allowed to Android, files blocked
 * - No offline queue for files/images
 * - E2EE-safe relay only
 */

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

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
 * offlineQueue (TEXT ONLY):
 * userId -> Map(deviceId -> [CLIP_SYNC messages])
 */
const offlineQueue = new Map();

/* ================= NEW: FILE STORE ================= */

/**
 * fileStore:
 * fileId -> {
 *   buffer,
 *   userId,
 *   ownerDeviceId,
 *   size,
 *   mime,
 *   expiresAt
 * }
 */
const fileStore = new Map();

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const FILE_TTL_MS = 60_000;

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
        }),
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

/* ================= NEW: FILE DOWNLOAD ================= */

app.get("/file/:id", (req, res) => {
  const file = fileStore.get(req.params.id);
  if (!file || file.expiresAt < Date.now()) {
    return res.status(404).end();
  }

  res.setHeader("Content-Type", file.mime || "application/octet-stream");
  res.setHeader("Content-Length", file.size);
  res.send(file.buffer);

  fileStore.delete(req.params.id);
});

/* =====================================================
   WEBSOCKET
===================================================== */

wss.on("connection", (ws) => {
  let device = null;

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === "FILE_OFFER") {
      const peers = users.get(device.userId);
      for (const d of peers.values()) {
        if (d.deviceId === device.deviceId) continue;
        d.ws.send(
          JSON.stringify({
            type: "FILE_SYNC",
            ...data,
            from: device.deviceId,
          }),
        );
      }
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
          file: data.platform !== "android", // 🔥 NEW RULE
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
       DEVICE REVOCATION
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
       FILE OFFER (NEW, ONLINE ONLY)
    ------------------------------------------------- */

    if (data.type === "FILE_OFFER") {
      if (data.size > MAX_FILE_SIZE) return;

      const fileId = crypto.randomUUID();

      fileStore.set(fileId, {
        buffer: Buffer.from(data.payload, "base64"),
        userId: device.userId,
        ownerDeviceId: device.deviceId,
        size: data.size,
        mime: data.mime,
        expiresAt: Date.now() + FILE_TTL_MS,
      });

      const peers = users.get(device.userId);
      if (!peers) return;

      for (const d of peers.values()) {
        if (d.deviceId === device.deviceId) continue;
        if (!d.rules.file) continue; // ❌ Android blocked

        if (d.ws.readyState === WebSocket.OPEN) {
          d.ws.send(
            JSON.stringify({
              type: "FILE_OFFER",
              id: fileId,
              name: data.name,
              size: data.size,
              mime: data.mime,
              from: {
                deviceId: device.deviceId,
                name: device.name,
                platform: device.platform,
              },
            }),
          );
        }
      }
      return;
    }

    /* -------------------------------------------------
       CLIPBOARD UPDATE (UNCHANGED)
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
          payload: data.payload,
          contentType: data.contentType,
          timestamp: data.timestamp,
          from: {
            deviceId: device.deviceId,
            name: device.name,
            platform: device.platform,
          },
        };

        if (d.ws.readyState === WebSocket.OPEN) {
          d.ws.send(JSON.stringify(msg));
        } else if (data.contentType === "text") {
          enqueue(device.userId, d.deviceId, msg); // 🔐 text only
        }
      }
    }
  });

  ws.on("close", () => {
    if (!device) return;
    users.get(device.userId)?.delete(device.deviceId);
    broadcastDevices(device.userId);
  });
});

/* =====================================================
   START SERVER
===================================================== */

server.listen(8080, () => {
  console.log("✅ Universal Clipboard Secure Server running on :8080");
});

const { getRedis } = require("../infra/redis");
const QRCode = require("qrcode");

function isPlainObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

/**
 * Convert Baileys QR string to base64 image
 */
async function qrToBase64(qrString) {
  try {
    // Baileys QR format: "ref,publicKey,identityKey,advSecretKey"
    // We generate a QR image from the full string
    const dataUrl = await QRCode.toDataURL(qrString, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    return dataUrl;
  } catch (err) {
    console.error("QR conversion error:", err);
    return null;
  }
}

function badRequest() {
  const err = new Error("Invalid payload");
  err.statusCode = 400;
  return err;
}

async function storeWebhookEvent(payload) {
  if (!isPlainObject(payload)) throw badRequest();

  const sessionId = String(payload.sessionId || "").trim();
  const type = String(payload.type || "").trim();
  const timestamp = Number(payload.timestamp || Date.now());
  const data = isPlainObject(payload.data) ? payload.data : {};
  const meta = isPlainObject(payload.meta) ? payload.meta : {};

  if (!sessionId || !type) throw badRequest();

  const redis = getRedis();

  const event = {
    sessionId,
    type,
    timestamp,
    data,
    meta
  };

  // ✅ Auto-register session in active sessions set (workers self-register)
  await redis.sadd("sessions:active", sessionId);
  
  // Initialize or update session data hash
  const sessionKey = `session:${sessionId}`;
  const existingSession = await redis.hgetall(sessionKey);
  
  if (!existingSession || Object.keys(existingSession).length === 0) {
    // First event from this session - create it
    await redis.hset(sessionKey, {
      sessionId,
      phone: "pending",
      status: "WAITING_QR",
      createdAt: String(timestamp),
      fingerprint: meta.fingerprint || "",
      proxy: meta.proxy || ""
    });
    console.log(`[Webhook] New session registered: ${sessionId}`);
  }

  // Store "latest meta"
  await redis.hset(`session:meta:${sessionId}`, {
    fingerprint: meta.fingerprint ? String(meta.fingerprint) : "",
    proxy: meta.proxy ? String(meta.proxy) : ""
  });

  // Keep a capped event log (latest 200)
  const eventsKey = `session:events:${sessionId}`;
  await redis.lpush(eventsKey, JSON.stringify(event));
  await redis.ltrim(eventsKey, 0, 199);
  await redis.expire(eventsKey, 60 * 60 * 24); // 24h

  // Store latest QR as base64 image (short TTL)
  if (type === "QR_UPDATE" && typeof data.qrCode === "string" && data.qrCode.length > 0) {
    const qrKey = `session:qr:${sessionId}`;
    const qrImage = await qrToBase64(data.qrCode);
    if (qrImage) {
      await redis.set(qrKey, qrImage, "EX", 60 * 5); // 5 minutes
    }
    // Update session status to WAITING_QR
    await redis.hset(sessionKey, { status: "WAITING_QR" });
  }

  // Store latest status
  if (type === "CONNECTED") {
    await redis.hset(sessionKey, { 
      status: "CONNECTED",
      connectedAt: String(timestamp)
    });
    // Also store phone number if available
    if (data.phoneNumber) {
      await redis.hset(sessionKey, {
        phone: String(data.phoneNumber)
      });
      await redis.hset(`session:meta:${sessionId}`, {
        phoneNumber: String(data.phoneNumber),
        jid: data.jid ? String(data.jid) : ""
      });
    }
  } else if (type === "STATUS_CHANGE" && isPlainObject(data) && typeof data.status === "string") {
    await redis.hset(sessionKey, { status: data.status });
  } else if (type === "ERROR" || type === "DISCONNECTED") {
    await redis.hset(sessionKey, { status: "ERROR" });
  }

  // Update last ping timestamp
  if (type === "PING") {
    await redis.hset(sessionKey, { lastPing: String(timestamp) });
    await redis.hset(`session:meta:${sessionId}`, {
      lastPing: String(timestamp),
      uptime: data.uptime ? String(data.uptime) : ""
    });
  }

  console.log(`[Webhook] ${type} from session ${sessionId}`);

  return { sessionId, type };
}

/**
 * Get QR code for a session
 */
async function getSessionQR(sessionId) {
  const redis = getRedis();
  const qr = await redis.get(`session:qr:${sessionId}`);
  return qr;
}

/**
 * Get session status
 */
async function getSessionStatus(sessionId) {
  const redis = getRedis();
  const status = await redis.get(`session:status:${sessionId}`);
  const meta = await redis.hgetall(`session:meta:${sessionId}`);
  return { status, meta };
}

/**
 * Get session events (latest N)
 */
async function getSessionEvents(sessionId, limit = 50) {
  const redis = getRedis();
  const events = await redis.lrange(`session:events:${sessionId}`, 0, limit - 1);
  return events.map(e => JSON.parse(e));
}

module.exports = { 
  storeWebhookEvent,
  getSessionQR,
  getSessionStatus,
  getSessionEvents
};


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

  // Store "latest meta"
  // meta.proxy can be either the proxy URL or the egress IP; store as-is.
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
  }

  // Store latest status (best-effort)
  if (type === "CONNECTED") {
    await redis.set(`session:status:${sessionId}`, "CONNECTED", "EX", 60 * 60 * 24);
    // Also store phone number if available
    if (data.phoneNumber) {
      await redis.hset(`session:meta:${sessionId}`, {
        phoneNumber: String(data.phoneNumber),
        jid: data.jid ? String(data.jid) : ""
      });
    }
  } else if (type === "STATUS_CHANGE" && isPlainObject(data) && typeof data.status === "string") {
    await redis.set(`session:status:${sessionId}`, data.status, "EX", 60 * 60 * 24);
  }

  // Update last ping timestamp
  if (type === "PING") {
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


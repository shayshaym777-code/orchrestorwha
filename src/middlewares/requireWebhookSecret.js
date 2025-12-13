const { config } = require("../config");

function extractBearer(authHeader) {
  if (typeof authHeader !== "string") return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function requireWebhookSecret(req, res, next) {
  const expected = config.webhookSecret;

  if (!expected) {
    return res
      .status(500)
      .json({ status: "error", reason: "WEBHOOK_SECRET not configured" });
  }

  const byHeader = req.header("X-Webhook-Secret");
  const byBearer = extractBearer(req.header("Authorization"));
  const provided = byHeader || byBearer;

  if (!provided) {
    return res.status(401).json({ status: "error", reason: "Unauthorized" });
  }
  if (provided !== expected) {
    return res.status(401).json({ status: "error", reason: "Unauthorized" });
  }

  return next();
}

module.exports = { requireWebhookSecret };


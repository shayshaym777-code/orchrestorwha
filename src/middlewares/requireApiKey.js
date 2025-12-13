function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  const provided = req.header("X-API-KEY");

  // Spec: if missing -> 401
  if (!provided) {
    return res.status(401).json({ status: "error", reason: "Missing API key" });
  }

  // If you did not configure an expected key yet, treat as server misconfig.
  if (!expected) {
    return res
      .status(500)
      .json({ status: "error", reason: "Server API key not configured" });
  }

  if (provided !== expected) {
    return res.status(401).json({ status: "error", reason: "Invalid API key" });
  }

  return next();
}

module.exports = { requireApiKey };



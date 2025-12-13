const { config } = require("../config");

function baseUrl() {
  const url = config.sessionBrainUrl;
  if (!url) return null;
  return String(url).replace(/\/+$/, "");
}

async function safeFetch(url, opts) {
  // Node 18+/20 has global fetch in this repo runtime.
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.detail || data?.message || `SessionBrain HTTP ${res.status}`;
    const err = new Error(msg);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

async function sendEvent(event) {
  const b = baseUrl();
  if (!b) return { skipped: true, reason: "SESSION_BRAIN_URL not set" };
  try {
    return await safeFetch(`${b}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event)
    });
  } catch (e) {
    // swallow errors: brain is advisory
    return { skipped: true, reason: e.message || "sendEvent failed" };
  }
}

async function getBlocks() {
  const b = baseUrl();
  if (!b) return { skipped: true, active_blocks: {}, now_ms: Date.now() };
  return await safeFetch(`${b}/blocks`, { method: "GET" });
}

async function getDecisions(limit = 200) {
  const b = baseUrl();
  if (!b) return { skipped: true, decisions: [] };
  return await safeFetch(`${b}/decisions?limit=${encodeURIComponent(String(limit))}`, { method: "GET" });
}

async function analyze(payload) {
  const b = baseUrl();
  if (!b) return { skipped: true, reason: "SESSION_BRAIN_URL not set" };
  return await safeFetch(`${b}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
}

module.exports = {
  sendEvent,
  getBlocks,
  getDecisions,
  analyze
};





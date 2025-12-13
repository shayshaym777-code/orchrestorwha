const { config } = require("../config");
const { getRedis } = require("../infra/redis");

function requireGeminiKey() {
  const key = config.geminiApiKey;
  if (!key || String(key).trim() === "") {
    const err = new Error("GEMINI_API_KEY is not configured");
    err.statusCode = 400;
    throw err;
  }
  return String(key);
}

function buildPrompt({ statusData }) {
  // Keep it short & structured to reduce cost and keep deterministic outputs.
  // IMPORTANT: This is advisory only (no automatic actions).
  return [
    "You are an Anti-Ban Operations Advisor for a WhatsApp session farm.",
    "Return JSON only (no markdown), with keys: summary, risks[], recommendations[], perSession[].",
    "Each recommendation must include: action, target, reason, confidence (0-1).",
    "Allowed actions: SET_GLOBAL_RPM, SET_SESSION_RPM, DISABLE_SMART_GUARD, ENABLE_SMART_GUARD, PAUSE_SESSION, FLAG_PROXY_BAD, INVESTIGATE.",
    "Do not invent data; base your analysis strictly on the provided inputs.",
    "",
    "INPUT:",
    JSON.stringify(statusData).slice(0, 20000)
  ].join("\n");
}

async function callGemini({ prompt }) {
  const key = requireGeminiKey();
  const model = config.geminiModel || "gemini-1.5-flash";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 800
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      `Gemini error (HTTP ${res.status})`;
    const err = new Error(msg);
    err.statusCode = 502;
    throw err;
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return { model, rawText: text };
}

async function getAntiBanSnapshotForAi() {
  const redis = getRedis();

  const [incRaw, sgEnabled] = await Promise.all([
    redis.lrange("antiban:incidents", 0, 49),
    redis.get("config:smartguard:enabled")
  ]);

  const incidents = (incRaw || []).map((x) => {
    try {
      return JSON.parse(x);
    } catch {
      return { ts: Date.now(), raw: x };
    }
  });

  return {
    ts: Date.now(),
    smartGuardEnabled: sgEnabled === null ? null : sgEnabled === "true",
    incidents
  };
}

async function getAiAdvice({ statusData }) {
  const prompt = buildPrompt({ statusData });
  const { model, rawText } = await callGemini({ prompt });

  // Try parse JSON response; if not valid, return as text.
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }

  return { model, parsed, rawText };
}

module.exports = {
  getAntiBanSnapshotForAi,
  getAiAdvice
};



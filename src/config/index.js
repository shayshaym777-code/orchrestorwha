function requireEnv(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === null || String(v).trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(v);
}

const config = {
  port: Number(process.env.PORT || 3000),
  apiKey: process.env.API_KEY || null,

  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  dbPath: process.env.DB_PATH || "./data/orchestrator.sqlite",

  // Optional: external Dispatcher service base URL (for anti-ban dashboard aggregation)
  dispatcherUrl: process.env.DISPATCHER_URL || "http://localhost:4001",

  // Optional: AI Advisor (Gemini) - DO NOT commit real keys; set via env on server
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  geminiModel: process.env.GEMINI_MODEL || "gemini-1.5-flash",

  // Optional: Session Brain (Python) base URL
  sessionBrainUrl: process.env.SESSION_BRAIN_URL || null,
  sessionBrainEnforcerEnabled: (process.env.SESSION_BRAIN_ENFORCER_ENABLED || "false") === "true",
  sessionBrainEnforcerIntervalMs: Number(process.env.SESSION_BRAIN_ENFORCER_INTERVAL_MS || 15000),

  // Webhook authentication (Worker -> Orchestrator)
  webhookSecret: process.env.WEBHOOK_SECRET || null,

  // Inventory alert thresholds
  profilesLowThreshold: Number(process.env.PROFILES_LOW_THRESHOLD || 5),
  proxiesLowThreshold: Number(process.env.PROXIES_LOW_THRESHOLD || 3),

  // Allocation rules
  maxSessionsPerProxy: Number(process.env.MAX_SESSIONS_PER_PROXY || 4),
  maxSessionsPerPhone: Number(process.env.MAX_SESSIONS_PER_PHONE || 4),

  // Runner timings
  provisioningIntervalMs: Number(process.env.PROVISIONING_INTERVAL_MS || 2000),
  monitorIntervalMs: Number(process.env.MONITOR_INTERVAL_MS || 30000),

  // Watchdog timings
  watchdogIntervalMs: Number(process.env.WATCHDOG_INTERVAL_MS || 60000),
  pingTimeoutMs: Number(process.env.PING_TIMEOUT_MS || 180000)
};

module.exports = { config, requireEnv };



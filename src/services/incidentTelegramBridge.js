const { getRedis } = require("../infra/redis");
const { alertIncident } = require("./telegramAlertService");

const ENABLED = (process.env.TELEGRAM_INCIDENT_ALERTS_ENABLED || "false") === "true";
const POLL_MS = Math.max(1000, Number(process.env.TELEGRAM_INCIDENT_POLL_INTERVAL_MS || 5000));
const STATE_KEY = "telegram:incidents:lastSeenTs";

let interval = null;
let running = false;
let lastError = null;
let lastTick = null;
let lastSeenTs = 0;

async function loadState() {
  try {
    const redis = getRedis();
    lastSeenTs = Number((await redis.get(STATE_KEY)) || 0);
  } catch {
    // ignore
  }
}

async function saveState() {
  try {
    const redis = getRedis();
    await redis.set(STATE_KEY, String(lastSeenTs));
  } catch {
    // ignore
  }
}

async function tick() {
  if (!ENABLED) return;
  if (running) return;
  running = true;
  lastTick = Date.now();
  lastError = null;

  try {
    const redis = getRedis();
    const raw = await redis.lrange("antiban:incidents", 0, 100);
    const inc = (raw || [])
      .map((x) => {
        try {
          return JSON.parse(x);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const sorted = inc
      .filter((i) => Number(i.ts || 0) > lastSeenTs)
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

    for (const i of sorted) {
      await alertIncident(i);
      lastSeenTs = Math.max(lastSeenTs, Number(i.ts || 0));
    }

    if (sorted.length > 0) await saveState();
  } catch (err) {
    lastError = err?.message || String(err);
  } finally {
    running = false;
  }
}

function start() {
  if (!ENABLED) return;
  if (interval) return;
  loadState().finally(() => {
    tick();
    interval = setInterval(tick, POLL_MS);
  });
}

function stop() {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
}

function getStatus() {
  return {
    enabled: ENABLED,
    active: interval !== null,
    pollMs: POLL_MS,
    running,
    lastTick,
    lastSeenTs,
    lastError
  };
}

module.exports = {
  start,
  stop,
  tick,
  getStatus
};



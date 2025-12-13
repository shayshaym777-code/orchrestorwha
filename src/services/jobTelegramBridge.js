const { getRedis } = require("../infra/redis");
const { sendTelegramAlert } = require("./telegramAlertService");

const ENABLED = (process.env.TELEGRAM_JOB_ALERTS_ENABLED || "false") === "true";
const POLL_MS = Math.max(1000, Number(process.env.TELEGRAM_JOB_POLL_INTERVAL_MS || 5000));
const STATE_KEY = "telegram:jobs:lastSeenTs";

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

function shortId(id) {
  const s = String(id || "");
  if (s.length <= 10) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

async function tick() {
  if (!ENABLED) return;
  if (running) return;
  running = true;
  lastTick = Date.now();
  lastError = null;

  try {
    const redis = getRedis();
    const raw = await redis.lrange("jobs:events", 0, 200);
    const events = (raw || [])
      .map((x) => {
        try {
          return JSON.parse(x);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const sorted = events
      .filter((e) => Number(e.ts || 0) > lastSeenTs)
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

    for (const e of sorted) {
      const type = String(e.type || "");
      const jobId = String(e.jobId || "");
      if (!jobId) continue;

      if (type === "JOB_ACCEPTED") {
        await sendTelegramAlert(
          "info",
          `📥 נכנס Job ${shortId(jobId)}`,
          `Job נכנס למערכת.`,
          { jobId, received: e.received ?? "", mode: e.mode ?? "", hasImage: e.hasImage ?? "" },
          { silent: true }
        );
      }

      if (type === "JOB_DONE") {
        const failed = Number(e.failed || 0);
        const sent = Number(e.sent || 0);
        const total = Number(e.total || 0);
        const status = String(e.status || "");
        await sendTelegramAlert(
          failed > 0 ? "warning" : "success",
          `✅ Job הסתיים ${shortId(jobId)}`,
          `סטטוס: ${status}\nנשלחו: ${sent}/${total}\nנכשלו: ${failed}`,
          { jobId, status, sent, failed, total },
          { silent: failed === 0 }
        );
      }

      lastSeenTs = Math.max(lastSeenTs, Number(e.ts || 0));
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
    lastError,
    lastSeenTs
  };
}

module.exports = {
  start,
  stop,
  tick,
  getStatus
};



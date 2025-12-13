const { getRedis } = require("../infra/redis");

const INCIDENTS_KEY = "antiban:incidents";

async function pushIncident(incident) {
  const redis = getRedis();
  const payload = JSON.stringify({
    ts: Date.now(),
    ...incident
  });
  await redis.lpush(INCIDENTS_KEY, payload);
  await redis.ltrim(INCIDENTS_KEY, 0, 499); // keep last 500
  await redis.expire(INCIDENTS_KEY, 14 * 24 * 3600); // 14 days
}

async function listIncidents(limit = 100) {
  const redis = getRedis();
  const raw = await redis.lrange(INCIDENTS_KEY, 0, Math.max(0, limit - 1));
  return (raw || []).map((x) => {
    try {
      return JSON.parse(x);
    } catch {
      return { ts: Date.now(), raw: x };
    }
  });
}

module.exports = {
  INCIDENTS_KEY,
  pushIncident,
  listIncidents
};



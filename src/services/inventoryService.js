const { getRedis } = require("../infra/redis");

// Redis key conventions
const KEYS = {
  profilesAvailable: "profiles:available", // set of profile IDs/lines
  profilesUsed: "profiles:used", // set
  proxiesAvailable: "proxies:available", // set of proxy strings
  proxiesAll: "proxies:all", // set
  proxiesBad: "proxies:bad" // set
};

function parseLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

async function addProfilesFromText(text) {
  const redis = getRedis();
  const lines = parseLines(text);
  if (lines.length === 0) return { added: 0 };

  // Keep it simple: treat each line as a unique profile payload (or ID).
  // If you need structured fields (UA/cookies/fingerprint), store JSON per line and parse downstream.
  const pipeline = redis.pipeline();
  for (const line of lines) {
    pipeline.sadd(KEYS.profilesAvailable, line);
  }
  await pipeline.exec();

  return { added: lines.length };
}

async function addProxiesFromText(text) {
  const redis = getRedis();
  const lines = parseLines(text);
  if (lines.length === 0) return { added: 0 };

  // Proxy format is user-defined (ip:port or user:pass@ip:port, etc.)
  const pipeline = redis.pipeline();
  for (const line of lines) {
    pipeline.sadd(KEYS.proxiesAll, line);
    pipeline.sadd(KEYS.proxiesAvailable, line);
  }
  await pipeline.exec();

  return { added: lines.length };
}

async function markProxyBad(proxy) {
  const redis = getRedis();
  await redis.sadd(KEYS.proxiesBad, proxy);
  await redis.srem(KEYS.proxiesAvailable, proxy);
}

async function getInventoryStatus() {
  const redis = getRedis();
  const [profilesAvailable, profilesUsed, proxiesAvailable, proxiesAll, proxiesBad] =
    await Promise.all([
      redis.scard(KEYS.profilesAvailable),
      redis.scard(KEYS.profilesUsed),
      redis.scard(KEYS.proxiesAvailable),
      redis.scard(KEYS.proxiesAll),
      redis.scard(KEYS.proxiesBad)
    ]);

  return {
    profiles: { available: profilesAvailable, used: profilesUsed },
    proxies: {
      available: proxiesAvailable,
      total: proxiesAll,
      bad: proxiesBad
    }
  };
}

module.exports = {
  KEYS,
  addProfilesFromText,
  addProxiesFromText,
  markProxyBad,
  getInventoryStatus
};



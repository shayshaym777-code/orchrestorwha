const { config } = require("../config");
const { getRedis } = require("../infra/redis");
const { KEYS } = require("./inventoryService");

const ALLOC_KEYS = {
  phoneStickyProxy: "phone:sticky_proxy", // hash phone -> proxy
  proxyActiveCount: "proxy:active_count", // hash proxy -> int
  phoneActiveCount: "phone:active_count", // hash phone -> int
  activeSessions: "sessions:active" // set of session ids (optional)
};

function allocError(message, statusCode = 409) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function canAllocatePhone(redis, phone) {
  const count = Number((await redis.hget(ALLOC_KEYS.phoneActiveCount, phone)) || 0);
  return count < config.maxSessionsPerPhone;
}

async function canAllocateProxy(redis, proxy) {
  const count = Number((await redis.hget(ALLOC_KEYS.proxyActiveCount, proxy)) || 0);
  return count < config.maxSessionsPerProxy;
}

async function pickProxyForPhone(redis, phone) {
  const sticky = await redis.hget(ALLOC_KEYS.phoneStickyProxy, phone);
  if (sticky) {
    const isAvailable = await redis.sismember(KEYS.proxiesAvailable, sticky);
    const ok = isAvailable && (await canAllocateProxy(redis, sticky));
    if (ok) return sticky;
  }

  // Simple selection: scan available proxies until we find one under the limit.
  // For scale, replace with a sorted-set / token bucket model.
  const candidates = await redis.smembers(KEYS.proxiesAvailable);
  for (const proxy of candidates) {
    if (await canAllocateProxy(redis, proxy)) return proxy;
  }
  return null;
}

async function reserveResources({ phone }) {
  const redis = getRedis();

  if (!(await canAllocatePhone(redis, phone))) {
    throw allocError("Phone session limit reached");
  }

  const proxy = await pickProxyForPhone(redis, phone);
  if (!proxy) throw allocError("No available proxy");

  // Reserve counts (best-effort). For strict atomicity, replace with a Lua script.
  // Increment phone/proxy counters.
  await redis.hincrby(ALLOC_KEYS.phoneActiveCount, phone, 1);
  const proxyCount = await redis.hincrby(ALLOC_KEYS.proxyActiveCount, proxy, 1);

  // Mark proxy BUSY if reached limit.
  if (Number(proxyCount) >= config.maxSessionsPerProxy) {
    await redis.srem(KEYS.proxiesAvailable, proxy);
  }

  // Sticky bind for future allocations.
  await redis.hset(ALLOC_KEYS.phoneStickyProxy, phone, proxy);

  return { proxy };
}

async function releaseResources({ phone, proxy }) {
  const redis = getRedis();
  if (phone) {
    const phoneCount = await redis.hincrby(ALLOC_KEYS.phoneActiveCount, phone, -1);
    if (Number(phoneCount) <= 0) await redis.hdel(ALLOC_KEYS.phoneActiveCount, phone);
  }

  if (proxy) {
    const proxyCount = await redis.hincrby(ALLOC_KEYS.proxyActiveCount, proxy, -1);
    if (Number(proxyCount) <= 0) await redis.hdel(ALLOC_KEYS.proxyActiveCount, proxy);

    // Re-add to availability if below limit and not BAD.
    const isBad = await redis.sismember(KEYS.proxiesBad, proxy);
    if (!isBad && Number(proxyCount) < config.maxSessionsPerProxy) {
      await redis.sadd(KEYS.proxiesAvailable, proxy);
    }
  }
}

module.exports = {
  ALLOC_KEYS,
  reserveResources,
  releaseResources
};



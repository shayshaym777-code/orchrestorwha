const Redis = require("ioredis");

const { config } = require("../config");

let redisClient = null;

function getRedis() {
  if (redisClient) return redisClient;
  redisClient = new Redis(config.redisUrl, {
    // Prefer IPv4 on Windows to avoid odd IPv6/WSL/Docker resolution issues.
    family: 4,
    enableReadyCheck: true,
    // Keep the default offline queue ON to avoid "Stream isn't writeable" race on startup.
    // We still fail fast on bad connections via maxRetriesPerRequest/connectTimeout.
    enableOfflineQueue: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1
  });
  return redisClient;
}

async function closeRedis() {
  if (!redisClient) return;
  await redisClient.quit();
  redisClient = null;
}

module.exports = { getRedis, closeRedis };



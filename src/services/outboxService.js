const { getRedis, getRedisBlocking } = require("../infra/redis");

function outboxKey(sessionId) {
  return `session:outbox:${sessionId}`;
}

function processingKey(sessionId) {
  return `session:outbox:processing:${sessionId}`;
}

/**
 * Enqueue a command/task for a worker session.
 * Stored as a JSON string in Redis List.
 */
async function enqueueOutbox(sessionId, task, { ttlSeconds = 3600 } = {}) {
  const redis = getRedis();
  const payload = {
    ...task,
    sessionId,
    queuedAt: Date.now()
  };

  const raw = JSON.stringify(payload);
  await redis.lpush(outboxKey(sessionId), raw);
  await redis.expire(outboxKey(sessionId), ttlSeconds);
  return payload;
}

/**
 * Claim next task for a session using BRPOPLPUSH:
 * atomically moves the item from outbox -> processing list.
 *
 * Returns { raw, task } or null if timeout.
 */
async function claimOutbox(sessionId, { timeoutSeconds = 20, processingTtlSeconds = 3600 } = {}) {
  const redisBlocking = getRedisBlocking();
  const raw = await redisBlocking.brpoplpush(outboxKey(sessionId), processingKey(sessionId), timeoutSeconds);
  if (!raw) return null;

  // Keep processing list bounded in time; if worker dies, watchdog can requeue.
  const redis = getRedis();
  await redis.expire(processingKey(sessionId), processingTtlSeconds);

  let task = null;
  try {
    task = JSON.parse(raw);
  } catch {
    task = { sessionId, raw };
  }

  return { raw, task };
}

/**
 * Acknowledge a claimed item by removing it from processing list.
 * The worker must send back the exact raw string it received.
 */
async function ackOutbox(sessionId, raw) {
  const redis = getRedis();
  const removed = await redis.lrem(processingKey(sessionId), 1, raw);
  return removed;
}

/**
 * Negative-ack: remove from processing and requeue to outbox.
 */
async function nackOutbox(sessionId, raw) {
  const redis = getRedis();
  await redis.lrem(processingKey(sessionId), 1, raw);
  await redis.lpush(outboxKey(sessionId), raw);
  return true;
}

async function getOutboxLengths(sessionId) {
  const redis = getRedis();
  const [q, p] = await Promise.all([
    redis.llen(outboxKey(sessionId)),
    redis.llen(processingKey(sessionId))
  ]);
  return { queued: q, processing: p };
}

module.exports = {
  enqueueOutbox,
  claimOutbox,
  ackOutbox,
  nackOutbox,
  getOutboxLengths
};



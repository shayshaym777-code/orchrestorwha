/**
 * Session Grading Service - Smart Warming System
 * 
 * Classifies sessions by trust level and enforces sending limits
 * to prevent WhatsApp bans through gradual ramp-up
 */

const { getRedis } = require("../infra/redis");

// Trust Levels
const TRUST_LEVEL = {
  COLD: 1,      // ❄️ New session (0-2 days)
  WARMING: 2,   // 🔥 Building trust (3-7 days)
  HOT: 3        // 🚀 Mature/Veteran (7+ days)
};

// Default Ramp-Up Schedule (can be overridden in config)
const DEFAULT_RAMP_SCHEDULE = {
  // day: { maxMessages, minDelayMs, maxDelayMs }
  1: { maxMessages: 5, minDelayMs: 600000, maxDelayMs: 1200000 },    // 10-20 min
  2: { maxMessages: 15, minDelayMs: 300000, maxDelayMs: 600000 },   // 5-10 min
  3: { maxMessages: 40, minDelayMs: 180000, maxDelayMs: 360000 },   // 3-6 min
  4: { maxMessages: 80, minDelayMs: 120000, maxDelayMs: 240000 },   // 2-4 min
  5: { maxMessages: 150, minDelayMs: 60000, maxDelayMs: 180000 },   // 1-3 min
  6: { maxMessages: 300, minDelayMs: 30000, maxDelayMs: 60000 },    // 30-60 sec
  7: { maxMessages: 1000, minDelayMs: 10000, maxDelayMs: 20000 }    // 10-20 sec (veteran)
};

/**
 * Get session age in days
 */
async function getSessionAgeDays(sessionId) {
  const redis = getRedis();
  const createdAt = await redis.hget(`session:${sessionId}`, "createdAt");
  
  if (!createdAt) return 0;
  
  const ageMs = Date.now() - parseInt(createdAt);
  return Math.floor(ageMs / (24 * 60 * 60 * 1000));
}

/**
 * Calculate trust level for a session
 */
async function calculateTrustLevel(sessionId) {
  const redis = getRedis();
  
  const [ageDays, totalSent, hasBeenBanned] = await Promise.all([
    getSessionAgeDays(sessionId),
    redis.hget(`session:${sessionId}`, "totalSentAllTime").then(v => parseInt(v) || 0),
    redis.hget(`session:${sessionId}`, "hasBeenBanned").then(v => v === "true")
  ]);
  
  // If ever banned, demote to COLD
  if (hasBeenBanned) {
    return TRUST_LEVEL.COLD;
  }
  
  // COLD: Less than 2 days OR less than 50 messages total
  if (ageDays < 2 || totalSent < 50) {
    return TRUST_LEVEL.COLD;
  }
  
  // HOT: More than 7 days AND more than 500 messages
  if (ageDays >= 7 && totalSent >= 500) {
    return TRUST_LEVEL.HOT;
  }
  
  // WARMING: Everything else (3-7 days, no bans)
  return TRUST_LEVEL.WARMING;
}

/**
 * Get sending limits for a session based on its age
 */
async function getSessionLimits(sessionId) {
  const redis = getRedis();
  
  // Check for custom config in Redis
  const customConfig = await redis.hgetall("config:rampSchedule") || {};
  const schedule = (customConfig && Object.keys(customConfig).length > 0)
    ? JSON.parse(customConfig.schedule || JSON.stringify(DEFAULT_RAMP_SCHEDULE))
    : DEFAULT_RAMP_SCHEDULE;
  
  const ageDays = await getSessionAgeDays(sessionId);
  const day = Math.min(Math.max(ageDays + 1, 1), 7); // Clamp to 1-7
  
  return schedule[day] || schedule[7];
}

/**
 * Check if session can send a message right now
 */
async function canSessionSend(sessionId) {
  const redis = getRedis();
  
  // Check if session is in cooldown
  const cooldownKey = `session:cooldown:${sessionId}`;
  const inCooldown = await redis.exists(cooldownKey);
  
  if (inCooldown) {
    const ttl = await redis.ttl(cooldownKey);
    return { 
      canSend: false, 
      reason: "COOLDOWN", 
      cooldownSecondsLeft: ttl 
    };
  }
  
  // Check daily limit
  const sentToday = parseInt(await redis.hget(`session:${sessionId}`, "sentToday") || "0");
  const limits = await getSessionLimits(sessionId);
  
  if (sentToday >= limits.maxMessages) {
    return { 
      canSend: false, 
      reason: "DAILY_LIMIT_REACHED", 
      sentToday, 
      maxAllowed: limits.maxMessages 
    };
  }
  
  // Check if session is connected
  const status = await redis.hget(`session:${sessionId}`, "status");
  if (status !== "CONNECTED") {
    return { 
      canSend: false, 
      reason: "NOT_CONNECTED", 
      status 
    };
  }
  
  return { 
    canSend: true, 
    sentToday, 
    maxAllowed: limits.maxMessages,
    remaining: limits.maxMessages - sentToday
  };
}

/**
 * Record a sent message and apply cooldown
 */
async function recordMessageSent(sessionId) {
  const redis = getRedis();
  const limits = await getSessionLimits(sessionId);
  
  // Increment counters
  await redis.hincrby(`session:${sessionId}`, "sentToday", 1);
  await redis.hincrby(`session:${sessionId}`, "totalSentAllTime", 1);
  await redis.hset(`session:${sessionId}`, "lastMessageTime", Date.now().toString());
  
  // Apply cooldown (random between min and max delay)
  const cooldownMs = limits.minDelayMs + Math.random() * (limits.maxDelayMs - limits.minDelayMs);
  const cooldownSec = Math.ceil(cooldownMs / 1000);
  
  await redis.set(`session:cooldown:${sessionId}`, "1", "EX", cooldownSec);
  
  return {
    cooldownMs,
    cooldownSec,
    limits
  };
}

/**
 * Get full session grade info
 */
async function getSessionGradeInfo(sessionId) {
  const redis = getRedis();
  
  const [
    trustLevel,
    ageDays,
    sentToday,
    totalSent,
    limits,
    canSendResult,
    status
  ] = await Promise.all([
    calculateTrustLevel(sessionId),
    getSessionAgeDays(sessionId),
    redis.hget(`session:${sessionId}`, "sentToday").then(v => parseInt(v) || 0),
    redis.hget(`session:${sessionId}`, "totalSentAllTime").then(v => parseInt(v) || 0),
    getSessionLimits(sessionId),
    canSessionSend(sessionId),
    redis.hget(`session:${sessionId}`, "status")
  ]);
  
  const gradeNames = {
    [TRUST_LEVEL.COLD]: { name: "Cold", emoji: "❄️", nameHe: "קר" },
    [TRUST_LEVEL.WARMING]: { name: "Warming", emoji: "🔥", nameHe: "מתחמם" },
    [TRUST_LEVEL.HOT]: { name: "Hot", emoji: "🚀", nameHe: "ותיק" }
  };
  
  const grade = gradeNames[trustLevel];
  
  return {
    sessionId,
    trustLevel,
    grade: grade.name,
    gradeEmoji: grade.emoji,
    gradeHe: grade.nameHe,
    ageDays,
    dayNumber: Math.min(ageDays + 1, 7),
    stats: {
      sentToday,
      totalSentAllTime: totalSent,
      maxAllowedToday: limits.maxMessages,
      remainingToday: Math.max(0, limits.maxMessages - sentToday)
    },
    limits: {
      maxMessages: limits.maxMessages,
      minDelaySec: Math.round(limits.minDelayMs / 1000),
      maxDelaySec: Math.round(limits.maxDelayMs / 1000)
    },
    status,
    canSend: canSendResult.canSend,
    canSendReason: canSendResult.reason || null
  };
}

/**
 * Get all sessions sorted by grade (for dispatcher)
 */
async function getAllSessionsByGrade() {
  const redis = getRedis();
  const sessionIds = await redis.smembers("sessions:active") || [];
  
  const sessions = {
    hot: [],      // Grade 3 - Veterans
    warming: [],  // Grade 2 - Building trust
    cold: []      // Grade 1 - New
  };
  
  for (const sessionId of sessionIds) {
    const info = await getSessionGradeInfo(sessionId);
    
    if (info.status !== "CONNECTED") continue;
    
    const entry = {
      sessionId,
      ...info
    };
    
    switch (info.trustLevel) {
      case TRUST_LEVEL.HOT:
        sessions.hot.push(entry);
        break;
      case TRUST_LEVEL.WARMING:
        sessions.warming.push(entry);
        break;
      case TRUST_LEVEL.COLD:
        sessions.cold.push(entry);
        break;
    }
  }
  
  // Sort each group by remaining capacity (descending)
  const sortByRemaining = (a, b) => b.stats.remainingToday - a.stats.remainingToday;
  sessions.hot.sort(sortByRemaining);
  sessions.warming.sort(sortByRemaining);
  sessions.cold.sort(sortByRemaining);
  
  return sessions;
}

/**
 * Reset daily counters (run at midnight via CRON)
 */
async function resetDailyCounters() {
  const redis = getRedis();
  const sessionIds = await redis.smembers("sessions:active") || [];
  
  let resetCount = 0;
  
  for (const sessionId of sessionIds) {
    await redis.hset(`session:${sessionId}`, "sentToday", "0");
    resetCount++;
  }
  
  console.log(`[SessionGrading] Reset daily counters for ${resetCount} sessions`);
  
  // Store last reset time
  await redis.set("grading:lastDailyReset", Date.now().toString());
  
  return resetCount;
}

/**
 * Update trust scores for all sessions (run daily)
 */
async function updateAllTrustScores() {
  const redis = getRedis();
  const sessionIds = await redis.smembers("sessions:active") || [];
  
  const results = {
    cold: 0,
    warming: 0,
    hot: 0
  };
  
  for (const sessionId of sessionIds) {
    const trustLevel = await calculateTrustLevel(sessionId);
    await redis.hset(`session:${sessionId}`, "trustLevel", trustLevel.toString());
    
    switch (trustLevel) {
      case TRUST_LEVEL.COLD: results.cold++; break;
      case TRUST_LEVEL.WARMING: results.warming++; break;
      case TRUST_LEVEL.HOT: results.hot++; break;
    }
  }
  
  console.log(`[SessionGrading] Updated trust scores: ${results.cold} cold, ${results.warming} warming, ${results.hot} hot`);
  
  await redis.set("grading:lastTrustUpdate", Date.now().toString());
  
  return results;
}

module.exports = {
  TRUST_LEVEL,
  DEFAULT_RAMP_SCHEDULE,
  getSessionAgeDays,
  calculateTrustLevel,
  getSessionLimits,
  canSessionSend,
  recordMessageSent,
  getSessionGradeInfo,
  getAllSessionsByGrade,
  resetDailyCounters,
  updateAllTrustScores
};


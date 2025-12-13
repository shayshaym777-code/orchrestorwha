/**
 * Smart Warming Dispatcher - Session Grading & Rate Limiting System
 * 
 * מנגנון חימום וניהול עומסים למניעת חסימות (Anti-Ban)
 * 
 * Trust Levels:
 * - Level 1 (COLD): New sessions < 48h or < 50 messages
 * - Level 2 (WARMING): Active 3-7 days, no bans
 * - Level 3 (HOT): Active > 7 days, > 500 messages sent
 */

const { getRedis } = require("../infra/redis");

// ============ CONFIGURATION ============
// Default warming schedule - can be overridden from DB/config
const DEFAULT_WARMING_SCHEDULE = {
  1: { maxMessages: 5, minDelayMs: 600000, maxDelayMs: 1200000 },   // Day 1: 5 msgs, 10-20 min delay
  2: { maxMessages: 15, minDelayMs: 300000, maxDelayMs: 600000 },   // Day 2: 15 msgs, 5-10 min delay
  3: { maxMessages: 40, minDelayMs: 180000, maxDelayMs: 360000 },   // Day 3: 40 msgs, 3-6 min delay
  4: { maxMessages: 80, minDelayMs: 120000, maxDelayMs: 240000 },   // Day 4: 80 msgs, 2-4 min delay
  5: { maxMessages: 150, minDelayMs: 60000, maxDelayMs: 180000 },   // Day 5: 150 msgs, 1-3 min delay
  6: { maxMessages: 300, minDelayMs: 30000, maxDelayMs: 60000 },    // Day 6: 300 msgs, 30-60 sec delay
  7: { maxMessages: 1000, minDelayMs: 10000, maxDelayMs: 20000 },   // Day 7+: 1000 msgs, 10-20 sec delay
};

const TRUST_LEVELS = {
  COLD: 1,      // ❄️ קר - סשן חדש
  WARMING: 2,   // 🔥 מתחמם
  HOT: 3        // 🚀 ותיק/לוהט
};

const TRUST_LEVEL_NAMES = {
  1: { name: "Cold", emoji: "❄️", hebrewName: "קר" },
  2: { name: "Warming", emoji: "🔥", hebrewName: "מתחמם" },
  3: { name: "Hot", emoji: "🚀", hebrewName: "ותיק" }
};

// Thresholds
const COLD_MAX_HOURS = 48;           // Session younger than 48h is COLD
const COLD_MAX_MESSAGES = 50;        // Session with < 50 messages is COLD
const WARMING_MAX_DAYS = 7;          // Session older than 7 days can be HOT
const HOT_MIN_MESSAGES = 500;        // Need 500+ messages to be HOT

// ============ REDIS KEYS ============
const KEYS = {
  sessionWarming: (sessionId) => `warming:session:${sessionId}`,
  sessionCooldown: (sessionId) => `warming:cooldown:${sessionId}`,
  dailySent: (sessionId) => `warming:daily:${sessionId}`,
  warmingConfig: "warming:config",
  warmingSchedule: "warming:schedule"
};

// ============ SESSION GRADING ============

/**
 * Calculate trust level for a session
 * @param {Object} sessionData - Session data from Redis
 * @returns {Object} { level: number, levelName: string, emoji: string }
 */
function calculateTrustLevel(sessionData) {
  const now = Date.now();
  const createdAt = parseInt(sessionData.createdAt) || now;
  const totalSent = parseInt(sessionData.totalSentAllTime) || 0;
  const hasBanHistory = sessionData.banHistory === "true" || sessionData.hasBan === "true";
  
  const ageHours = (now - createdAt) / (1000 * 60 * 60);
  const ageDays = ageHours / 24;
  
  // Level 1 (COLD): New or low activity
  if (ageHours < COLD_MAX_HOURS || totalSent < COLD_MAX_MESSAGES) {
    return {
      level: TRUST_LEVELS.COLD,
      ...TRUST_LEVEL_NAMES[TRUST_LEVELS.COLD],
      reason: ageHours < COLD_MAX_HOURS 
        ? `סשן חדש (${Math.floor(ageHours)} שעות)` 
        : `פעילות נמוכה (${totalSent} הודעות)`
    };
  }
  
  // Level 3 (HOT): Veteran with high activity
  if (ageDays >= WARMING_MAX_DAYS && totalSent >= HOT_MIN_MESSAGES && !hasBanHistory) {
    return {
      level: TRUST_LEVELS.HOT,
      ...TRUST_LEVEL_NAMES[TRUST_LEVELS.HOT],
      reason: `ותיק (${Math.floor(ageDays)} ימים, ${totalSent} הודעות)`
    };
  }
  
  // Level 2 (WARMING): In between
  return {
    level: TRUST_LEVELS.WARMING,
    ...TRUST_LEVEL_NAMES[TRUST_LEVELS.WARMING],
    reason: `מתחמם (${Math.floor(ageDays)} ימים, ${totalSent} הודעות)`
  };
}

/**
 * Get warming schedule for a session based on age
 * @param {number} createdAt - Session creation timestamp
 * @returns {Object} { maxMessages, minDelayMs, maxDelayMs, day }
 */
async function getWarmingSchedule(createdAt) {
  const redis = getRedis();
  
  // Try to get custom schedule from Redis
  let schedule = DEFAULT_WARMING_SCHEDULE;
  try {
    const customSchedule = await redis.get(KEYS.warmingSchedule);
    if (customSchedule) {
      schedule = JSON.parse(customSchedule);
    }
  } catch (e) {
    console.error("[Warming] Error reading custom schedule:", e.message);
  }
  
  const now = Date.now();
  const ageMs = now - (parseInt(createdAt) || now);
  const day = Math.max(1, Math.ceil(ageMs / (1000 * 60 * 60 * 24)));
  
  // Get schedule for this day (cap at day 7)
  const scheduleDay = Math.min(day, 7);
  const daySchedule = schedule[scheduleDay] || schedule[7];
  
  return {
    ...daySchedule,
    day,
    scheduleDay
  };
}

/**
 * Get full warming status for a session
 * @param {string} sessionId - Session ID
 * @returns {Object} Complete warming status
 */
async function getSessionWarmingStatus(sessionId) {
  const redis = getRedis();
  
  // Get session data
  const sessionData = await redis.hgetall(`session:${sessionId}`);
  if (!sessionData || Object.keys(sessionData).length === 0) {
    return null;
  }
  
  // Get warming-specific data
  const warmingData = await redis.hgetall(KEYS.sessionWarming(sessionId));
  const dailySent = parseInt(await redis.get(KEYS.dailySent(sessionId)) || "0");
  const cooldownTTL = await redis.ttl(KEYS.sessionCooldown(sessionId));
  
  // Calculate trust level
  const trustLevel = calculateTrustLevel({
    ...sessionData,
    ...warmingData
  });
  
  // Get schedule
  const schedule = await getWarmingSchedule(sessionData.createdAt || warmingData.createdAt);
  
  // Calculate remaining capacity
  const remainingToday = Math.max(0, schedule.maxMessages - dailySent);
  const canSendNow = cooldownTTL <= 0 && remainingToday > 0;
  
  return {
    sessionId,
    trustLevel,
    schedule,
    stats: {
      dailySent,
      totalSentAllTime: parseInt(warmingData.totalSentAllTime) || 0,
      remainingToday,
      maxToday: schedule.maxMessages
    },
    cooldown: {
      active: cooldownTTL > 0,
      remainingSeconds: Math.max(0, cooldownTTL),
      nextAvailable: cooldownTTL > 0 ? Date.now() + (cooldownTTL * 1000) : null
    },
    canSendNow,
    createdAt: parseInt(sessionData.createdAt || warmingData.createdAt) || Date.now(),
    ageDays: schedule.day
  };
}

// ============ RATE LIMITING ============

/**
 * Check if session can send a message now
 * @param {string} sessionId - Session ID
 * @returns {Object} { canSend, reason, waitMs }
 */
async function canSessionSend(sessionId) {
  const status = await getSessionWarmingStatus(sessionId);
  
  if (!status) {
    return { canSend: false, reason: "Session not found", waitMs: 0 };
  }
  
  // Check cooldown
  if (status.cooldown.active) {
    return {
      canSend: false,
      reason: `Cooldown active (${status.cooldown.remainingSeconds}s remaining)`,
      waitMs: status.cooldown.remainingSeconds * 1000
    };
  }
  
  // Check daily limit
  if (status.stats.remainingToday <= 0) {
    return {
      canSend: false,
      reason: `Daily limit reached (${status.stats.maxToday} messages)`,
      waitMs: getMsUntilMidnight()
    };
  }
  
  return { canSend: true, reason: "OK", waitMs: 0 };
}

/**
 * Record a sent message and set cooldown
 * @param {string} sessionId - Session ID
 * @param {boolean} success - Whether the message was sent successfully
 */
async function recordMessageSent(sessionId, success = true) {
  const redis = getRedis();
  
  // Get current warming data
  const warmingData = await redis.hgetall(KEYS.sessionWarming(sessionId));
  const sessionData = await redis.hgetall(`session:${sessionId}`);
  
  // Increment counters
  await redis.incr(KEYS.dailySent(sessionId));
  await redis.hincrby(KEYS.sessionWarming(sessionId), "totalSentAllTime", 1);
  await redis.hset(KEYS.sessionWarming(sessionId), "lastMessageTime", Date.now().toString());
  
  // Set daily counter expiry at midnight
  const msUntilMidnight = getMsUntilMidnight();
  await redis.expire(KEYS.dailySent(sessionId), Math.ceil(msUntilMidnight / 1000));
  
  // Calculate and set cooldown based on schedule
  const schedule = await getWarmingSchedule(sessionData.createdAt || warmingData.createdAt);
  const cooldownMs = getRandomDelay(schedule.minDelayMs, schedule.maxDelayMs);
  const cooldownSeconds = Math.ceil(cooldownMs / 1000);
  
  await redis.setex(KEYS.sessionCooldown(sessionId), cooldownSeconds, "1");
  
  console.log(`[Warming] Session ${sessionId}: Sent message, cooldown ${cooldownSeconds}s, daily ${await redis.get(KEYS.dailySent(sessionId))}/${schedule.maxMessages}`);
  
  return {
    cooldownMs,
    cooldownSeconds,
    dailySent: parseInt(await redis.get(KEYS.dailySent(sessionId))),
    maxToday: schedule.maxMessages
  };
}

/**
 * Initialize warming data for a new session
 * @param {string} sessionId - Session ID
 */
async function initializeSessionWarming(sessionId) {
  const redis = getRedis();
  
  const exists = await redis.exists(KEYS.sessionWarming(sessionId));
  if (!exists) {
    await redis.hset(KEYS.sessionWarming(sessionId), {
      createdAt: Date.now().toString(),
      totalSentAllTime: "0",
      lastMessageTime: "0",
      banHistory: "false"
    });
    console.log(`[Warming] Initialized warming data for session ${sessionId}`);
  }
  
  // Also ensure session has createdAt
  const sessionCreatedAt = await redis.hget(`session:${sessionId}`, "createdAt");
  if (!sessionCreatedAt) {
    await redis.hset(`session:${sessionId}`, "createdAt", Date.now().toString());
  }
}

// ============ SMART DISPATCHER ============

/**
 * Get all sessions sorted by priority for dispatching
 * @param {string} messageType - "cold" for new contacts, "warm" for warming messages
 * @returns {Array} Sorted sessions with warming status
 */
async function getSessionsForDispatch(messageType = "cold") {
  const redis = getRedis();
  
  // Get all active sessions
  const sessionIds = await redis.smembers("sessions:active") || [];
  
  const sessions = [];
  for (const sessionId of sessionIds) {
    const sessionData = await redis.hgetall(`session:${sessionId}`);
    
    // Only consider CONNECTED sessions
    if (sessionData.status !== "CONNECTED") continue;
    
    const warmingStatus = await getSessionWarmingStatus(sessionId);
    if (!warmingStatus) continue;
    
    sessions.push({
      sessionId,
      ...warmingStatus,
      phone: sessionData.phone,
      proxyIp: sessionData.proxyIp
    });
  }
  
  // Sort by priority
  if (messageType === "cold") {
    // For cold messages (campaigns): prioritize HOT > WARMING, never COLD
    sessions.sort((a, b) => {
      // First by trust level (descending - HOT first)
      if (a.trustLevel.level !== b.trustLevel.level) {
        return b.trustLevel.level - a.trustLevel.level;
      }
      // Then by remaining capacity (descending)
      if (a.stats.remainingToday !== b.stats.remainingToday) {
        return b.stats.remainingToday - a.stats.remainingToday;
      }
      // Then by cooldown (not in cooldown first)
      return a.cooldown.active - b.cooldown.active;
    });
  } else if (messageType === "warm") {
    // For warming messages: prioritize COLD sessions
    sessions.sort((a, b) => {
      // First by trust level (ascending - COLD first)
      if (a.trustLevel.level !== b.trustLevel.level) {
        return a.trustLevel.level - b.trustLevel.level;
      }
      // Then by remaining capacity (descending)
      return b.stats.remainingToday - a.stats.remainingToday;
    });
  }
  
  return sessions;
}

/**
 * Select best session for sending a message
 * @param {string} messageType - "cold" or "warm"
 * @param {boolean} allowCold - Allow using COLD sessions (for warming only)
 * @returns {Object|null} Selected session or null if none available
 */
async function selectSessionForMessage(messageType = "cold", allowCold = false) {
  const sessions = await getSessionsForDispatch(messageType);
  
  for (const session of sessions) {
    // Skip COLD sessions for cold messages unless explicitly allowed
    if (!allowCold && messageType === "cold" && session.trustLevel.level === TRUST_LEVELS.COLD) {
      continue;
    }
    
    // Check if can send now
    if (session.canSendNow) {
      return session;
    }
  }
  
  // No session available now, return the one with shortest wait
  const availableSessions = sessions.filter(s => 
    allowCold || messageType === "warm" || s.trustLevel.level > TRUST_LEVELS.COLD
  );
  
  if (availableSessions.length === 0) return null;
  
  // Find session with shortest wait time
  let bestSession = availableSessions[0];
  let shortestWait = Infinity;
  
  for (const session of availableSessions) {
    let waitMs = 0;
    
    if (session.cooldown.active) {
      waitMs = session.cooldown.remainingSeconds * 1000;
    }
    
    if (session.stats.remainingToday <= 0) {
      waitMs = getMsUntilMidnight();
    }
    
    if (waitMs < shortestWait) {
      shortestWait = waitMs;
      bestSession = session;
    }
  }
  
  return {
    ...bestSession,
    waitMs: shortestWait,
    waitUntil: Date.now() + shortestWait
  };
}

/**
 * Distribute a campaign across available sessions
 * @param {number} totalMessages - Total messages to send
 * @returns {Object} Distribution plan
 */
async function planCampaignDistribution(totalMessages) {
  const sessions = await getSessionsForDispatch("cold");
  
  // Separate by trust level
  const hotSessions = sessions.filter(s => s.trustLevel.level === TRUST_LEVELS.HOT);
  const warmingSessions = sessions.filter(s => s.trustLevel.level === TRUST_LEVELS.WARMING);
  const coldSessions = sessions.filter(s => s.trustLevel.level === TRUST_LEVELS.COLD);
  
  // Calculate total capacity
  const hotCapacity = hotSessions.reduce((sum, s) => sum + s.stats.remainingToday, 0);
  const warmingCapacity = warmingSessions.reduce((sum, s) => sum + s.stats.remainingToday, 0);
  const coldCapacity = coldSessions.reduce((sum, s) => sum + Math.min(s.stats.remainingToday, 5), 0); // Max 5 per cold session
  
  const totalCapacity = hotCapacity + warmingCapacity + coldCapacity;
  
  // Distribution plan
  const distribution = {
    totalMessages,
    totalCapacity,
    canComplete: totalCapacity >= totalMessages,
    estimatedTimeMs: 0,
    assignments: []
  };
  
  let remaining = totalMessages;
  
  // First, assign to HOT sessions
  for (const session of hotSessions) {
    if (remaining <= 0) break;
    const assign = Math.min(remaining, session.stats.remainingToday);
    if (assign > 0) {
      distribution.assignments.push({
        sessionId: session.sessionId,
        phone: session.phone,
        trustLevel: session.trustLevel,
        messages: assign,
        avgDelayMs: (session.schedule.minDelayMs + session.schedule.maxDelayMs) / 2
      });
      remaining -= assign;
    }
  }
  
  // Then, assign to WARMING sessions
  for (const session of warmingSessions) {
    if (remaining <= 0) break;
    const assign = Math.min(remaining, session.stats.remainingToday);
    if (assign > 0) {
      distribution.assignments.push({
        sessionId: session.sessionId,
        phone: session.phone,
        trustLevel: session.trustLevel,
        messages: assign,
        avgDelayMs: (session.schedule.minDelayMs + session.schedule.maxDelayMs) / 2
      });
      remaining -= assign;
    }
  }
  
  // Finally, assign small amounts to COLD sessions for warming
  for (const session of coldSessions) {
    if (remaining <= 0) break;
    const assign = Math.min(remaining, session.stats.remainingToday, 5); // Max 5 per cold
    if (assign > 0) {
      distribution.assignments.push({
        sessionId: session.sessionId,
        phone: session.phone,
        trustLevel: session.trustLevel,
        messages: assign,
        avgDelayMs: (session.schedule.minDelayMs + session.schedule.maxDelayMs) / 2,
        isWarming: true
      });
      remaining -= assign;
    }
  }
  
  // Calculate estimated time
  for (const assignment of distribution.assignments) {
    distribution.estimatedTimeMs += assignment.messages * assignment.avgDelayMs;
  }
  
  distribution.unassigned = remaining;
  
  return distribution;
}

// ============ DAILY RESET ============

/**
 * Reset daily counters for all sessions (run at midnight)
 */
async function resetDailyCounters() {
  const redis = getRedis();
  
  console.log("[Warming] Running daily reset...");
  
  // Get all sessions
  const sessionIds = await redis.smembers("sessions:active") || [];
  
  let resetCount = 0;
  for (const sessionId of sessionIds) {
    const key = KEYS.dailySent(sessionId);
    const dailySent = await redis.get(key);
    
    if (dailySent && parseInt(dailySent) > 0) {
      await redis.del(key);
      resetCount++;
    }
    
    // Update trust scores based on activity
    await updateTrustScore(sessionId);
  }
  
  console.log(`[Warming] Daily reset complete. Reset ${resetCount} sessions.`);
  
  return { resetCount, totalSessions: sessionIds.length };
}

/**
 * Update trust score for a session
 * @param {string} sessionId - Session ID
 */
async function updateTrustScore(sessionId) {
  const redis = getRedis();
  
  const warmingData = await redis.hgetall(KEYS.sessionWarming(sessionId));
  const sessionData = await redis.hgetall(`session:${sessionId}`);
  
  const trustLevel = calculateTrustLevel({
    ...sessionData,
    ...warmingData
  });
  
  // Store trust score
  await redis.hset(KEYS.sessionWarming(sessionId), "trustScore", trustLevel.level.toString());
  await redis.hset(`session:${sessionId}`, "trustLevel", trustLevel.level.toString());
  
  return trustLevel;
}

// ============ WARMING PULSES ============

/**
 * Generate warming tasks for cold sessions
 * @returns {Array} List of warming tasks
 */
async function generateWarmingTasks() {
  const sessions = await getSessionsForDispatch("warm");
  const tasks = [];
  
  // Only target COLD sessions
  const coldSessions = sessions.filter(s => 
    s.trustLevel.level === TRUST_LEVELS.COLD && 
    s.canSendNow
  );
  
  for (const session of coldSessions) {
    // Create warming task (internal ping or self-message)
    tasks.push({
      type: "warming",
      sessionId: session.sessionId,
      phone: session.phone,
      action: "self_message", // Or "ping" or "status_update"
      priority: 1
    });
  }
  
  return tasks;
}

// ============ HELPERS ============

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getMsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

// ============ CONFIGURATION MANAGEMENT ============

/**
 * Get warming configuration
 */
async function getWarmingConfig() {
  const redis = getRedis();
  
  try {
    const config = await redis.get(KEYS.warmingConfig);
    if (config) {
      return JSON.parse(config);
    }
  } catch (e) {
    console.error("[Warming] Error reading config:", e.message);
  }
  
  return {
    enabled: true,
    schedule: DEFAULT_WARMING_SCHEDULE,
    coldMaxHours: COLD_MAX_HOURS,
    coldMaxMessages: COLD_MAX_MESSAGES,
    warmingMaxDays: WARMING_MAX_DAYS,
    hotMinMessages: HOT_MIN_MESSAGES
  };
}

/**
 * Update warming configuration
 * @param {Object} config - New configuration
 */
async function updateWarmingConfig(config) {
  const redis = getRedis();
  
  await redis.set(KEYS.warmingConfig, JSON.stringify(config));
  
  if (config.schedule) {
    await redis.set(KEYS.warmingSchedule, JSON.stringify(config.schedule));
  }
  
  console.log("[Warming] Configuration updated");
  return config;
}

// ============ EXPORTS ============

module.exports = {
  // Constants
  TRUST_LEVELS,
  TRUST_LEVEL_NAMES,
  DEFAULT_WARMING_SCHEDULE,
  
  // Session grading
  calculateTrustLevel,
  getWarmingSchedule,
  getSessionWarmingStatus,
  updateTrustScore,
  
  // Rate limiting
  canSessionSend,
  recordMessageSent,
  initializeSessionWarming,
  
  // Dispatcher
  getSessionsForDispatch,
  selectSessionForMessage,
  planCampaignDistribution,
  
  // Daily reset
  resetDailyCounters,
  
  // Warming
  generateWarmingTasks,
  
  // Config
  getWarmingConfig,
  updateWarmingConfig
};


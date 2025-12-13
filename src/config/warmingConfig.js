/**
 * Smart Warming Dispatcher Configuration
 * 
 * Ramp-up schedule for session warming and anti-ban protection
 */

const WARMING_CONFIG = {
  // Session grades
  GRADES: {
    COLD: 1,      // ❄️ New session (0-2 days)
    WARMING: 2,   // 🔥 Warming up (3-6 days)
    HOT: 3        // 🚀 Mature/Veteran (7+ days)
  },

  // Grade thresholds
  THRESHOLDS: {
    // Minimum days to advance from COLD to WARMING
    COLD_TO_WARMING_DAYS: 3,
    // Minimum days to advance from WARMING to HOT
    WARMING_TO_HOT_DAYS: 7,
    // Minimum total messages for HOT status
    HOT_MIN_MESSAGES: 500,
    // Minimum messages to exit COLD
    COLD_MIN_MESSAGES: 50
  },

  // Ramp-up schedule (day -> limits)
  // Day is calculated from session creation
  RAMP_UP_SCHEDULE: {
    1: { maxMessages: 5,    minDelayMs: 600000,  maxDelayMs: 1200000, grade: 1 },  // 10-20 min
    2: { maxMessages: 15,   minDelayMs: 300000,  maxDelayMs: 600000,  grade: 1 },  // 5-10 min
    3: { maxMessages: 40,   minDelayMs: 180000,  maxDelayMs: 360000,  grade: 2 },  // 3-6 min
    4: { maxMessages: 80,   minDelayMs: 120000,  maxDelayMs: 240000,  grade: 2 },  // 2-4 min
    5: { maxMessages: 150,  minDelayMs: 60000,   maxDelayMs: 180000,  grade: 2 },  // 1-3 min
    6: { maxMessages: 300,  minDelayMs: 30000,   maxDelayMs: 60000,   grade: 2 },  // 30-60 sec
    7: { maxMessages: 1000, minDelayMs: 10000,   maxDelayMs: 20000,   grade: 3 },  // 10-20 sec
  },

  // Default limits for mature sessions (day 7+)
  MATURE_LIMITS: {
    maxMessages: 1000,
    minDelayMs: 10000,   // 10 seconds
    maxDelayMs: 20000,   // 20 seconds
    grade: 3
  },

  // Warm-up pulse settings (internal messages between bots)
  WARMUP_PULSE: {
    enabled: true,
    intervalMs: 3600000,  // Every hour
    targetGrades: [1],    // Only for COLD sessions
    messagesPerPulse: 1
  },

  // Dispatcher settings
  DISPATCHER: {
    // For cold messages (new recipients), prefer mature sessions
    coldMessageStrategy: 'PREFER_HOT',
    // Allow COLD sessions for mass campaigns?
    allowColdForMass: false,
    // Minimum sessions needed for campaign
    minSessionsForCampaign: 2,
    // Max retry attempts per message
    maxRetries: 3
  },

  // Redis key prefixes
  REDIS_KEYS: {
    SESSION_WARMING: 'warming:session:',      // warming:session:{sessionId}
    DAILY_COUNTER: 'warming:daily:',          // warming:daily:{sessionId}
    COOLDOWN: 'warming:cooldown:',            // warming:cooldown:{sessionId}
    LAST_MESSAGE: 'warming:lastmsg:',         // warming:lastmsg:{sessionId}
    TRUST_SCORE: 'warming:trust:',            // warming:trust:{sessionId}
    CAMPAIGN_QUEUE: 'warming:campaign:queue', // Campaign message queue
  },

  // TTL for Redis keys
  TTL: {
    DAILY_COUNTER: 86400,   // 24 hours
    COOLDOWN: 1200,         // 20 minutes max
    LAST_MESSAGE: 86400,    // 24 hours
  }
};

module.exports = { WARMING_CONFIG };


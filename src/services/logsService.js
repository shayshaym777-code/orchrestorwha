/**
 * Message Logs Service - tracks all message activity for live dashboard
 */
const { getRedis } = require("../infra/redis");

const LOGS_KEY = "logs:messages";
const MAX_LOGS = 500;

/**
 * Log types for message tracking
 */
const LogType = {
  QUEUED: "QUEUED",
  SENT: "SENT",
  FAILED: "FAILED",
  NOT_EXISTS: "NOT_EXISTS",
  BANNED: "BANNED",
  TIMEOUT: "TIMEOUT"
};

/**
 * Add a log entry
 * @param {Object} entry - Log entry
 */
async function addLog(entry) {
  const client = getRedis();

  const log = {
    id: Date.now() + "-" + Math.random().toString(36).substr(2, 9),
    timestamp: Date.now(),
    type: entry.type || LogType.QUEUED,
    phone: entry.phone || "unknown",
    sessionId: entry.sessionId || null,
    message: entry.message || "",
    messagePreview: (entry.messageText || "").substring(0, 50),
    error: entry.error || null
  };

  try {
    // Add to list (newest first)
    await client.lpush(LOGS_KEY, JSON.stringify(log));
    // Trim to max size
    await client.ltrim(LOGS_KEY, 0, MAX_LOGS - 1);
  } catch (err) {
    console.error("Failed to add log:", err.message);
  }
}

/**
 * Get recent logs
 * @param {number} limit - Max logs to return
 * @returns {Array} - Log entries
 */
async function getLogs(limit = 100) {
  const client = getRedis();

  try {
    const raw = await client.lrange(LOGS_KEY, 0, limit - 1);
    return raw.map(r => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    console.error("Failed to get logs:", err.message);
    return [];
  }
}

/**
 * Get stats summary
 * @returns {Object} - Stats by type
 */
async function getStats() {
  const logs = await getLogs(500);
  
  const stats = {
    total: logs.length,
    sent: 0,
    failed: 0,
    queued: 0,
    notExists: 0,
    banned: 0,
    timeout: 0
  };

  for (const log of logs) {
    switch (log.type) {
      case LogType.SENT: stats.sent++; break;
      case LogType.FAILED: stats.failed++; break;
      case LogType.QUEUED: stats.queued++; break;
      case LogType.NOT_EXISTS: stats.notExists++; break;
      case LogType.BANNED: stats.banned++; break;
      case LogType.TIMEOUT: stats.timeout++; break;
    }
  }

  return stats;
}

/**
 * Clear all logs
 */
async function clearLogs() {
  const client = getRedis();

  try {
    await client.del(LOGS_KEY);
  } catch (err) {
    console.error("Failed to clear logs:", err.message);
  }
}

// Helper functions for common log operations
async function logQueued(phone, sessionId, messageText) {
  await addLog({ type: LogType.QUEUED, phone, sessionId, messageText, message: "הודעה נכנסה לתור" });
}

async function logSent(phone, sessionId, messageText) {
  await addLog({ type: LogType.SENT, phone, sessionId, messageText, message: "הודעה נשלחה בהצלחה" });
}

async function logFailed(phone, sessionId, error) {
  await addLog({ type: LogType.FAILED, phone, sessionId, message: error, error });
}

async function logNotExists(phone, sessionId) {
  await addLog({ type: LogType.NOT_EXISTS, phone, sessionId, message: "מספר לא קיים בוואטסאפ" });
}

async function logBanned(phone, sessionId) {
  await addLog({ type: LogType.BANNED, phone, sessionId, message: "סשן נחסם" });
}

module.exports = {
  LogType,
  addLog,
  getLogs,
  getStats,
  clearLogs,
  logQueued,
  logSent,
  logFailed,
  logNotExists,
  logBanned
};


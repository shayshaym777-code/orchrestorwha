/**
 * CRON Service - Scheduled Tasks
 * 
 * Handles scheduled background tasks like daily resets
 */

const warmingService = require("./warmingService");
const { createBackup } = require("./backupService");
const { alertDailySummary, alertBackupComplete, alertBackupFailed } = require("./telegramAlertService");
const sessionBrainEnforcer = require("./sessionBrainEnforcerService");
const incidentTelegramBridge = require("./incidentTelegramBridge");
const jobTelegramBridge = require("./jobTelegramBridge");

let dailyResetInterval = null;
let warmingPulseInterval = null;
let dailyBackupInterval = null;
let sessionBrainEnforcerInterval = null;

// ============ DAILY RESET ============

/**
 * Calculate milliseconds until next midnight
 */
function getMsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

/**
 * Schedule daily reset at midnight
 */
function scheduleDailyReset() {
  // Cancel existing schedule
  if (dailyResetInterval) {
    clearTimeout(dailyResetInterval);
  }
  
  const msUntilMidnight = getMsUntilMidnight();
  
  console.log(`[CRON] Daily reset scheduled in ${Math.floor(msUntilMidnight / 1000 / 60)} minutes`);
  
  // Schedule first reset at midnight
  dailyResetInterval = setTimeout(async () => {
    await runDailyReset();
    
    // Then schedule to run every 24 hours
    dailyResetInterval = setInterval(runDailyReset, 24 * 60 * 60 * 1000);
    
  }, msUntilMidnight);
}

/**
 * Run daily reset
 */
async function runDailyReset() {
  console.log("[CRON] Running daily reset...");
  
  try {
    const result = await warmingService.resetDailyCounters();
    console.log(`[CRON] Daily reset complete: ${result.resetCount}/${result.totalSessions} sessions reset`);
    return result;
  } catch (error) {
    console.error("[CRON] Daily reset error:", error);
    return { error: error.message };
  }
}

// ============ WARMING PULSES ============

/**
 * Schedule warming pulse tasks
 * Runs every hour to generate warming tasks for cold sessions
 */
function scheduleWarmingPulses() {
  // Cancel existing schedule
  if (warmingPulseInterval) {
    clearInterval(warmingPulseInterval);
  }
  
  // Run every hour
  warmingPulseInterval = setInterval(async () => {
    await runWarmingPulse();
  }, 60 * 60 * 1000);
  
  console.log("[CRON] Warming pulses scheduled every hour");
}

/**
 * Run warming pulse - generate tasks for cold sessions
 */
async function runWarmingPulse() {
  console.log("[CRON] Running warming pulse...");
  
  try {
    const tasks = await warmingService.generateWarmingTasks();
    console.log(`[CRON] Generated ${tasks.length} warming tasks`);
    return tasks;
  } catch (error) {
    console.error("[CRON] Warming pulse error:", error);
    return { error: error.message };
  }
}

// ============ DAILY BACKUP ============

/**
 * Calculate milliseconds until 3 AM
 */
function getMsUntil3AM() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(3, 0, 0, 0);
  
  // If it's already past 3 AM, schedule for tomorrow
  if (now.getHours() >= 3) {
    target.setDate(target.getDate() + 1);
  }
  
  return target.getTime() - now.getTime();
}

/**
 * Schedule daily backup at 3 AM
 */
function scheduleDailyBackup() {
  if (dailyBackupInterval) {
    clearTimeout(dailyBackupInterval);
  }
  
  const msUntil3AM = getMsUntil3AM();
  
  console.log(`[CRON] Daily backup scheduled in ${Math.floor(msUntil3AM / 1000 / 60)} minutes (3 AM)`);
  
  // Schedule first backup at 3 AM
  dailyBackupInterval = setTimeout(async () => {
    await runDailyBackup();
    
    // Then schedule to run every 24 hours
    dailyBackupInterval = setInterval(runDailyBackup, 24 * 60 * 60 * 1000);
    
  }, msUntil3AM);
}

/**
 * Run daily backup
 */
async function runDailyBackup() {
  console.log("[CRON] Running daily backup...");
  
  try {
    const result = await createBackup();
    
    if (result.success) {
      console.log(`[CRON] Daily backup complete: ${result.name} (${result.sizeMB} MB)`);
      
      // Send Telegram alert
      await alertBackupComplete(result.name, result.sizeMB, result.sessionsCount);
    } else {
      console.error("[CRON] Daily backup failed:", result.error || result.reason);
      await alertBackupFailed(result.error || result.reason);
    }
    
    return result;
  } catch (error) {
    console.error("[CRON] Daily backup error:", error);
    await alertBackupFailed(error.message);
    return { error: error.message };
  }
}

// ============ DAILY SUMMARY ============

/**
 * Run daily summary (called after reset)
 */
async function runDailySummary(resetResult) {
  try {
    // Build stats object
    const stats = {
      activeSessions: resetResult.totalSessions || 0,
      messagesSent: resetResult.totalMessagesSent || 0,
      messagesFailed: 0,  // Could be tracked in Redis
      proxiesAvailable: 0,
      proxiesBad: 0
    };
    
    await alertDailySummary(stats);
  } catch (error) {
    console.error("[CRON] Daily summary error:", error);
  }
}

// ============ SERVICE CONTROL ============

/**
 * Start all CRON jobs
 */
function startCronJobs() {
  console.log("[CRON] Starting scheduled jobs...");
  
  scheduleDailyReset();
  scheduleWarmingPulses();
  scheduleDailyBackup();
  scheduleSessionBrainEnforcer();
  incidentTelegramBridge.start();
  jobTelegramBridge.start();
  
  console.log("[CRON] All jobs scheduled");
}

/**
 * Stop all CRON jobs
 */
function stopCronJobs() {
  console.log("[CRON] Stopping scheduled jobs...");
  
  if (dailyResetInterval) {
    clearTimeout(dailyResetInterval);
    clearInterval(dailyResetInterval);
    dailyResetInterval = null;
  }
  
  if (warmingPulseInterval) {
    clearInterval(warmingPulseInterval);
    warmingPulseInterval = null;
  }
  
  if (dailyBackupInterval) {
    clearTimeout(dailyBackupInterval);
    clearInterval(dailyBackupInterval);
    dailyBackupInterval = null;
  }

  if (sessionBrainEnforcerInterval) {
    clearInterval(sessionBrainEnforcerInterval);
    sessionBrainEnforcerInterval = null;
  }

  incidentTelegramBridge.stop();
  jobTelegramBridge.stop();
  
  console.log("[CRON] All jobs stopped");
}

/**
 * Get CRON status
 */
function getCronStatus() {
  return {
    dailyReset: {
      active: dailyResetInterval !== null,
      nextRun: dailyResetInterval ? new Date(Date.now() + getMsUntilMidnight()).toISOString() : null
    },
    warmingPulse: {
      active: warmingPulseInterval !== null
    },
    dailyBackup: {
      active: dailyBackupInterval !== null,
      nextRun: dailyBackupInterval ? new Date(Date.now() + getMsUntil3AM()).toISOString() : null,
      scheduledTime: "03:00"
    },
    sessionBrainEnforcer: {
      active: sessionBrainEnforcerInterval !== null,
      status: sessionBrainEnforcer.getStatus()
    },
    telegramIncidentBridge: incidentTelegramBridge.getStatus(),
    telegramJobBridge: jobTelegramBridge.getStatus()
  };
}

function scheduleSessionBrainEnforcer() {
  // The enforcer itself runs on its own interval if enabled; we keep this as a "cron registered" flag.
  if (sessionBrainEnforcerInterval) return;
  sessionBrainEnforcer.start();
  sessionBrainEnforcerInterval = setInterval(() => {}, 60 * 1000);
}

// ============ MANUAL TRIGGERS ============

/**
 * Manually trigger daily reset
 */
async function triggerDailyReset() {
  return await runDailyReset();
}

/**
 * Manually trigger warming pulse
 */
async function triggerWarmingPulse() {
  return await runWarmingPulse();
}

/**
 * Manually trigger backup
 */
async function triggerBackup() {
  return await runDailyBackup();
}

// ============ EXPORTS ============

module.exports = {
  startCronJobs,
  stopCronJobs,
  getCronStatus,
  triggerDailyReset,
  triggerWarmingPulse,
  triggerBackup
};


/**
 * Warming Scheduler - CRON Jobs for Session Management
 * 
 * Handles:
 * - Midnight daily counter reset
 * - Trust score updates
 * - Warmup task generation
 * - Pending queue processing
 */

const { getRedis } = require("../infra/redis");
const { resetDailyCounters, updateAllTrustScores } = require("./sessionGradingService");
const { processPendingQueue, generateWarmupTasks, getDispatcherStatus } = require("./smartDispatcher");

let schedulerRunning = false;
let intervals = {};

/**
 * Check if it's midnight (within 5 minute window)
 */
function isAroundMidnight() {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  
  return hours === 0 && minutes < 5;
}

/**
 * Midnight tasks - run once per day at 00:00
 */
async function runMidnightTasks() {
  const redis = getRedis();
  
  // Check if already ran today
  const lastReset = await redis.get("scheduler:lastMidnightRun");
  const today = new Date().toISOString().split('T')[0];
  
  if (lastReset === today) {
    return { skipped: true, reason: "Already ran today" };
  }
  
  console.log("[Scheduler] Running midnight tasks...");
  
  try {
    // 1. Reset daily counters
    const resetCount = await resetDailyCounters();
    
    // 2. Update trust scores
    const trustResults = await updateAllTrustScores();
    
    // 3. Mark as done
    await redis.set("scheduler:lastMidnightRun", today);
    
    // 4. Log results
    const results = {
      timestamp: Date.now(),
      date: today,
      resetCount,
      trustScores: trustResults
    };
    
    await redis.lpush("scheduler:midnightLog", JSON.stringify(results));
    await redis.ltrim("scheduler:midnightLog", 0, 29); // Keep 30 days
    
    console.log("[Scheduler] Midnight tasks complete:", results);
    
    return results;
  } catch (err) {
    console.error("[Scheduler] Midnight tasks error:", err);
    return { error: err.message };
  }
}

/**
 * Warmup pulse - generate and dispatch warmup messages for cold sessions
 */
async function runWarmupPulse() {
  console.log("[Scheduler] Running warmup pulse...");
  
  try {
    const tasks = await generateWarmupTasks();
    
    // For now, just log - actual execution would depend on having test numbers
    // or inter-bot messaging setup
    
    return {
      timestamp: Date.now(),
      tasksGenerated: tasks.length
    };
  } catch (err) {
    console.error("[Scheduler] Warmup pulse error:", err);
    return { error: err.message };
  }
}

/**
 * Process pending queue - retry queued messages
 */
async function runQueueProcessor() {
  try {
    const results = await processPendingQueue(20);
    
    if (results.length > 0) {
      console.log(`[Scheduler] Processed ${results.length} queued messages`);
    }
    
    return {
      timestamp: Date.now(),
      processed: results.length
    };
  } catch (err) {
    console.error("[Scheduler] Queue processor error:", err);
    return { error: err.message };
  }
}

/**
 * Health check - log dispatcher status
 */
async function runHealthCheck() {
  const redis = getRedis();
  
  try {
    const status = await getDispatcherStatus();
    
    // Store health snapshot
    await redis.lpush("scheduler:healthLog", JSON.stringify({
      timestamp: Date.now(),
      ...status
    }));
    await redis.ltrim("scheduler:healthLog", 0, 287); // Keep 24 hours (every 5 min)
    
    // Alert if capacity is low
    if (status.totalCapacity < 100) {
      console.log("[Scheduler] WARNING: Low sending capacity:", status.totalCapacity);
      
      await redis.lpush("alerts:dispatcher", JSON.stringify({
        type: "LOW_CAPACITY",
        timestamp: Date.now(),
        capacity: status.totalCapacity,
        message: `נותרה קיבולת נמוכה: ${status.totalCapacity} הודעות`
      }));
    }
    
    return status;
  } catch (err) {
    console.error("[Scheduler] Health check error:", err);
    return { error: err.message };
  }
}

/**
 * Start the scheduler
 */
function startScheduler() {
  if (schedulerRunning) {
    console.log("[Scheduler] Already running");
    return false;
  }
  
  console.log("[Scheduler] Starting warming scheduler...");
  schedulerRunning = true;
  
  // Midnight check - every 1 minute (lightweight check)
  intervals.midnight = setInterval(async () => {
    if (isAroundMidnight()) {
      await runMidnightTasks();
    }
  }, 60 * 1000);
  
  // Warmup pulse - every 30 minutes during business hours
  intervals.warmup = setInterval(async () => {
    const hour = new Date().getHours();
    if (hour >= 8 && hour <= 22) { // 8 AM - 10 PM
      await runWarmupPulse();
    }
  }, 30 * 60 * 1000);
  
  // Queue processor - every 1 minute
  intervals.queue = setInterval(runQueueProcessor, 60 * 1000);
  
  // Health check - every 5 minutes
  intervals.health = setInterval(runHealthCheck, 5 * 60 * 1000);
  
  // Run initial health check
  setTimeout(runHealthCheck, 5000);
  
  console.log("[Scheduler] Scheduler started with intervals:");
  console.log("  - Midnight check: every 1 min");
  console.log("  - Warmup pulse: every 30 min (8AM-10PM)");
  console.log("  - Queue processor: every 1 min");
  console.log("  - Health check: every 5 min");
  
  return true;
}

/**
 * Stop the scheduler
 */
function stopScheduler() {
  if (!schedulerRunning) {
    console.log("[Scheduler] Not running");
    return false;
  }
  
  console.log("[Scheduler] Stopping scheduler...");
  
  Object.values(intervals).forEach(interval => clearInterval(interval));
  intervals = {};
  schedulerRunning = false;
  
  console.log("[Scheduler] Scheduler stopped");
  return true;
}

/**
 * Get scheduler status
 */
async function getSchedulerStatus() {
  const redis = getRedis();
  
  const [lastMidnight, lastHealth] = await Promise.all([
    redis.get("scheduler:lastMidnightRun"),
    redis.lindex("scheduler:healthLog", 0)
  ]);
  
  return {
    running: schedulerRunning,
    lastMidnightRun: lastMidnight,
    lastHealthCheck: lastHealth ? JSON.parse(lastHealth) : null,
    intervals: {
      midnight: !!intervals.midnight,
      warmup: !!intervals.warmup,
      queue: !!intervals.queue,
      health: !!intervals.health
    }
  };
}

/**
 * Force run a specific task
 */
async function forceRunTask(taskName) {
  switch (taskName) {
    case "midnight":
      // Override the date check
      const redis = getRedis();
      await redis.del("scheduler:lastMidnightRun");
      return await runMidnightTasks();
    case "warmup":
      return await runWarmupPulse();
    case "queue":
      return await runQueueProcessor();
    case "health":
      return await runHealthCheck();
    default:
      return { error: "Unknown task: " + taskName };
  }
}

module.exports = {
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
  forceRunTask,
  runMidnightTasks,
  runWarmupPulse,
  runQueueProcessor,
  runHealthCheck
};


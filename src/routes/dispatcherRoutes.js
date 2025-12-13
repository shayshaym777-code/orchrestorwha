/**
 * Smart Dispatcher API Routes
 * 
 * Endpoints for session grading, warming, and smart message dispatch
 */

const express = require("express");
const { requireApiKey } = require("../middlewares/requireApiKey");
const {
  getSessionGradeInfo,
  getAllSessionsByGrade,
  canSessionSend,
  resetDailyCounters,
  updateAllTrustScores,
  DEFAULT_RAMP_SCHEDULE
} = require("../services/sessionGradingService");
const {
  MESSAGE_PRIORITY,
  dispatchMessage,
  distributeCampaign,
  executeCampaignPlan,
  getDispatcherStatus,
  processPendingQueue
} = require("../services/smartDispatcher");
const {
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
  forceRunTask
} = require("../services/warmingScheduler");
const { getRedis } = require("../infra/redis");

const router = express.Router();

// ============ Session Grading ============

/**
 * GET /api/dispatcher/sessions
 * Get all sessions grouped by grade
 */
router.get("/sessions", requireApiKey, async (req, res) => {
  try {
    const sessions = await getAllSessionsByGrade();
    return res.json({ status: "ok", data: sessions });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/dispatcher/sessions/:id/grade
 * Get grade info for specific session
 */
router.get("/sessions/:id/grade", requireApiKey, async (req, res) => {
  try {
    const info = await getSessionGradeInfo(req.params.id);
    return res.json({ status: "ok", data: info });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/dispatcher/sessions/:id/can-send
 * Check if session can send right now
 */
router.get("/sessions/:id/can-send", requireApiKey, async (req, res) => {
  try {
    const result = await canSessionSend(req.params.id);
    return res.json({ status: "ok", data: result });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

// ============ Dispatcher ============

/**
 * GET /api/dispatcher/status
 * Get dispatcher status and capacity
 */
router.get("/status", requireApiKey, async (req, res) => {
  try {
    const status = await getDispatcherStatus();
    return res.json({ status: "ok", data: status });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * POST /api/dispatcher/send
 * Send a single message through the smart dispatcher
 */
router.post("/send", requireApiKey, async (req, res) => {
  try {
    const { targetPhone, message, priority, preferredSessionId } = req.body;
    
    if (!targetPhone || !message) {
      return res.status(400).json({ 
        status: "error", 
        error: "Missing targetPhone or message" 
      });
    }
    
    const result = await dispatchMessage({
      targetPhone,
      message,
      priority: priority || MESSAGE_PRIORITY.NORMAL,
      preferredSessionId
    });
    
    return res.json({ status: "ok", data: result });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * POST /api/dispatcher/campaign/plan
 * Create a distribution plan for a campaign
 */
router.post("/campaign/plan", requireApiKey, async (req, res) => {
  try {
    const { campaignId, targets, message, priority } = req.body;
    
    if (!campaignId || !targets || !Array.isArray(targets)) {
      return res.status(400).json({ 
        status: "error", 
        error: "Missing campaignId or targets array" 
      });
    }
    
    const plan = await distributeCampaign({
      id: campaignId,
      targets,
      message,
      priority: priority || MESSAGE_PRIORITY.NORMAL
    });
    
    return res.json({ status: "ok", data: plan });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * POST /api/dispatcher/campaign/execute
 * Execute a campaign using its distribution plan
 */
router.post("/campaign/execute", requireApiKey, async (req, res) => {
  try {
    const { campaignId, targets, message } = req.body;
    
    if (!campaignId || !targets || !message) {
      return res.status(400).json({ 
        status: "error", 
        error: "Missing campaignId, targets, or message" 
      });
    }
    
    const result = await executeCampaignPlan(campaignId, targets, message);
    return res.json({ status: "ok", data: result });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * POST /api/dispatcher/queue/process
 * Manually trigger queue processing
 */
router.post("/queue/process", requireApiKey, async (req, res) => {
  try {
    const maxItems = parseInt(req.query.max) || 20;
    const results = await processPendingQueue(maxItems);
    return res.json({ 
      status: "ok", 
      data: { processed: results.length, results } 
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

// ============ Scheduler ============

/**
 * GET /api/dispatcher/scheduler/status
 * Get scheduler status
 */
router.get("/scheduler/status", requireApiKey, async (req, res) => {
  try {
    const status = await getSchedulerStatus();
    return res.json({ status: "ok", data: status });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * POST /api/dispatcher/scheduler/start
 * Start the warming scheduler
 */
router.post("/scheduler/start", requireApiKey, async (req, res) => {
  try {
    const started = startScheduler();
    return res.json({ 
      status: "ok", 
      data: { started, message: started ? "Scheduler started" : "Already running" } 
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * POST /api/dispatcher/scheduler/stop
 * Stop the warming scheduler
 */
router.post("/scheduler/stop", requireApiKey, async (req, res) => {
  try {
    const stopped = stopScheduler();
    return res.json({ 
      status: "ok", 
      data: { stopped, message: stopped ? "Scheduler stopped" : "Not running" } 
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * POST /api/dispatcher/scheduler/run/:task
 * Force run a specific scheduler task
 */
router.post("/scheduler/run/:task", requireApiKey, async (req, res) => {
  try {
    const result = await forceRunTask(req.params.task);
    return res.json({ status: "ok", data: result });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

// ============ Admin / Config ============

/**
 * POST /api/dispatcher/admin/reset-daily
 * Force reset daily counters (admin only)
 */
router.post("/admin/reset-daily", requireApiKey, async (req, res) => {
  try {
    const count = await resetDailyCounters();
    return res.json({ 
      status: "ok", 
      data: { resetCount: count, message: `Reset ${count} sessions` } 
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * POST /api/dispatcher/admin/update-scores
 * Force update trust scores (admin only)
 */
router.post("/admin/update-scores", requireApiKey, async (req, res) => {
  try {
    const results = await updateAllTrustScores();
    return res.json({ status: "ok", data: results });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/dispatcher/config/schedule
 * Get the ramp-up schedule
 */
router.get("/config/schedule", requireApiKey, async (req, res) => {
  try {
    const redis = getRedis();
    const customConfig = await redis.get("config:rampSchedule");
    
    const schedule = customConfig 
      ? JSON.parse(customConfig)
      : DEFAULT_RAMP_SCHEDULE;
    
    return res.json({ 
      status: "ok", 
      data: { 
        schedule, 
        isCustom: !!customConfig 
      } 
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * PUT /api/dispatcher/config/schedule
 * Update the ramp-up schedule
 */
router.put("/config/schedule", requireApiKey, async (req, res) => {
  try {
    const { schedule } = req.body;
    
    if (!schedule || typeof schedule !== 'object') {
      return res.status(400).json({ 
        status: "error", 
        error: "Invalid schedule format" 
      });
    }
    
    const redis = getRedis();
    await redis.set("config:rampSchedule", JSON.stringify(schedule));
    
    return res.json({ 
      status: "ok", 
      data: { schedule, message: "Schedule updated" } 
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * DELETE /api/dispatcher/config/schedule
 * Reset to default schedule
 */
router.delete("/config/schedule", requireApiKey, async (req, res) => {
  try {
    const redis = getRedis();
    await redis.del("config:rampSchedule");
    
    return res.json({ 
      status: "ok", 
      data: { schedule: DEFAULT_RAMP_SCHEDULE, message: "Reset to default" } 
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

module.exports = router;


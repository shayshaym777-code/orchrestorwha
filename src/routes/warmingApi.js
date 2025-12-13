/**
 * Warming API Routes
 * 
 * API endpoints for the Smart Warming Dispatcher system
 */

const express = require("express");
const { requireApiKey } = require("../middlewares/requireApiKey");
const warmingService = require("../services/warmingService");
const smartDispatcher = require("../services/smartDispatcher");
const cronService = require("../services/cronService");

const router = express.Router();

// ============ WARMING STATUS ============

/**
 * GET /api/warming/status
 * Get overall warming system status
 */
router.get("/status", requireApiKey, async (req, res) => {
  try {
    const config = await warmingService.getWarmingConfig();
    const queueStats = await smartDispatcher.getQueueStats();
    const cronStatus = cronService.getCronStatus();
    
    return res.json({
      status: "ok",
      data: {
        config,
        queue: queueStats,
        cron: cronStatus
      }
    });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * GET /api/warming/sessions
 * Get all sessions with their warming status
 */
router.get("/sessions", requireApiKey, async (req, res) => {
  try {
    const sessions = await warmingService.getSessionsForDispatch("cold");
    
    // Group by trust level
    const grouped = {
      hot: sessions.filter(s => s.trustLevel.level === 3),
      warming: sessions.filter(s => s.trustLevel.level === 2),
      cold: sessions.filter(s => s.trustLevel.level === 1)
    };
    
    // Calculate totals
    const totals = {
      total: sessions.length,
      available: sessions.filter(s => s.canSendNow).length,
      totalCapacity: sessions.reduce((sum, s) => sum + s.stats.remainingToday, 0),
      byLevel: {
        hot: grouped.hot.length,
        warming: grouped.warming.length,
        cold: grouped.cold.length
      }
    };
    
    return res.json({
      status: "ok",
      data: {
        totals,
        sessions: sessions.map(s => ({
          sessionId: s.sessionId,
          phone: s.phone,
          trustLevel: s.trustLevel,
          ageDays: s.ageDays,
          stats: s.stats,
          cooldown: s.cooldown,
          canSendNow: s.canSendNow,
          schedule: {
            day: s.schedule.day,
            maxMessages: s.schedule.maxMessages,
            delayRange: `${Math.floor(s.schedule.minDelayMs/1000)}-${Math.floor(s.schedule.maxDelayMs/1000)}s`
          }
        }))
      }
    });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * GET /api/warming/sessions/:id
 * Get warming status for a specific session
 */
router.get("/sessions/:id", requireApiKey, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const status = await warmingService.getSessionWarmingStatus(sessionId);
    
    if (!status) {
      return res.status(404).json({ status: "error", error: "Session not found" });
    }
    
    return res.json({ status: "ok", data: status });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

// ============ QUEUE MANAGEMENT ============

/**
 * GET /api/warming/queue
 * Get queue statistics
 */
router.get("/queue", requireApiKey, async (req, res) => {
  try {
    const stats = await smartDispatcher.getQueueStats();
    return res.json({ status: "ok", data: stats });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * POST /api/warming/queue/message
 * Add a single message to the queue
 */
router.post("/queue/message", requireApiKey, async (req, res) => {
  try {
    const { to, text, mediaUrl, priority, isWarmingMessage } = req.body;
    
    if (!to || !text) {
      return res.status(400).json({ status: "error", error: "Missing 'to' or 'text'" });
    }
    
    const entry = await smartDispatcher.enqueueMessage({
      to,
      text,
      mediaUrl,
      priority: priority || 5,
      isWarmingMessage: isWarmingMessage || false
    });
    
    return res.json({ status: "ok", data: entry });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * POST /api/warming/queue/campaign
 * Create a campaign with multiple recipients
 */
router.post("/queue/campaign", requireApiKey, async (req, res) => {
  try {
    const { recipients, text, mediaUrl } = req.body;
    
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ status: "error", error: "Missing or empty 'recipients' array" });
    }
    
    if (!text) {
      return res.status(400).json({ status: "error", error: "Missing 'text'" });
    }
    
    const campaign = await smartDispatcher.enqueueCampaign(recipients, { text, mediaUrl });
    
    return res.json({ status: "ok", data: campaign });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * GET /api/warming/queue/campaign/:id
 * Get campaign status
 */
router.get("/queue/campaign/:id", requireApiKey, async (req, res) => {
  try {
    const campaign = await smartDispatcher.getCampaignStatus(req.params.id);
    
    if (!campaign) {
      return res.status(404).json({ status: "error", error: "Campaign not found" });
    }
    
    return res.json({ status: "ok", data: campaign });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * POST /api/warming/queue/process
 * Manually trigger queue processing
 */
router.post("/queue/process", requireApiKey, async (req, res) => {
  try {
    const result = await smartDispatcher.processQueue();
    return res.json({ status: "ok", data: result });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * DELETE /api/warming/queue
 * Clear the message queue
 */
router.delete("/queue", requireApiKey, async (req, res) => {
  try {
    const result = await smartDispatcher.clearQueue();
    return res.json({ status: "ok", data: result });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * GET /api/warming/queue/sent
 * Get recent sent messages
 */
router.get("/queue/sent", requireApiKey, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await smartDispatcher.getRecentSent(limit);
    return res.json({ status: "ok", data: messages, count: messages.length });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * GET /api/warming/queue/failed
 * Get recent failed messages
 */
router.get("/queue/failed", requireApiKey, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await smartDispatcher.getRecentFailed(limit);
    return res.json({ status: "ok", data: messages, count: messages.length });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

// ============ DISTRIBUTION PLANNING ============

/**
 * POST /api/warming/plan
 * Plan distribution for a campaign without creating it
 */
router.post("/plan", requireApiKey, async (req, res) => {
  try {
    const { count } = req.body;
    
    if (!count || count < 1) {
      return res.status(400).json({ status: "error", error: "Missing or invalid 'count'" });
    }
    
    const distribution = await warmingService.planCampaignDistribution(count);
    
    return res.json({ status: "ok", data: distribution });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

// ============ CONFIGURATION ============

/**
 * GET /api/warming/config
 * Get warming configuration
 */
router.get("/config", requireApiKey, async (req, res) => {
  try {
    const config = await warmingService.getWarmingConfig();
    return res.json({ status: "ok", data: config });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * PUT /api/warming/config
 * Update warming configuration
 */
router.put("/config", requireApiKey, async (req, res) => {
  try {
    const config = req.body;
    const updated = await warmingService.updateWarmingConfig(config);
    return res.json({ status: "ok", data: updated });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * GET /api/warming/schedule
 * Get warming schedule table
 */
router.get("/schedule", requireApiKey, async (req, res) => {
  try {
    const config = await warmingService.getWarmingConfig();
    
    // Format schedule for display
    const schedule = Object.entries(config.schedule).map(([day, cfg]) => ({
      day: parseInt(day),
      trustLevel: parseInt(day) <= 2 ? "COLD" : parseInt(day) <= 6 ? "WARMING" : "HOT",
      maxMessages: cfg.maxMessages,
      minDelay: `${Math.floor(cfg.minDelayMs / 1000)}s`,
      maxDelay: `${Math.floor(cfg.maxDelayMs / 1000)}s`,
      delayRange: `${Math.floor(cfg.minDelayMs / 1000)}-${Math.floor(cfg.maxDelayMs / 1000)}s`
    }));
    
    return res.json({ status: "ok", data: schedule });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

// ============ CRON JOBS ============

/**
 * GET /api/warming/cron
 * Get CRON job status
 */
router.get("/cron", requireApiKey, async (req, res) => {
  try {
    const status = cronService.getCronStatus();
    return res.json({ status: "ok", data: status });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * POST /api/warming/cron/reset
 * Manually trigger daily reset
 */
router.post("/cron/reset", requireApiKey, async (req, res) => {
  try {
    const result = await cronService.triggerDailyReset();
    return res.json({ status: "ok", data: result });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

/**
 * POST /api/warming/cron/warming-pulse
 * Manually trigger warming pulse
 */
router.post("/cron/warming-pulse", requireApiKey, async (req, res) => {
  try {
    const result = await cronService.triggerWarmingPulse();
    return res.json({ status: "ok", data: result });
  } catch (error) {
    return res.status(500).json({ status: "error", error: error.message });
  }
});

module.exports = router;


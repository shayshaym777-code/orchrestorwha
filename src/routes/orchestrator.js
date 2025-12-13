const express = require("express");

const { requireApiKey } = require("../middlewares/requireApiKey");
const { requireWebhookSecret } = require("../middlewares/requireWebhookSecret");
const { uploadText } = require("../middlewares/uploadText");
const {
  uploadProfiles,
  uploadProxies,
  getStatus,
  restartSession,
  webhook,
  getQR,
  getSessionStatusHandler,
  getEventsHandler,
  getDashboard,
  getDashboardSessions,
  getDashboardAlerts,
  getDashboardSessionDetail,
  allocateSessionHandler,
  releaseSessionHandler,
  // Runner endpoints
  startSessionWorker,
  stopSessionWorker,
  restartSessionWorker,
  getSessionContainer,
  getSessionLogs,
  listWorkersHandler,
  provisionSession,
  // Proxy management
  markProxyBadHandler,
  markProxyOkHandler,
  getProxyHealthHandler,
  handleProxyBurnHandler,
  switchProxyHandler,
  // Watchdog
  getWatchdogStatusHandler,
  startWatchdogHandler,
  stopWatchdogHandler,
  // Outbox (Dispatcher -> Orchestrator -> Worker)
  enqueueOutboxHandler,
  claimOutboxHandler,
  ackOutboxHandler,
  nackOutboxHandler
} = require("../controllers/orchestratorController");

const router = express.Router();

// Admin endpoints (require API_KEY)
router.post("/upload/profiles", requireApiKey, uploadText.single("file"), uploadProfiles);
router.post("/upload/proxies", requireApiKey, uploadText.single("file"), uploadProxies);
router.get("/status", requireApiKey, getStatus);
router.post("/session/restart/:id", requireApiKey, restartSession);

// Worker -> Orchestrator webhook (uses WEBHOOK_SECRET, not API_KEY)
router.post("/api/webhook", requireWebhookSecret, webhook);

// Session info endpoints (require API_KEY)
router.get("/api/sessions/:id/qr", requireApiKey, getQR);
router.get("/api/sessions/:id/status", requireApiKey, getSessionStatusHandler);
router.get("/api/sessions/:id/events", requireApiKey, getEventsHandler);

// Dashboard endpoints (require API_KEY)
router.get("/api/dashboard", requireApiKey, getDashboard);
router.get("/api/dashboard/sessions", requireApiKey, getDashboardSessions);
router.get("/api/dashboard/alerts", requireApiKey, getDashboardAlerts);
router.get("/api/dashboard/session/:id", requireApiKey, getDashboardSessionDetail);

// Session allocation endpoints (require API_KEY)
router.post("/api/sessions/allocate", requireApiKey, allocateSessionHandler);
router.delete("/api/sessions/:id", requireApiKey, releaseSessionHandler);

// Runner endpoints (require API_KEY)
router.post("/api/sessions/provision", requireApiKey, provisionSession);  // Allocate + Start
router.post("/api/sessions/:id/start", requireApiKey, startSessionWorker);
router.post("/api/sessions/:id/stop", requireApiKey, stopSessionWorker);
router.post("/api/sessions/:id/restart", requireApiKey, restartSessionWorker);
router.get("/api/sessions/:id/container", requireApiKey, getSessionContainer);
router.get("/api/sessions/:id/logs", requireApiKey, getSessionLogs);
router.get("/api/workers", requireApiKey, listWorkersHandler);

// Dispatcher -> Orchestrator outbox enqueue (require API_KEY)
router.post("/api/sessions/:id/outbox/enqueue", requireApiKey, enqueueOutboxHandler);

// Worker -> Orchestrator task pulling (require WEBHOOK_SECRET)
router.post("/api/worker/sessions/:id/outbox/claim", requireWebhookSecret, claimOutboxHandler);
router.post("/api/worker/sessions/:id/outbox/ack", requireWebhookSecret, ackOutboxHandler);
router.post("/api/worker/sessions/:id/outbox/nack", requireWebhookSecret, nackOutboxHandler);

// Proxy management endpoints (require API_KEY)
router.post("/api/proxies/:id/bad", requireApiKey, markProxyBadHandler);
router.post("/api/proxies/:id/ok", requireApiKey, markProxyOkHandler);
router.get("/api/proxies/:id/health", requireApiKey, getProxyHealthHandler);
router.post("/api/proxies/:id/burn", requireApiKey, handleProxyBurnHandler);
router.post("/api/sessions/:id/switch-proxy", requireApiKey, switchProxyHandler);

// Watchdog endpoints (require API_KEY)
router.get("/api/watchdog/status", requireApiKey, getWatchdogStatusHandler);
router.post("/api/watchdog/start", requireApiKey, startWatchdogHandler);
router.post("/api/watchdog/stop", requireApiKey, stopWatchdogHandler);

// Message Logs endpoints (require API_KEY)
const logsService = require("../services/logsService");

router.get("/api/logs", requireApiKey, async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = await logsService.getLogs(limit);
  return res.json({ status: "ok", logs, count: logs.length });
});

router.get("/api/logs/stats", requireApiKey, async (_req, res) => {
  const stats = await logsService.getStats();
  return res.json({ status: "ok", stats });
});

router.delete("/api/logs", requireApiKey, async (_req, res) => {
  await logsService.clearLogs();
  return res.json({ status: "ok", message: "Logs cleared" });
});

// All events from all sessions combined (for live-log view)
const webhookService = require("../services/webhookService");
router.get("/api/events/all", requireApiKey, async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const type = req.query.type; // Optional filter
  
  // Get all sessions
  const { getRedis } = require("../infra/redis");
  const redis = getRedis();
  const sessionIds = (await redis.smembers("sessions:active")) || [];
  
  const allEvents = [];
  
  for (const sessionId of sessionIds) {
    const events = await webhookService.getEvents(sessionId, 50);
    const phone = await redis.hget(`session:${sessionId}`, "phone");
    
    events.forEach(e => {
      allEvents.push({
        ...e,
        sessionId,
        phone: phone || sessionId
      });
    });
  }
  
  // Sort by timestamp descending
  allEvents.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  
  // Filter by type if specified
  let filtered = allEvents;
  if (type && type !== 'all') {
    filtered = allEvents.filter(e => e.type === type || (e.type || '').includes(type));
  }
  
  return res.json({ 
    status: "ok", 
    events: filtered.slice(0, limit),
    total: filtered.length,
    sessions: sessionIds.length
  });
});

module.exports = router;



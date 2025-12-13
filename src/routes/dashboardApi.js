/**
 * Dashboard API - External Dashboard Data Provider
 * 
 * These endpoints provide all dashboard data as JSON
 * so external servers can display the dashboard UI
 * 
 * All endpoints require X-API-KEY header
 */

const express = require("express");
const { requireApiKey } = require("../middlewares/requireApiKey");
const { getRedis } = require("../infra/redis");
const { getSessionEvents, getSessionQR, getSessionStatus } = require("../services/webhookService");
const logsService = require("../services/logsService");
const { getSessionGradeInfo, getAllSessionsByGrade } = require("../services/sessionGradingService");
const { getDispatcherStatus } = require("../services/smartDispatcher");

const router = express.Router();

/**
 * GET /api/v1/dashboard/full
 * Returns complete dashboard data in one call
 */
router.get("/full", requireApiKey, async (req, res) => {
  try {
    const [stats, sessions, alerts, inventory, watchdog] = await Promise.all([
      getStats(),
      getSessions(),
      getAlerts(20),
      getInventory(),
      getWatchdogStatus()
    ]);

    return res.json({
      status: "ok",
      timestamp: Date.now(),
      data: {
        stats,
        sessions,
        alerts,
        inventory,
        watchdog
      }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/stats
 * Returns session statistics
 */
router.get("/stats", requireApiKey, async (req, res) => {
  try {
    const stats = await getStats();
    return res.json({ status: "ok", timestamp: Date.now(), data: stats });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/sessions
 * Returns all active sessions with details
 */
router.get("/sessions", requireApiKey, async (req, res) => {
  try {
    const sessions = await getSessions();
    return res.json({ status: "ok", timestamp: Date.now(), data: sessions });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/sessions/:id
 * Returns detailed info for a specific session
 */
router.get("/sessions/:id", requireApiKey, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = await getSessionDetail(sessionId);
    
    if (!session) {
      return res.status(404).json({ status: "error", error: "Session not found" });
    }
    
    return res.json({ status: "ok", timestamp: Date.now(), data: session });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/events
 * Returns all events from all sessions (for live log)
 */
router.get("/events", requireApiKey, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const type = req.query.type; // Optional filter: SENT, FAILED, CONNECTED, etc.
    const sessionId = req.query.session; // Optional filter by session
    
    const events = await getAllEvents(limit, type, sessionId);
    return res.json({ 
      status: "ok", 
      timestamp: Date.now(), 
      data: events,
      filters: { type, sessionId, limit }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/alerts
 * Returns system alerts
 */
router.get("/alerts", requireApiKey, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const alerts = await getAlerts(limit);
    return res.json({ status: "ok", timestamp: Date.now(), data: alerts });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/inventory
 * Returns profiles and proxies inventory
 */
router.get("/inventory", requireApiKey, async (req, res) => {
  try {
    const inventory = await getInventory();
    return res.json({ status: "ok", timestamp: Date.now(), data: inventory });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/logs
 * Returns message logs
 */
router.get("/logs", requireApiKey, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = await logsService.getLogs(limit);
    const stats = await logsService.getStats();
    
    return res.json({ 
      status: "ok", 
      timestamp: Date.now(), 
      data: { logs, stats }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/qr/:sessionId
 * Returns QR code for a session (base64)
 */
router.get("/qr/:sessionId", requireApiKey, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const qr = await getSessionQR(sessionId);
    
    if (!qr) {
      return res.status(404).json({ status: "error", error: "No QR available" });
    }
    
    return res.json({ 
      status: "ok", 
      timestamp: Date.now(), 
      data: { sessionId, qr }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/grading
 * Returns session grading info (Smart Warming System)
 */
router.get("/grading", requireApiKey, async (req, res) => {
  try {
    const sessionsByGrade = await getAllSessionsByGrade();
    const dispatcherStatus = await getDispatcherStatus();
    
    return res.json({ 
      status: "ok", 
      timestamp: Date.now(), 
      data: {
        sessions: sessionsByGrade,
        dispatcher: dispatcherStatus,
        summary: {
          hot: sessionsByGrade.hot.length,
          warming: sessionsByGrade.warming.length,
          cold: sessionsByGrade.cold.length,
          totalCapacity: dispatcherStatus.totalCapacity
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

/**
 * GET /api/v1/dashboard/sessions/:id/grading
 * Returns grading info for a specific session
 */
router.get("/sessions/:id/grading", requireApiKey, async (req, res) => {
  try {
    const gradeInfo = await getSessionGradeInfo(req.params.id);
    return res.json({ status: "ok", timestamp: Date.now(), data: gradeInfo });
  } catch (err) {
    return res.status(500).json({ status: "error", error: err.message });
  }
});

// ============ Helper Functions ============

async function getStats() {
  const redis = getRedis();
  const sessionIds = await redis.smembers("sessions:active") || [];
  
  let connected = 0;
  let waitingQR = 0;
  let failed = 0;
  let pending = 0;
  let reconnecting = 0;
  
  for (const id of sessionIds) {
    const status = await redis.hget(`session:${id}`, "status");
    switch (status) {
      case "CONNECTED": connected++; break;
      case "WAITING_QR": waitingQR++; break;
      case "ERROR": case "BANNED": case "RATE_LIMITED": failed++; break;
      case "PENDING": case "STARTING": pending++; break;
      case "RECONNECTING": reconnecting++; break;
    }
  }
  
  return {
    totalSessions: sessionIds.length,
    connected,
    reconnecting,
    waitingQR,
    failed,
    pending,
    healthy: connected + reconnecting,
    unhealthy: failed
  };
}

async function getSessions() {
  const redis = getRedis();
  const sessionIds = await redis.smembers("sessions:active") || [];
  const sessions = [];
  
  for (const id of sessionIds) {
    const data = await redis.hgetall(`session:${id}`);
    if (data) {
      // Get last event
      const events = await getSessionEvents(id, 1);
      const lastEvent = events[0] || null;
      
      sessions.push({
        sessionId: id,
        phone: data.phone || null,
        status: data.status || "UNKNOWN",
        profile: data.profileId || null,
        proxy: data.proxy ? maskProxy(data.proxy) : null,
        proxyIp: data.proxyIp || null,
        fingerprint: data.fingerprint || null,
        containerId: data.containerId || null,
        createdAt: parseInt(data.createdAt) || null,
        connectedAt: parseInt(data.connectedAt) || null,
        lastPing: parseInt(data.lastPing) || null,
        uptime: data.connectedAt ? Date.now() - parseInt(data.connectedAt) : null,
        messageCount: parseInt(data.messageCount) || 0,
        lastEvent: lastEvent ? {
          type: lastEvent.type,
          timestamp: lastEvent.timestamp
        } : null
      });
    }
  }
  
  // Sort by status priority
  const statusOrder = { CONNECTED: 1, WAITING_QR: 2, PENDING: 3, ERROR: 4, BANNED: 5 };
  sessions.sort((a, b) => (statusOrder[a.status] || 99) - (statusOrder[b.status] || 99));
  
  return sessions;
}

async function getSessionDetail(sessionId) {
  const redis = getRedis();
  const data = await redis.hgetall(`session:${sessionId}`);
  if (!data || Object.keys(data).length === 0) return null;
  
  // Get events
  const events = await getSessionEvents(sessionId, 50);
  
  // Get QR if waiting
  let qr = null;
  if (data.status === "WAITING_QR") {
    qr = await getSessionQR(sessionId);
  }
  
  return {
    sessionId,
    phone: data.phone || null,
    status: data.status || "UNKNOWN",
    profile: data.profileId || null,
    proxy: data.proxy ? maskProxy(data.proxy) : null,
    proxyIp: data.proxyIp || null,
    fingerprint: data.fingerprint || null,
    containerId: data.containerId || null,
    createdAt: parseInt(data.createdAt) || null,
    connectedAt: parseInt(data.connectedAt) || null,
    lastPing: parseInt(data.lastPing) || null,
    uptime: data.connectedAt ? Date.now() - parseInt(data.connectedAt) : null,
    messageCount: parseInt(data.messageCount) || 0,
    qr,
    events
  };
}

async function getAllEvents(limit, typeFilter, sessionFilter) {
  const redis = getRedis();
  let sessionIds;
  
  if (sessionFilter) {
    sessionIds = [sessionFilter];
  } else {
    sessionIds = await redis.smembers("sessions:active") || [];
  }
  
  const allEvents = [];
  
  for (const sessionId of sessionIds) {
    const events = await getSessionEvents(sessionId, 50);
    const phone = await redis.hget(`session:${sessionId}`, "phone");
    
    events.forEach(e => {
      allEvents.push({
        id: `${sessionId}-${e.timestamp}-${e.type}`,
        sessionId,
        phone: phone || sessionId,
        type: e.type,
        timestamp: e.timestamp,
        data: e.data,
        // Formatted fields for display
        icon: getEventIcon(e.type),
        color: getEventColor(e.type),
        message: formatEventMessage(e)
      });
    });
  }
  
  // Sort by timestamp descending
  allEvents.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  
  // Filter by type
  let filtered = allEvents;
  if (typeFilter && typeFilter !== "all") {
    filtered = allEvents.filter(e => 
      e.type === typeFilter || 
      (e.type || "").toUpperCase().includes(typeFilter.toUpperCase())
    );
  }
  
  return {
    events: filtered.slice(0, limit),
    total: filtered.length,
    sessions: sessionIds.length
  };
}

async function getAlerts(limit) {
  const redis = getRedis();
  const alerts = [];
  
  // Check for critical conditions
  const sessionIds = await redis.smembers("sessions:active") || [];
  
  for (const id of sessionIds) {
    const status = await redis.hget(`session:${id}`, "status");
    const lastPing = parseInt(await redis.hget(`session:${id}`, "lastPing") || "0");
    const phone = await redis.hget(`session:${id}`, "phone");
    
    // Stale session (no ping in 5 minutes)
    if (lastPing && Date.now() - lastPing > 5 * 60 * 1000) {
      alerts.push({
        id: `stale-${id}`,
        severity: "critical",
        type: "STALE_SESSION",
        sessionId: id,
        phone,
        message: `סשן ${phone || id} לא שולח Ping כבר ${Math.floor((Date.now() - lastPing) / 60000)} דקות`,
        timestamp: Date.now()
      });
    }
    
    // Error/Banned status
    if (status === "ERROR" || status === "BANNED") {
      alerts.push({
        id: `error-${id}`,
        severity: "critical",
        type: status,
        sessionId: id,
        phone,
        message: `סשן ${phone || id} בסטטוס ${status}`,
        timestamp: Date.now()
      });
    }
  }
  
  // Check proxy pool
  const availableProxies = (await redis.scard("proxies:available")) || 0;
  if (availableProxies < 5) {
    alerts.push({
      id: "low-proxies",
      severity: availableProxies === 0 ? "critical" : "warning",
      type: "LOW_PROXIES",
      message: `נותרו רק ${availableProxies} פרוקסי זמינים!`,
      timestamp: Date.now()
    });
  }
  
  // Check profile pool
  const availableProfiles = (await redis.scard("profiles:available")) || 0;
  if (availableProfiles < 3) {
    alerts.push({
      id: "low-profiles",
      severity: availableProfiles === 0 ? "critical" : "warning",
      type: "LOW_PROFILES",
      message: `נותרו רק ${availableProfiles} פרופילים זמינים!`,
      timestamp: Date.now()
    });
  }
  
  // Sort by severity and timestamp
  alerts.sort((a, b) => {
    if (a.severity === "critical" && b.severity !== "critical") return -1;
    if (a.severity !== "critical" && b.severity === "critical") return 1;
    return b.timestamp - a.timestamp;
  });
  
  return {
    alerts: alerts.slice(0, limit),
    total: alerts.length,
    critical: alerts.filter(a => a.severity === "critical").length,
    warning: alerts.filter(a => a.severity === "warning").length
  };
}

async function getInventory() {
  const redis = getRedis();
  const [proxiesAvailable, proxiesBad, profilesAvailable, profilesInUse] = await Promise.all([
    redis.scard("proxies:available"),
    redis.scard("proxies:bad"),
    redis.scard("profiles:available"),
    redis.scard("profiles:in_use")
  ]);
  
  return {
    proxies: {
      available: proxiesAvailable || 0,
      bad: proxiesBad || 0,
      total: (proxiesAvailable || 0) + (proxiesBad || 0)
    },
    profiles: {
      available: profilesAvailable || 0,
      inUse: profilesInUse || 0,
      total: (profilesAvailable || 0) + (profilesInUse || 0)
    }
  };
}

async function getWatchdogStatus() {
  const redis = getRedis();
  // Watchdog status would be stored in Redis or memory
  const watchdogRunning = await redis.get("watchdog:running");
  const lastCheck = await redis.get("watchdog:lastCheck");
  
  return {
    running: watchdogRunning === "true",
    lastCheck: parseInt(lastCheck) || null
  };
}

function maskProxy(proxy) {
  // Hide password in proxy string
  return proxy.replace(/:([^:]+)@/, ":***@");
}

function getEventIcon(type) {
  const icons = {
    CONNECTED: "🟢",
    QR_UPDATE: "📱",
    PING: "💓",
    MESSAGE_SENT: "✅",
    SENT: "✅",
    MESSAGE_FAILED: "❌",
    FAILED: "❌",
    MESSAGE_NOT_FOUND: "⚠️",
    NOT_FOUND: "⚠️",
    STATUS_CHANGE: "🔄",
    ERROR: "🔴",
    BANNED: "🚫",
    DISCONNECTED: "🔌"
  };
  return icons[type] || "📝";
}

function getEventColor(type) {
  const colors = {
    CONNECTED: "#00ff88",
    MESSAGE_SENT: "#00ff88",
    SENT: "#00ff88",
    MESSAGE_FAILED: "#ff4444",
    FAILED: "#ff4444",
    ERROR: "#ff4444",
    BANNED: "#ff4444",
    MESSAGE_NOT_FOUND: "#ffaa00",
    NOT_FOUND: "#ffaa00",
    STATUS_CHANGE: "#ffaa00",
    QR_UPDATE: "#00d4ff",
    PING: "#666666"
  };
  return colors[type] || "#888888";
}

function formatEventMessage(event) {
  const data = event.data || {};
  
  switch (event.type) {
    case "CONNECTED":
      return "התחבר בהצלחה";
    case "QR_UPDATE":
      return "QR Code עודכן";
    case "PING":
      return `Uptime: ${Math.floor((data.uptime || 0) / 1000)}s | Messages: ${data.messageCount || 0}`;
    case "STATUS_CHANGE":
      return `סטטוס: ${data.status || "unknown"}`;
    case "MESSAGE_SENT":
    case "SENT":
      return `נשלח ל: ${data.to || data.recipient || "?"}`;
    case "MESSAGE_FAILED":
    case "FAILED":
      return `נכשל: ${data.error || data.reason || "unknown"}`;
    case "MESSAGE_NOT_FOUND":
    case "NOT_FOUND":
      return `מספר לא קיים: ${data.number || data.to || "?"}`;
    case "ERROR":
      return `שגיאה: ${data.error || data.message || "unknown"}`;
    case "BANNED":
      return "החשבון נחסם!";
    case "DISCONNECTED":
      return "התנתק";
    default:
      return JSON.stringify(data).slice(0, 80);
  }
}

module.exports = router;


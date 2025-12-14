const { addProfilesFromText, addProxiesFromText, getInventoryStatus } = require("../services/inventoryService");
const { storeWebhookEvent, getSessionQR, getSessionStatus, getSessionEvents } = require("../services/webhookService");
const { 
  getActiveSessions, 
  getSession, 
  getCounters,
  allocateSession,
  releaseSession,
  SessionStatus,
  FailureReason
} = require("../services/sessionRegistry");
const { getAlertsSummary, getStoredAlerts } = require("../services/alertService");
const outboxService = require("../services/outboxService");
const { config } = require("../config");

async function uploadProfiles(req, res, next) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ status: "error", reason: "Missing file" });
    }
    const text = file.buffer.toString("utf8");
    const result = await addProfilesFromText(text);
    return res.status(200).json({ status: "ok", added: result.added });
  } catch (err) {
    return next(err);
  }
}

async function uploadProxies(req, res, next) {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ status: "error", reason: "Missing file" });
    }
    const text = file.buffer.toString("utf8");
    const result = await addProxiesFromText(text);
    return res.status(200).json({ status: "ok", added: result.added });
  } catch (err) {
    return next(err);
  }
}

async function getStatus(_req, res, next) {
  try {
    const inventory = await getInventoryStatus();
    // Minimal snapshot; extend with running containers, alerts, etc.
    return res.status(200).json({
      status: "ok",
      inventory,
      rules: {
        maxSessionsPerProxy: config.maxSessionsPerProxy,
        maxSessionsPerPhone: config.maxSessionsPerPhone
      }
    });
  } catch (err) {
    return next(err);
  }
}

async function restartSession(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });

    // Placeholder: implement docker restart / re-provisioning by bot id.
    return res.status(200).json({ status: "ok", restarted: id });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/webhook - Receive events from Worker containers
 */
async function webhook(req, res, next) {
  try {
    // Store webhook event in Redis (QR, status, events lists)
    const result = await storeWebhookEvent(req.body);
    
    // Update session registry based on event type
    const { processWebhookEvent } = require("../services/sessionRegistry");
    await processWebhookEvent(req.body);
    
    return res.status(200).json({ status: "ok", received: true, ...result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/sessions/:id/qr - Get QR code for a session
 */
async function getQR(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });

    const qr = await getSessionQR(id);
    if (!qr) {
      return res.status(404).json({ status: "error", reason: "No QR available" });
    }

    return res.status(200).json({ status: "ok", sessionId: id, qrCode: qr });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/sessions/:id/status - Get session status and meta
 */
async function getSessionStatusHandler(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });

    const { status, meta } = await getSessionStatus(id);
    
    return res.status(200).json({ 
      status: "ok", 
      sessionId: id, 
      sessionStatus: status || "UNKNOWN",
      meta: meta || {}
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/sessions/:id/events - Get session events
 */
async function getEventsHandler(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const events = await getSessionEvents(id, limit);
    
    return res.status(200).json({ 
      status: "ok", 
      sessionId: id, 
      events,
      count: events.length
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/dashboard - Main dashboard data
 */
async function getDashboard(req, res, next) {
  try {
    const [sessions, counters, inventory, alertsSummary] = await Promise.all([
      getActiveSessions(),
      getCounters(),
      getInventoryStatus(),
      getAlertsSummary()
    ]);
    
    // Calculate stats
    const stats = {
      totalSessions: sessions.length,
      connected: sessions.filter(s => s.status === SessionStatus.CONNECTED).length,
      waitingQR: sessions.filter(s => s.status === SessionStatus.WAITING_QR).length,
      reconnecting: sessions.filter(s => s.status === SessionStatus.RECONNECTING).length,
      failed: sessions.filter(s => [SessionStatus.ERROR, SessionStatus.BANNED, SessionStatus.LOGGED_OUT].includes(s.status)).length
    };
    
    // Proxy usage
    const proxyUsage = Object.entries(counters.proxyCounts).map(([id, count]) => ({
      proxyId: id.slice(-12), // Last 12 chars for display
      fullId: id,
      sessions: count,
      max: config.maxSessionsPerProxy,
      usage: Math.round((count / config.maxSessionsPerProxy) * 100)
    }));
    
    return res.status(200).json({
      status: "ok",
      timestamp: Date.now(),
      stats,
      proxyUsage,
      inventory,
      alerts: alertsSummary,
      rules: {
        maxSessionsPerProxy: config.maxSessionsPerProxy,
        maxSessionsPerPhone: config.maxSessionsPerPhone
      }
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/sessions/:id/outbox/enqueue - Enqueue a send task for a worker (Dispatcher -> Orchestrator)
 * Requires API_KEY.
 */
async function enqueueOutboxHandler(req, res, next) {
  try {
    const sessionId = String(req.params.id || "").trim();
    if (!sessionId) return res.status(400).json({ status: "error", reason: "Missing session id" });

    const body = req.body || {};
    const mode = body.mode;
    const to = typeof body.to === "string" ? body.to.trim() : "";

    if (!to) {
      return res.status(400).json({ status: "error", reason: "Missing to" });
    }
    if (mode !== "message" && mode !== "image") {
      return res.status(400).json({ status: "error", reason: "Invalid mode" });
    }
    if (mode === "message") {
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) return res.status(400).json({ status: "error", reason: "Missing text" });
    }
    if (mode === "image") {
      const mediaRef = typeof body.mediaRef === "string" ? body.mediaRef : "";
      if (!mediaRef) return res.status(400).json({ status: "error", reason: "Missing mediaRef" });
    }

    const payload = await outboxService.enqueueOutbox(sessionId, {
      mode,
      to,
      text: body.text,
      mediaRef: body.mediaRef,
      mediaPath: body.mediaPath,
      jobId: body.jobId,
      taskId: body.taskId
    });

    return res.status(200).json({ status: "ok", enqueued: true, sessionId, queuedAt: payload.queuedAt });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/worker/sessions/:id/outbox/claim - Worker long-poll for next task
 * Secured by WEBHOOK_SECRET (worker secret).
 */
async function claimOutboxHandler(req, res, next) {
  try {
    const sessionId = String(req.params.id || "").trim();
    if (!sessionId) return res.status(400).json({ status: "error", reason: "Missing session id" });

    const timeoutSeconds = Math.min(Math.max(Number(req.query.timeout) || 20, 1), 60);
    const claimed = await outboxService.claimOutbox(sessionId, { timeoutSeconds });
    if (!claimed) {
      return res.status(200).json({ status: "ok", task: null });
    }

    return res.status(200).json({ status: "ok", task: claimed.task, raw: claimed.raw });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/worker/sessions/:id/outbox/ack - Worker ack for a claimed task
 * Body: { raw: "<exact string returned from claim>" }
 */
async function ackOutboxHandler(req, res, next) {
  try {
    const sessionId = String(req.params.id || "").trim();
    if (!sessionId) return res.status(400).json({ status: "error", reason: "Missing session id" });

    const raw = typeof req.body?.raw === "string" ? req.body.raw : "";
    if (!raw) return res.status(400).json({ status: "error", reason: "Missing raw" });

    const removed = await outboxService.ackOutbox(sessionId, raw);
    return res.status(200).json({ status: "ok", ack: true, removed });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/worker/sessions/:id/outbox/nack - Worker nack/requeue for a claimed task
 * Body: { raw: "<exact string returned from claim>" }
 */
async function nackOutboxHandler(req, res, next) {
  try {
    const sessionId = String(req.params.id || "").trim();
    if (!sessionId) return res.status(400).json({ status: "error", reason: "Missing session id" });

    const raw = typeof req.body?.raw === "string" ? req.body.raw : "";
    if (!raw) return res.status(400).json({ status: "error", reason: "Missing raw" });

    await outboxService.nackOutbox(sessionId, raw);
    return res.status(200).json({ status: "ok", nack: true });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/dashboard/sessions - All sessions with details
 */
async function getDashboardSessions(req, res, next) {
  try {
    const sessions = await getActiveSessions();
    
    // Enrich with webhook data
    const enriched = await Promise.all(sessions.map(async (session) => {
      const webhookStatus = await getSessionStatus(session.sessionId);
      return {
        ...session,
        webhookMeta: webhookStatus.meta || {},
        lastSeen: webhookStatus.meta?.lastPing ? parseInt(webhookStatus.meta.lastPing) : null
      };
    }));
    
    // Sort by status priority
    const statusPriority = {
      [SessionStatus.BANNED]: 0,
      [SessionStatus.ERROR]: 1,
      [SessionStatus.LOGGED_OUT]: 2,
      [SessionStatus.RECONNECTING]: 3,
      [SessionStatus.WAITING_QR]: 4,
      [SessionStatus.CONNECTED]: 5,
      [SessionStatus.PENDING]: 6
    };
    
    enriched.sort((a, b) => {
      const pa = statusPriority[a.status] ?? 99;
      const pb = statusPriority[b.status] ?? 99;
      return pa - pb;
    });
    
    return res.status(200).json({
      status: "ok",
      count: enriched.length,
      sessions: enriched
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/dashboard/alerts - All alerts
 */
async function getDashboardAlerts(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const alerts = await getStoredAlerts(limit);
    const summary = await getAlertsSummary();
    
    return res.status(200).json({
      status: "ok",
      summary,
      alerts
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/dashboard/session/:id - Single session details
 */
async function getDashboardSessionDetail(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });
    
    const [session, qr, webhookStatus, events] = await Promise.all([
      getSession(id),
      getSessionQR(id),
      getSessionStatus(id),
      getSessionEvents(id, 50)
    ]);
    
    if (!session) {
      return res.status(404).json({ status: "error", reason: "Session not found" });
    }
    
    return res.status(200).json({
      status: "ok",
      session: {
        ...session,
        sessionId: id,
        qrCode: qr || null,
        webhookMeta: webhookStatus.meta || {},
        webhookStatus: webhookStatus.status
      },
      events,
      eventCount: events.length
    });
  } catch (err) {
    return next(err);
  }
}

// Runner service for Docker operations
const { 
  startWorker, 
  stopWorker, 
  restartWorker, 
  getWorkerStatus, 
  getWorkerLogs,
  listWorkers 
} = require("../services/runnerService");

// Watchdog service
const { 
  startWatchdog, 
  stopWatchdog, 
  getWatchdogStatus, 
  handleProxyBurn 
} = require("../services/watchdogService");

// Additional registry functions
const {
  markProxyBad,
  markProxyOk,
  getProxyHealth,
  switchSessionProxy
} = require("../services/sessionRegistry");

/**
 * POST /api/sessions/allocate - Allocate a new session
 * Body: { phone: "972...", sessionId?: "optional_custom_id" }
 */
async function allocateSessionHandler(req, res, next) {
  try {
    const { phone, sessionId: customSessionId } = req.body;
    
    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ status: "error", reason: "Missing phone" });
    }
    
    // Generate sessionId if not provided
    const sessionId = customSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    // Get available proxies from inventory
    const { getRedis } = require("../infra/redis");
    const redis = getRedis();
    const availableProxies = await redis.smembers('proxies:available');
    
    if (!availableProxies || availableProxies.length === 0) {
      return res.status(503).json({ 
        status: "error", 
        reason: "NO_PROXIES_AVAILABLE",
        message: "No proxies in inventory" 
      });
    }
    
    // Allocate session using registry
    const result = await allocateSession(phone, sessionId, availableProxies);
    
    if (!result.success) {
      return res.status(409).json({ 
        status: "error", 
        reason: result.reason,
        details: result 
      });
    }
    
    return res.status(201).json({
      status: "ok",
      sessionId: result.sessionId,
      phone,
      proxyId: result.proxyId,
      message: "Session allocated. Ready for docker run."
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/sessions/:id - Release a session
 */
async function releaseSessionHandler(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });
    
    const result = await releaseSession(id);
    
    if (!result.success) {
      return res.status(404).json({ status: "error", reason: result.reason });
    }
    
    return res.status(200).json({
      status: "ok",
      released: true,
      sessionId: id,
      phone: result.phone,
      proxy: result.proxy
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/sessions/:id/start - Start worker container for session
 */
async function startSessionWorker(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });
    
    const options = {
      webhookSecret: config.webhookSecret,
      sessionsPath: req.body.sessionsPath,
      enableApiServer: req.body.enableApiServer,
      disableSendDelay: req.body.disableSendDelay
    };
    
    const result = await startWorker(id, options);
    
    if (!result.success) {
      const statusCode = result.error === "SESSION_NOT_FOUND" ? 404 
        : result.error === "CONTAINER_ALREADY_RUNNING" ? 409 
        : 500;
      return res.status(statusCode).json({ status: "error", ...result });
    }
    
    return res.status(201).json({ status: "ok", ...result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/sessions/:id/stop - Stop worker container
 */
async function stopSessionWorker(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });
    
    const result = await stopWorker(id, {
      timeout: req.body.timeout,
      remove: req.body.remove
    });
    
    if (!result.success) {
      return res.status(500).json({ status: "error", ...result });
    }
    
    return res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/sessions/:id/restart - Restart worker container
 */
async function restartSessionWorker(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });
    
    const result = await restartWorker(id);
    
    if (!result.success) {
      return res.status(500).json({ status: "error", ...result });
    }
    
    return res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/sessions/:id/container - Get container status
 */
async function getSessionContainer(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });
    
    const result = await getWorkerStatus(id);
    
    return res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/sessions/:id/logs - Get container logs
 */
async function getSessionLogs(req, res, next) {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ status: "error", reason: "Missing id" });
    
    const tail = parseInt(req.query.tail) || 100;
    const logs = await getWorkerLogs(id, { tail });
    
    return res.status(200).json({ status: "ok", sessionId: id, logs });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/workers - List all worker containers
 */
async function listWorkersHandler(req, res, next) {
  try {
    const workers = await listWorkers();
    return res.status(200).json({ status: "ok", count: workers.length, workers });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/sessions/provision - Allocate + Use existing docker-compose worker
 * Body: { sessionId?: string, phone?: string, proxy?: string }
<<<<<<< HEAD
 * - sessionId: Optional custom session ID (if not provided, uses available worker_1/2/3)
 * - phone: Optional, will be "pending" until QR scan
=======
 * - sessionId: Optional custom session ID
 * - phone: Optional, will be unique placeholder until QR scan
>>>>>>> 4b32995c01a7a4b8268075a7b33c918a16224e1c
 * - proxy: Optional, manual proxy URL (socks5h://...)
 */
async function provisionSession(req, res, next) {
  try {
    const { phone, sessionId: customSessionId, sessionsPath, proxy: manualProxy } = req.body;
    
    // Phone is optional - generate unique placeholder for OBS/auto sessions
    const phoneValue = phone || `pending_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    
    const { getRedis } = require("../infra/redis");
    const redis = getRedis();
    
    // ✅ Step 1: Find available docker-compose worker (worker_1, worker_2, worker_3)
    const availableWorkers = ['worker_1', 'worker_2', 'worker_3'];
    let selectedWorkerId = customSessionId || null;
    
    if (!selectedWorkerId) {
      // Find first available worker (not already in use)
      for (const workerId of availableWorkers) {
        const existingSession = await redis.hgetall(`session:${workerId}`);
        // Check if worker is free (no session or status is STOPPED/LOGGED_OUT)
        if (!existingSession || Object.keys(existingSession).length === 0 || 
            existingSession.status === 'STOPPED' || existingSession.status === 'LOGGED_OUT') {
          selectedWorkerId = workerId;
          break;
        }
      }
      
      if (!selectedWorkerId) {
        return res.status(503).json({ 
          status: "error", 
          reason: "NO_WORKERS_AVAILABLE",
          message: "All workers (worker_1, worker_2, worker_3) are in use. Please wait or release a session."
        });
      }
    }
    
    // Step 2: Get proxy - either manual or from inventory
    let proxyToUse = manualProxy || null;
    let availableProxies = [];
    
    if (!proxyToUse) {
      // Try to get from inventory
      availableProxies = await redis.smembers('proxies:available') || [];
      if (availableProxies.length > 0) {
        proxyToUse = availableProxies[0];
      }
    }
    
    // Proxy is optional - worker can run without proxy
    // (but anti-ban will be less effective)
    
    // Step 3: Allocate session using worker ID as session ID
    const allocResult = await allocateSession(phoneValue, selectedWorkerId, availableProxies.length > 0 ? availableProxies : ['no-proxy']);
    
    if (!allocResult.success) {
      return res.status(409).json({ 
        status: "error", 
        reason: allocResult.reason,
        phase: "allocation"
      });
    }
    
    // Step 4: Store proxy info if manual
    if (manualProxy) {
      await redis.hset(`session:${selectedWorkerId}`, 'proxy', manualProxy);
      await redis.hset(`session:${selectedWorkerId}`, 'proxySource', 'manual');
    }
    
    // ✅ Step 5: Worker already exists in docker-compose - just register the session
    // The worker container (wa_worker_1, wa_worker_2, etc.) is already running
    // We just need to make sure the session is registered in Redis
    
    // Check if worker container is running
    const containerName = `wa_${selectedWorkerId}`;
    try {
      const docker = require("dockerode")();
      const container = docker.getContainer(containerName);
      const info = await container.inspect();
      
      if (!info.State.Running) {
        // Worker container exists but not running - start it
        await container.start();
      }
    } catch (e) {
      // Container doesn't exist - that's OK, docker-compose will start it
      console.log(`[Provision] Worker container ${containerName} will be managed by docker-compose`);
    }
    
    return res.status(201).json({
      status: "ok",
      sessionId: selectedWorkerId,
      phone: phoneValue,
      proxyId: allocResult.proxyId || null,
      proxy: proxyToUse ? "configured" : "none",
      containerName: containerName,
      message: `Session allocated to existing worker: ${selectedWorkerId}`
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/proxies/:id/bad - Mark proxy as BAD
 */
async function markProxyBadHandler(req, res, next) {
  try {
    const proxyId = decodeURIComponent(req.params.id || "");
    if (!proxyId) return res.status(400).json({ status: "error", reason: "Missing proxyId" });
    
    const reason = req.body.reason || "MANUAL";
    const cooldownMs = req.body.cooldownMs || 30 * 60 * 1000;
    
    await markProxyBad(proxyId, reason, cooldownMs);
    
    return res.status(200).json({ 
      status: "ok", 
      proxyId,
      markedBad: true,
      reason,
      cooldownMs
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/proxies/:id/ok - Mark proxy as OK
 */
async function markProxyOkHandler(req, res, next) {
  try {
    const proxyId = decodeURIComponent(req.params.id || "");
    if (!proxyId) return res.status(400).json({ status: "error", reason: "Missing proxyId" });
    
    await markProxyOk(proxyId);
    
    return res.status(200).json({ 
      status: "ok", 
      proxyId,
      markedOk: true
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/proxies/:id/health - Get proxy health
 */
async function getProxyHealthHandler(req, res, next) {
  try {
    const proxyId = decodeURIComponent(req.params.id || "");
    if (!proxyId) return res.status(400).json({ status: "error", reason: "Missing proxyId" });
    
    const health = await getProxyHealth(proxyId);
    
    return res.status(200).json({ status: "ok", ...health });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/proxies/:id/burn - Handle proxy burn (migrate sessions)
 */
async function handleProxyBurnHandler(req, res, next) {
  try {
    const proxyId = decodeURIComponent(req.params.id || "");
    if (!proxyId) return res.status(400).json({ status: "error", reason: "Missing proxyId" });
    
    const reason = req.body.reason || "BURNED";
    const result = await handleProxyBurn(proxyId, reason);
    
    return res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/sessions/:id/switch-proxy - Switch session to new proxy
 */
async function switchProxyHandler(req, res, next) {
  try {
    const sessionId = req.params.id;
    const newProxyId = req.body.newProxyId;
    
    if (!sessionId) return res.status(400).json({ status: "error", reason: "Missing sessionId" });
    if (!newProxyId) return res.status(400).json({ status: "error", reason: "Missing newProxyId" });
    
    const result = await switchSessionProxy(sessionId, newProxyId);
    
    if (!result.success) {
      return res.status(404).json({ status: "error", ...result });
    }
    
    return res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/watchdog/status - Get watchdog status
 */
async function getWatchdogStatusHandler(req, res, next) {
  try {
    const status = getWatchdogStatus();
    return res.status(200).json({ status: "ok", watchdog: status });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/watchdog/start - Start watchdog
 */
async function startWatchdogHandler(req, res, next) {
  try {
    startWatchdog();
    return res.status(200).json({ status: "ok", message: "Watchdog started" });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/watchdog/stop - Stop watchdog
 */
async function stopWatchdogHandler(req, res, next) {
  try {
    stopWatchdog();
    return res.status(200).json({ status: "ok", message: "Watchdog stopped" });
  } catch (err) {
    return next(err);
  }
}

module.exports = { 
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
};



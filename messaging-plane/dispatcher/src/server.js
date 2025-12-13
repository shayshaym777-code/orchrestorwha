/**
 * WhatsApp Message Dispatcher
 * 
 * Reads messages from queue and dispatches them with:
 * - Anti-ban pacing (rate limiting per session)
 * - Jitter/randomization
 * - Session routing
 * - Retry handling
 * - Per-session queues (queue:session:<phone>) to avoid one slow session blocking others
 * - Future: routing to non-Baileys providers
 */

require("dotenv").config();
const express = require("express");
const Redis = require("ioredis");
const axios = require("axios");
const { SessionPacer } = require("./pacer");
const { selectSession } = require("./router");

const app = express();
app.use(express.json());

// ===========================================
// CONFIGURATION
// ===========================================

const config = {
  port: Number(process.env.PORT || 4001),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  
  // Orchestrator connection
  orchestratorUrl: process.env.ORCHESTRATOR_URL || "http://localhost:3000",
  orchestratorApiKey: process.env.ORCHESTRATOR_API_KEY || "",
  sendMode: process.env.SEND_MODE || "api",
  
  // Queue settings
  gatewayQueueKey: process.env.GATEWAY_QUEUE_KEY || "gateway:jobs",
  priorityQueueKey: process.env.PRIORITY_QUEUE_KEY || "queue:priority",
  sessionQueuePrefix: process.env.SESSION_QUEUE_PREFIX || "queue:session:",
  
  // Pacing settings
  defaultMinDelayMs: Number(process.env.DEFAULT_MIN_DELAY_MS || 2000),
  defaultMaxDelayMs: Number(process.env.DEFAULT_MAX_DELAY_MS || 5000),
  burstLimit: Number(process.env.BURST_LIMIT || 5), // Messages before forced delay
  burstCooldownMs: Number(process.env.BURST_COOLDOWN_MS || 30000), // 30 seconds
  
  // Processing
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS || 10),
  
  // Retry
  maxRetries: Number(process.env.MAX_RETRIES || 3),
  retryDelayMs: Number(process.env.RETRY_DELAY_MS || 60000), // 1 minute

  // SmartGuard (auto anti-ban tuning)
  smartGuardEnabledByDefault: (process.env.SMART_GUARD_ENABLED || "true") === "true",
  smartGuardTickMs: Number(process.env.SMART_GUARD_TICK_MS || 10000),

  // Optional Session Brain (Python) URL
  sessionBrainUrl: process.env.SESSION_BRAIN_URL || "",

  // Job tracking
  jobStatsTtlSeconds: Number(process.env.JOB_STATS_TTL_SECONDS || 86400),
};

// ===========================================
// REDIS CONNECTION
// ===========================================

const redis = new Redis(config.redisUrl, {
  family: 4,
  connectTimeout: 2000,
  maxRetriesPerRequest: 1,
  retryDelayOnFailover: 100,
  enableReadyCheck: true,
  enableOfflineQueue: false,
});

redis.on("connect", () => console.log("[Dispatcher] Redis connected"));
redis.on("error", (err) => console.error("[Dispatcher] Redis error:", err.message));

// IMPORTANT: Use a dedicated Redis connection for blocking commands (BRPOP),
// otherwise it will block the shared connection and freeze metrics endpoints.
const redisBlocking = new Redis(config.redisUrl, {
  family: 4,
  connectTimeout: 2000,
  maxRetriesPerRequest: 1,
  retryDelayOnFailover: 100,
  enableReadyCheck: true,
  enableOfflineQueue: false,
});

redisBlocking.on("connect", () => console.log("[Dispatcher] Redis(blocking) connected"));
redisBlocking.on("error", (err) => console.error("[Dispatcher] Redis(blocking) error:", err.message));

// ===========================================
// STATE
// ===========================================

let isRunning = false;
let processedCount = 0;
let failedCount = 0;
let routedCount = 0;
const sessionPacers = new Map(); // sessionId -> SessionPacer
const sessionConsumers = new Map(); // sessionId -> { running: boolean, stop: fn }
let sessionsCache = { ts: 0, sessions: [] };

// ===========================================
// SMARTGUARD (incident log + auto-tune)
// ===========================================

const INCIDENTS_KEY = "antiban:incidents";
let smartGuardTimer = null;

async function pushIncident(incident) {
  try {
    const payload = JSON.stringify({ ...incident, ts: incident.ts || Date.now() });
    await redis.lpush(INCIDENTS_KEY, payload);
    await redis.ltrim(INCIDENTS_KEY, 0, 199); // keep last 200
    await redis.expire(INCIDENTS_KEY, 7 * 24 * 3600); // 7 days
  } catch {
    // ignore
  }
}

async function sendBrainEvent(event) {
  const base = (config.sessionBrainUrl || "").trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    await fetch(`${base}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event)
    });
  } catch {
    // ignore
  }
}

async function getSmartGuardEnabled() {
  const raw = await redis.get("config:smartguard:enabled");
  if (raw === null) return config.smartGuardEnabledByDefault;
  return raw === "true";
}

function clampToAllowedRpm(n) {
  const allowed = [5, 10, 15, 20];
  if (!Number.isFinite(n)) return null;
  // pick nearest allowed
  let best = allowed[0];
  let bestDiff = Math.abs(n - best);
  for (const a of allowed) {
    const d = Math.abs(n - a);
    if (d < bestDiff) {
      best = a;
      bestDiff = d;
    }
  }
  return best;
}

function lowerRpm(current) {
  const ladder = [20, 15, 10, 5];
  const idx = ladder.indexOf(current);
  if (idx < 0) return 10;
  return ladder[Math.min(idx + 1, ladder.length - 1)];
}

function higherRpm(current) {
  const ladder = [5, 10, 15, 20];
  const idx = ladder.indexOf(current);
  if (idx < 0) return 10;
  return ladder[Math.min(idx + 1, ladder.length - 1)];
}

async function recordSessionMetricFailed(sessionId) {
  const key = `metrics:session:${sessionId}:failed60s`;
  await redis.incr(key);
  await redis.expire(key, 60);
}

async function smartGuardTick() {
  const enabled = await getSmartGuardEnabled();
  await redis.set("smartguard:lastTick", String(Date.now()));
  if (!enabled || !isRunning) return;

  try {
    const sessions = await getAvailableSessionsCached();
    const connected = sessions.filter(s => s.status === "CONNECTED" && s.sessionId && s.phone);

    for (const s of connected) {
      const sessionId = s.sessionId;
      const phone = s.phone;
      const qlen = await redis.llen(sessionQueueKeyByPhone(phone));
      const sent60s = Number(await redis.get(`metrics:session:${sessionId}:sent60s`) || 0);
      const routed60s = Number(await redis.get(`metrics:session:${sessionId}:routed60s`) || 0);
      const failed60s = Number(await redis.get(`metrics:session:${sessionId}:failed60s`) || 0);
      const overrideRaw = await redis.get(`config:session:${sessionId}:rpm`);
      const override = overrideRaw ? Number(overrideRaw) : null;
      const policy = trustPolicyForSession(s);
      const base = clampToAllowedRpm(policy.rpm || 10) || 10;

      // Determine current target rpm
      const current = clampToAllowedRpm(Number.isFinite(override) ? override : base) || 10;

      // Heuristics:
      // - If failures spike => slow down
      // - If stable (no failures) + low backlog => allow returning upward (but never exceed base)
      let next = current;
      let reason = null;

      if (failed60s >= 3) {
        next = lowerRpm(current);
        reason = `FAILED_SPIKE failed60s=${failed60s}`;
      } else if (failed60s === 0 && qlen <= 2 && sent60s > 0) {
        next = higherRpm(current);
        reason = `STABLE`;
      }

      // never exceed base trust rpm
      if (next > base) next = base;

      if (next !== current && reason) {
        await redis.set(`config:session:${sessionId}:rpm`, String(next));
        await redis.set("smartguard:lastActionAt", String(Date.now()));
        await pushIncident({
          type: "SMART_GUARD_RPM_CHANGE",
          sessionId,
          phone,
          action: { from: current, to: next },
          metrics: { qlen, sent60s, routed60s, failed60s, base },
          reason
        });
      }
    }
  } catch (e) {
    await pushIncident({ type: "SMART_GUARD_ERROR", reason: e?.message || String(e) });
  }
}

let smartGuardInFlight = false;

function startSmartGuard() {
  if (smartGuardTimer) return;
  smartGuardTimer = setInterval(async () => {
    if (smartGuardInFlight) return;
    smartGuardInFlight = true;
    try {
      await smartGuardTick();
    } finally {
      smartGuardInFlight = false;
    }
  }, Math.max(2000, config.smartGuardTickMs));
}

function stopSmartGuard() {
  if (!smartGuardTimer) return;
  clearInterval(smartGuardTimer);
  smartGuardTimer = null;
}

// ===========================================
// ORCHESTRATOR CLIENT
// ===========================================

const orchestratorClient = axios.create({
  baseURL: config.orchestratorUrl,
  timeout: 30000,
  headers: {
    "X-API-Key": config.orchestratorApiKey,
    "Content-Type": "application/json"
  }
});

/**
 * Get available sessions from Orchestrator
 */
async function getAvailableSessions() {
  try {
    const response = await orchestratorClient.get("/api/dashboard/sessions");
    if (response.data.status === "ok") {
      // Filter to only CONNECTED sessions
      return response.data.sessions.filter(s => s.status === "CONNECTED");
    }
    return [];
  } catch (err) {
    console.error("[Dispatcher] Failed to get sessions:", err.message);
    return [];
  }
}

/**
 * Cached sessions (avoid calling Orchestrator on every message)
 */
async function getAvailableSessionsCached(ttlMs = 5000) {
  const now = Date.now();
  if (sessionsCache.sessions.length > 0 && now - sessionsCache.ts < ttlMs) {
    return sessionsCache.sessions;
  }
  const sessions = await getAvailableSessions();
  sessionsCache = { ts: now, sessions };
  return sessions;
}

function sessionQueueKeyByPhone(phone) {
  return `${config.sessionQueuePrefix}${phone}`;
}

function clampNumber(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Trust -> pacing policy (days since createdAt)
 * Based on your spec table; also supports manual RPM overrides via /sessions/:id/rpm.
 */
function trustPolicyForSession(session) {
  const createdAt = Number(session.createdAt || 0);
  const days = createdAt > 0 ? (Date.now() - createdAt) / (24 * 60 * 60 * 1000) : 0;

  // Defaults from the spec (approximate human-like windows)
  if (days < 3) {
    return { trustLevel: 1, minDelayMs: 20000, maxDelayMs: 40000, rpm: 3 };
  }
  if (days < 7) {
    return { trustLevel: 2, minDelayMs: 10000, maxDelayMs: 15000, rpm: 5 };
  }
  if (days < 14) {
    return { trustLevel: 3, minDelayMs: 5000, maxDelayMs: 8000, rpm: 10 };
  }
  return { trustLevel: 4, minDelayMs: 2000, maxDelayMs: 4000, rpm: 20 };
}

/**
 * Send message via Orchestrator/Worker
 */
async function sendViaOrchestrator(sessionId, message) {
  try {
    // Get session details
    const sessionResp = await orchestratorClient.get(`/api/dashboard/session/${sessionId}`);
    if (sessionResp.data.status !== "ok") {
      throw new Error("Session not found");
    }
    
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (config.sendMode === "api") {
      // Enqueue via Orchestrator API (best for Dispatcher on separate VPS)
      await orchestratorClient.post(`/api/sessions/${sessionId}/outbox/enqueue`, {
        ...message,
        messageId
      });
      return { success: true, messageId, sessionId };
    }

    // Fallback: write directly to Redis (requires shared Redis access)
    await redis.lpush(`session:outbox:${sessionId}`, JSON.stringify({
      messageId,
      ...message,
      queuedAt: Date.now()
    }));
    await redis.expire(`session:outbox:${sessionId}`, 3600);
    return { success: true, messageId, sessionId };
    
  } catch (err) {
    console.error(`[Dispatcher] Send failed for session ${sessionId}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ===========================================
// JOB PROCESSING
// ===========================================

/**
 * Get or create pacer for a session
 */
function getPacer(sessionId, sessionMeta) {
  if (!sessionPacers.has(sessionId)) {
    const policy = sessionMeta ? trustPolicyForSession(sessionMeta) : null;
    sessionPacers.set(sessionId, new SessionPacer({
      sessionId,
      minDelayMs: policy?.minDelayMs ?? config.defaultMinDelayMs,
      maxDelayMs: policy?.maxDelayMs ?? config.defaultMaxDelayMs,
      burstLimit: config.burstLimit,
      burstCooldownMs: config.burstCooldownMs,
    }));
  }
  return sessionPacers.get(sessionId);
}

/**
 * Route a Gateway job into per-session queues.
 * Gateway job shape: { jobId, mode, message?, mediaRef?, mediaPath?, contacts:[{name,phone}], createdAt, status }
 */
async function routeGatewayJob(jobId) {
  try {
    // Get job data
    const jobData = await redis.get(`job:${jobId}`);
    if (!jobData) {
      console.log(`[Dispatcher] Job ${jobId} not found (expired?)`);
      return { success: false, reason: "JOB_NOT_FOUND" };
    }
    
    const job = JSON.parse(jobData);
    
    // Validate minimal required fields
    if (!Array.isArray(job.contacts) || job.contacts.length === 0) {
      job.status = "FAILED";
      job.failedAt = Date.now();
      job.lastError = "INVALID_CONTACTS";
      await redis.set(`job:${jobId}`, JSON.stringify(job), "KEEPTTL");
      failedCount++;
      return { success: false, reason: "INVALID_CONTACTS" };
    }
    if (job.mode !== "message" && job.mode !== "image") {
      job.status = "FAILED";
      job.failedAt = Date.now();
      job.lastError = "INVALID_MODE";
      await redis.set(`job:${jobId}`, JSON.stringify(job), "KEEPTTL");
      failedCount++;
      return { success: false, reason: "INVALID_MODE" };
    }
    if (job.mode === "message" && (!job.message || typeof job.message !== "string")) {
      job.status = "FAILED";
      job.failedAt = Date.now();
      job.lastError = "INVALID_MESSAGE";
      await redis.set(`job:${jobId}`, JSON.stringify(job), "KEEPTTL");
      failedCount++;
      return { success: false, reason: "INVALID_MESSAGE" };
    }
    if (job.mode === "image" && (!job.mediaRef || typeof job.mediaRef !== "string")) {
      job.status = "FAILED";
      job.failedAt = Date.now();
      job.lastError = "INVALID_MEDIA_REF";
      await redis.set(`job:${jobId}`, JSON.stringify(job), "KEEPTTL");
      failedCount++;
      return { success: false, reason: "INVALID_MEDIA_REF" };
    }

    // Update job status to ROUTING (we are not "sending" here; sending is per-session consumer)
    job.status = "ROUTING";
    job.routedAt = Date.now();
    await redis.set(`job:${jobId}`, JSON.stringify(job), "KEEPTTL");

    // Initialize per-job counters (idempotent)
    const total = job.contacts.length;
    await redis.set(`job:stats:${jobId}:total`, String(total), "EX", config.jobStatsTtlSeconds, "NX");
    await redis.set(`job:stats:${jobId}:sent`, "0", "EX", config.jobStatsTtlSeconds, "NX");
    await redis.set(`job:stats:${jobId}:failed`, "0", "EX", config.jobStatsTtlSeconds, "NX");
    
    // Get sessions once and route each contact to a session queue
    const sessions = await getAvailableSessionsCached();
    if (sessions.length === 0) {
      // No sessions available - requeue (leave job in QUEUED)
      console.log(`[Dispatcher] No sessions available, requeue gateway job ${jobId}`);
      job.status = "QUEUED";
      job.lastError = "NO_SESSIONS_AVAILABLE";
      await redis.set(`job:${jobId}`, JSON.stringify(job), "KEEPTTL");

      // Delay retry to avoid hot-looping when the fleet is down.
      const nextRetryAt = Date.now() + clampNumber(config.retryDelayMs, 1000, 10 * 60 * 1000);
      await redis.zadd("queue:retry", nextRetryAt, jobId);
      return { success: false, reason: "NO_SESSIONS" };
    }
    
    // Route each contact to a selected session's queue
    const routed = [];
    for (let i = 0; i < job.contacts.length; i++) {
      const contact = job.contacts[i];
      const to = String(contact.phone || "").trim();
      if (!to) continue;

      // Router expects job.message.to for sticky routing
      const routingJob = { message: { to } };
      const selectedSession = selectSession(sessions, routingJob, { strategy: "sticky" });
      const phone = selectedSession.phone;
      if (!phone) {
        continue;
      }

      const task = {
        taskId: `${jobId}:${i}`,
        jobId,
        mode: job.mode,
        to,
        name: contact.name,
        text: job.mode === "message" ? job.message : undefined,
        mediaRef: job.mode === "image" ? job.mediaRef : undefined,
        mediaPath: job.mode === "image" ? job.mediaPath : undefined,
        createdAt: Date.now(),
        retryCount: 0
      };

      const key = sessionQueueKeyByPhone(phone);
      await redis.lpush(key, JSON.stringify(task));
      // keep a rolling TTL on session queues so stale systems don't grow forever
      await redis.expire(key, 24 * 3600);
      await recordSessionMetricRouted(selectedSession.sessionId);

      routed.push({ to, sessionId: selectedSession.sessionId, phone });
    }

    job.status = "ROUTED";
    job.routedAt = Date.now();
    job.routedCount = routed.length;
    await redis.set(`job:${jobId}`, JSON.stringify(job), "KEEPTTL");

    routedCount += routed.length;
    console.log(`[Dispatcher] 📤 Routed gateway job ${jobId} -> ${routed.length} per-session tasks`);
    return { success: true, jobId, routed: routed.length };
    
  } catch (err) {
    console.error(`[Dispatcher] Error routing gateway job ${jobId}:`, err.message);
    return { success: false, reason: "ROUTING_ERROR", error: err.message };
  }
}

/**
 * Process retry queue (jobs that need to be retried)
 */
async function processRetryQueue() {
  try {
    const now = Date.now();
    
    // Get jobs that are due for retry
    const dueJobs = await redis.zrangebyscore("queue:retry", 0, now, "LIMIT", 0, 10);
    
    for (const jobId of dueJobs) {
      // Remove from retry queue
      await redis.zrem("queue:retry", jobId);
      
      // Add back to gateway queue
      await redis.lpush(config.gatewayQueueKey, jobId);
      
      console.log(`[Dispatcher] Moved ${jobId} from retry to main queue`);
    }
    
  } catch (err) {
    console.error("[Dispatcher] Error processing retry queue:", err.message);
  }
}

/**
 * Main processing loop
 */
async function processLoop() {
  if (!isRunning) return;
  
  try {
    // Process retry queue first
    await processRetryQueue();
    
    // Check priority queue first, then gateway queue
    let jobId = await redis.rpop(config.priorityQueueKey);
    
    if (!jobId) {
      jobId = await redis.rpop(config.gatewayQueueKey);
    }
    
    if (jobId) {
      await routeGatewayJob(jobId);
    }
    
  } catch (err) {
    console.error("[Dispatcher] Loop error:", err.message);
  }
  
  // Schedule next iteration
  setTimeout(processLoop, config.pollIntervalMs);
}

async function maybeFinalizeJob(jobId) {
  if (!jobId) return null;
  const [totalRaw, sentRaw, failedRaw] = await Promise.all([
    redis.get(`job:stats:${jobId}:total`),
    redis.get(`job:stats:${jobId}:sent`),
    redis.get(`job:stats:${jobId}:failed`)
  ]);
  const total = Number(totalRaw || 0);
  const sent = Number(sentRaw || 0);
  const failed = Number(failedRaw || 0);
  if (!total) return null;
  if (sent + failed < total) return null;

  // prevent duplicate finalization
  const doneKey = `job:stats:${jobId}:doneEmitted`;
  const ok = await redis.set(doneKey, "1", "EX", config.jobStatsTtlSeconds, "NX");
  if (ok !== "OK") return null;

  // Update job object for dashboards (best-effort)
  try {
    const jobData = await redis.get(`job:${jobId}`);
    if (jobData) {
      const job = JSON.parse(jobData);
      job.status = failed > 0 ? "DONE_WITH_ERRORS" : "DONE";
      job.doneAt = Date.now();
      job.sentCount = sent;
      job.failedCount = failed;
      await redis.set(`job:${jobId}`, JSON.stringify(job), "KEEPTTL");
    }
  } catch {
    // ignore
  }

  // Emit event for Telegram bridge
  await redis.lpush(
    "jobs:events",
    JSON.stringify({
      ts: Date.now(),
      type: "JOB_DONE",
      jobId,
      total,
      sent,
      failed,
      status: failed > 0 ? "DONE_WITH_ERRORS" : "DONE"
    })
  );
  await redis.ltrim("jobs:events", 0, 1999);
  return { total, sent, failed };
}

/**
 * Start the dispatcher
 */
function startDispatcher() {
  if (isRunning) {
    console.log("[Dispatcher] Already running");
    return;
  }
  
  isRunning = true;
  console.log("[Dispatcher] Starting message processing...");
  startSmartGuard();
  processLoop();
}

/**
 * Stop the dispatcher
 */
function stopDispatcher() {
  isRunning = false;
  console.log("[Dispatcher] Stopping message processing...");
  stopSmartGuard();
}

// ===========================================
// PER-SESSION CONSUMERS (anti-ban queues)
// ===========================================

async function recordSessionMetricSent(sessionId) {
  const key = `metrics:session:${sessionId}:sent60s`;
  await redis.incr(key);
  await redis.expire(key, 60);
}

async function recordSessionMetricRouted(sessionId) {
  const key = `metrics:session:${sessionId}:routed60s`;
  await redis.incr(key);
  await redis.expire(key, 60);
}

async function getSessionRpmOverride(sessionId) {
  const raw = await redis.get(`config:session:${sessionId}:rpm`);
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function allowedRpmValues() {
  return [2, 3, 5, 10, 15, 20];
}

async function runSessionConsumer(session) {
  const sessionId = session.sessionId;
  const phone = session.phone;
  const key = sessionQueueKeyByPhone(phone);
  const pacer = getPacer(sessionId, session);
  const proxyId = session.proxy || session.proxyId || null;

  // Apply override RPM if exists (falls back to trust delay windows)
  try {
    const override = await getSessionRpmOverride(sessionId);
    if (override) {
      pacer.setRpm(override);
    }
  } catch (e) {
    // ignore
  }

  let running = true;
  const stop = () => { running = false; };
  sessionConsumers.set(sessionId, { running: true, stop });

  while (running && isRunning) {
    try {
      // Block for up to 2 seconds to keep CPU low
      const res = await redisBlocking.brpop(key, 2);
      if (!res) continue;

      const payload = res[1];
      if (!payload) continue;
      const task = JSON.parse(payload);

      // Pace per session (anti-ban)
      await pacer.waitForSlot();

      // Handoff "send" to Orchestrator/Worker outbox.
      // NOTE: This does not guarantee WhatsApp delivery; it's a controlled dispatch step.
      const sendPayload = {
        to: task.to,
        mode: task.mode,
        text: task.text,
        mediaRef: task.mediaRef,
        mediaPath: task.mediaPath,
        jobId: task.jobId,
        taskId: task.taskId
      };

      const result = await sendViaOrchestrator(sessionId, sendPayload);
      pacer.recordSend();

      if (result.success) {
        // Count task as sent (once)
        if (task.jobId && task.taskId) {
          const statusKey = `job:taskStatus:${task.taskId}`;
          const setOk = await redis.set(statusKey, "SENT", "EX", config.jobStatsTtlSeconds, "NX");
          if (setOk === "OK") {
            await redis.incr(`job:stats:${task.jobId}:sent`);
            await maybeFinalizeJob(task.jobId);
          }
        }
        processedCount++;
        await recordSessionMetricSent(sessionId);
      } else {
        const retryCount = Number(task.retryCount || 0);
        if (retryCount < config.maxRetries) {
          // retry
          task.retryCount = retryCount + 1;
          // push to retry queue with backoff
          const nextRetryAt = Date.now() + clampNumber(config.retryDelayMs, 1000, 10 * 60 * 1000);
          await redis.zadd("queue:retry:session", nextRetryAt, JSON.stringify({ sessionId, phone, task }));
        } else {
          // final fail (count once)
          if (task.jobId && task.taskId) {
            const statusKey = `job:taskStatus:${task.taskId}`;
            const setOk = await redis.set(statusKey, "FAILED", "EX", config.jobStatsTtlSeconds, "NX");
            if (setOk === "OK") {
              await redis.incr(`job:stats:${task.jobId}:failed`);
              await maybeFinalizeJob(task.jobId);
            }
          }
        }

        failedCount++;
        await recordSessionMetricFailed(sessionId);
        await pushIncident({
          type: "SEND_FAILED",
          sessionId,
          phone,
          reason: result.error || "UNKNOWN",
          taskId: task.taskId,
          jobId: task.jobId,
          retryCount: Number(task.retryCount || 0)
        });
        await sendBrainEvent({
          ip: String(proxyId || `session:${sessionId}`),
          session: String(sessionId),
          endpoint: "/api/sessions/:id/outbox/enqueue",
          status: 504,
          latency_ms: null,
          backend: "dispatcher->orchestrator",
          error: String(result.error || "SEND_FAILED"),
          meta: { phone, jobId: task.jobId, taskId: task.taskId, retryCount: Number(task.retryCount || 0) }
        });
      }
    } catch (err) {
      console.error(`[Dispatcher] Session consumer error session=${sessionId}:`, err.message);
      await pushIncident({ type: "SESSION_CONSUMER_ERROR", sessionId, phone, reason: err.message });
      await sendBrainEvent({
        ip: String(proxyId || `session:${sessionId}`),
        session: String(sessionId),
        endpoint: "dispatcher:session_consumer",
        status: 503,
        backend: "dispatcher",
        error: String(err.message || "SESSION_CONSUMER_ERROR"),
        meta: { phone }
      });
      // short sleep to avoid hot loop
      await new Promise(r => setTimeout(r, 250));
    }
  }

  sessionConsumers.delete(sessionId);
}

async function reconcileSessionConsumers() {
  if (!isRunning) return;

  const sessions = await getAvailableSessionsCached();
  const connected = sessions.filter(s => s.status === "CONNECTED" && s.sessionId && s.phone);
  const connectedIds = new Set(connected.map(s => s.sessionId));

  // Start missing consumers
  for (const s of connected) {
    if (!sessionConsumers.has(s.sessionId)) {
      runSessionConsumer(s); // intentionally not awaited
    } else {
      // refresh pacing from trust policy (and overrides if any)
      const pacer = getPacer(s.sessionId, s);
      const policy = trustPolicyForSession(s);
      // Only update delay window if user didn't force RPM
      const override = await getSessionRpmOverride(s.sessionId);
      if (override) {
        pacer.setRpm(override);
      } else if (pacer.getConfig().rpm) {
        // clear override and fall back to trust window
        pacer.updateConfig({ rpm: null });
      }

      if (!override) {
        pacer.updateConfig({ minDelayMs: policy.minDelayMs, maxDelayMs: policy.maxDelayMs });
      }
    }
  }

  // Stop consumers for sessions that are no longer connected
  for (const [sessionId, c] of sessionConsumers) {
    if (!connectedIds.has(sessionId)) {
      try { c.stop(); } catch (_) {}
    }
  }
}

async function sessionRetryLoop() {
  if (!isRunning) return;
  try {
    const now = Date.now();
    const due = await redis.zrangebyscore("queue:retry:session", 0, now, "LIMIT", 0, 25);
    for (const item of due) {
      await redis.zrem("queue:retry:session", item);
      const parsed = JSON.parse(item);
      const phone = parsed.phone;
      const task = parsed.task;
      if (phone && task) {
        await redis.lpush(sessionQueueKeyByPhone(phone), JSON.stringify(task));
      }
    }
  } catch (e) {
    // ignore
  } finally {
    setTimeout(sessionRetryLoop, 1000);
  }
}

let consumersReconcileTimer = null;
function startConsumers() {
  if (consumersReconcileTimer) return;
  consumersReconcileTimer = setInterval(reconcileSessionConsumers, 5000);
  reconcileSessionConsumers();
  sessionRetryLoop();
}

function stopConsumers() {
  if (consumersReconcileTimer) {
    clearInterval(consumersReconcileTimer);
    consumersReconcileTimer = null;
  }
  for (const [, c] of sessionConsumers) {
    try { c.stop(); } catch (_) {}
  }
  sessionConsumers.clear();
}

// ===========================================
// API ROUTES
// ===========================================

/**
 * Health check
 */
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    service: "wa-dispatcher", 
    running: isRunning,
    stats: {
      processed: processedCount,
      routed: routedCount,
      failed: failedCount,
      activePacers: sessionPacers.size
    },
    timestamp: Date.now() 
  });
});

/**
 * Start dispatcher
 */
app.post("/start", (req, res) => {
  startDispatcher();
  startConsumers();
  res.json({ status: "ok", message: "Dispatcher started" });
});

/**
 * Stop dispatcher
 */
app.post("/stop", (req, res) => {
  stopDispatcher();
  stopConsumers();
  res.json({ status: "ok", message: "Dispatcher stopped" });
});

/**
 * Get queue status
 */
app.get("/queue/status", async (req, res) => {
  try {
    const gatewayLen = await redis.llen(config.gatewayQueueKey);
    const priorityLen = await redis.llen(config.priorityQueueKey);
    const retryLen = await redis.zcard("queue:retry");
    const sessionRetryLen = await redis.zcard("queue:retry:session");
    
    res.json({
      status: "ok",
      queues: {
        gateway: gatewayLen,
        priority: priorityLen,
        retry: retryLen,
        sessionRetry: sessionRetryLen,
        total: gatewayLen + priorityLen + retryLen + sessionRetryLen
      }
    });
  } catch (err) {
    res.status(500).json({ status: "error", reason: err.message });
  }
});

/**
 * Get pacer stats
 */
app.get("/pacers", (req, res) => {
  const pacerStats = [];
  for (const [sessionId, pacer] of sessionPacers) {
    pacerStats.push({
      sessionId,
      ...pacer.getStats()
    });
  }
  res.json({ status: "ok", pacers: pacerStats });
});

/**
 * Update pacer config for a session
 */
app.post("/pacers/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const { minDelayMs, maxDelayMs, burstLimit, burstCooldownMs, rpm } = req.body;
  
  const pacer = getPacer(sessionId);
  pacer.updateConfig({ minDelayMs, maxDelayMs, burstLimit, burstCooldownMs, rpm });
  
  res.json({ status: "ok", message: "Pacer updated", config: pacer.getConfig() });
});

/**
 * Set per-session RPM override (dashboard control)
 * Body: { rpm: 2|3|5|10|15|20|null }
 */
app.post("/sessions/:sessionId/rpm", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { rpm } = req.body || {};

    if (rpm === null) {
      await redis.del(`config:session:${sessionId}:rpm`);
      const pacer = getPacer(sessionId);
      pacer.updateConfig({ rpm: null });
      return res.json({ status: "ok", sessionId, rpm: null });
    }

    const n = Number(rpm);
    if (!allowedRpmValues().includes(n)) {
      return res.status(400).json({ status: "error", reason: "Invalid rpm. Allowed: 2,3,5,10,15,20" });
    }

    await redis.set(`config:session:${sessionId}:rpm`, String(n));
    const pacer = getPacer(sessionId);
    pacer.setRpm(n);

    return res.json({ status: "ok", sessionId, rpm: n });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

/**
 * Per-session queue lengths + rpm counters (for dashboard)
 */
app.get("/sessions/metrics", async (req, res) => {
  try {
    const sessions = await getAvailableSessionsCached();
    const connected = sessions.filter(s => s.status === "CONNECTED" && s.sessionId && s.phone);

    const rows = [];
    for (const s of connected) {
      const qlen = await redis.llen(sessionQueueKeyByPhone(s.phone));
      const sent60s = Number(await redis.get(`metrics:session:${s.sessionId}:sent60s`) || 0);
      const routed60s = Number(await redis.get(`metrics:session:${s.sessionId}:routed60s`) || 0);
      const failed60s = Number(await redis.get(`metrics:session:${s.sessionId}:failed60s`) || 0);
      const override = await redis.get(`config:session:${s.sessionId}:rpm`);
      const policy = trustPolicyForSession(s);
      rows.push({
        sessionId: s.sessionId,
        phone: s.phone,
        queueLen: qlen,
        sentLast60s: sent60s,
        routedLast60s: routed60s,
        failedLast60s: failed60s,
        trustLevel: policy.trustLevel,
        rpmDefault: policy.rpm,
        rpmOverride: override ? Number(override) : null
      });
    }

    return res.json({ status: "ok", count: rows.length, sessions: rows });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

/**
 * SmartGuard status (for dashboards)
 */
app.get("/smartguard/status", async (_req, res) => {
  try {
    const enabled = await getSmartGuardEnabled();
    const lastTick = await redis.get("smartguard:lastTick");
    const lastActionAt = await redis.get("smartguard:lastActionAt");
    return res.json({
      status: "ok",
      smartguard: {
        enabled,
        tickMs: config.smartGuardTickMs,
        lastTick: lastTick ? Number(lastTick) : null,
        lastActionAt: lastActionAt ? Number(lastActionAt) : null
      }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

/**
 * Toggle SmartGuard enabled flag (stored in Redis)
 * Body: { enabled: true|false }
 */
app.post("/smartguard/enable", async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    await redis.set("config:smartguard:enabled", enabled ? "true" : "false");
    await pushIncident({ type: "SMART_GUARD_TOGGLE", enabled });
    return res.json({ status: "ok", enabled });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

// ===========================================
// START SERVER
// ===========================================

app.listen(config.port, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           WhatsApp Message Dispatcher                     ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${config.port}                                            ║
║  Redis: ${config.redisUrl.slice(0, 30)}...                      ║
║  Orchestrator: ${config.orchestratorUrl.slice(0, 25)}...              ║
║  Pacing: ${config.defaultMinDelayMs}-${config.defaultMaxDelayMs}ms                              ║
╚═══════════════════════════════════════════════════════════╝
  `);
  
  // Auto-start if configured
  if (process.env.AUTO_START === "true") {
    startDispatcher();
    startConsumers();
  }
});

module.exports = { app, startDispatcher, stopDispatcher };


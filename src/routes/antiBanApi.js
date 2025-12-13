const express = require("express");
const axios = require("axios");
const { requireApiKey } = require("../middlewares/requireApiKey");
const { config } = require("../config");
const { getActiveSessions } = require("../services/sessionRegistry");
const { getOutboxLengths } = require("../services/outboxService");
const { getRedis } = require("../infra/redis");
const { getAiAdvice, getAntiBanSnapshotForAi } = require("../services/aiAdvisorService");
const { listIncidents } = require("../services/incidentService");
const sessionBrain = require("../services/sessionBrainClient");
const sessionBrainEnforcer = require("../services/sessionBrainEnforcerService");

const router = express.Router();

function dispatcherClient() {
  return axios.create({
    baseURL: config.dispatcherUrl,
    timeout: 5000
  });
}

function trustPolicyForSession(session) {
  const createdAt = Number(session.createdAt || 0);
  const days = createdAt > 0 ? (Date.now() - createdAt) / (24 * 60 * 60 * 1000) : 0;

  if (days < 3) return { trustLevel: 1, rpmDefault: 3 };
  if (days < 7) return { trustLevel: 2, rpmDefault: 5 };
  if (days < 14) return { trustLevel: 3, rpmDefault: 10 };
  return { trustLevel: 4, rpmDefault: 20 };
}

router.get("/status", requireApiKey, async (_req, res) => {
  try {
    const redis = getRedis();
    const dc = dispatcherClient();

    const [gatewayQueueLen, dispatcherHealth, dispatcherQueues, dispatcherSessions, smartGuardStatus, sessions] = await Promise.all([
      redis.llen("gateway:jobs"),
      dc.get("/health").then(r => r.data).catch(e => ({ status: "error", reason: e.message })),
      dc.get("/queue/status").then(r => r.data).catch(e => ({ status: "error", reason: e.message })),
      dc.get("/sessions/metrics").then(r => r.data).catch(e => ({ status: "error", reason: e.message })),
      dc.get("/smartguard/status").then(r => r.data).catch(() => null),
      getActiveSessions()
    ]);

    // Outbox sizes per session (control plane queues)
    const outbox = {};
    for (const s of sessions) {
      if (!s.sessionId) continue;
      outbox[s.sessionId] = await getOutboxLengths(s.sessionId);
    }

    // Fallback metrics computed directly from Redis (works even if Dispatcher HTTP is down)
    const connected = sessions.filter(s => s.status === "CONNECTED" && s.sessionId && s.phone);
    const fallbackSessions = [];
    for (const s of connected) {
      const { trustLevel, rpmDefault } = trustPolicyForSession(s);
      const rpmOverrideRaw = await redis.get(`config:session:${s.sessionId}:rpm`);
      const rpmOverride = rpmOverrideRaw ? Number(rpmOverrideRaw) : null;
      const queueLen = await redis.llen(`queue:session:${s.phone}`);
      const sentLast60s = Number(await redis.get(`metrics:session:${s.sessionId}:sent60s`) || 0);
      const routedLast60s = Number(await redis.get(`metrics:session:${s.sessionId}:routed60s`) || 0);
      fallbackSessions.push({
        sessionId: s.sessionId,
        phone: s.phone,
        trustLevel,
        rpmDefault,
        rpmOverride: Number.isFinite(rpmOverride) ? rpmOverride : null,
        queueLen,
        sentLast60s,
        routedLast60s
      });
    }

    // If Dispatcher sessions endpoint failed, replace it with fallback list for the UI.
    const dispSessionsOk = dispatcherSessions && dispatcherSessions.status === "ok" && Array.isArray(dispatcherSessions.sessions);
    const sessionsForUi = dispSessionsOk ? dispatcherSessions.sessions : fallbackSessions;

    // Recent SmartGuard / send incidents (from Redis shared key)
    const rawInc = await redis.lrange("antiban:incidents", 0, 49);
    const incidents = (rawInc || []).map(x => {
      try { return JSON.parse(x); } catch { return { ts: Date.now(), raw: x }; }
    });

    const smartGuardEnabledRaw = await redis.get("config:smartguard:enabled");
    const smartGuardEnabled = smartGuardEnabledRaw === null ? null : (smartGuardEnabledRaw === "true");

    return res.json({
      status: "ok",
      timestamp: Date.now(),
      dispatcherUrl: config.dispatcherUrl,
      gatewayQueue: { key: "gateway:jobs", length: gatewayQueueLen },
      dispatcher: {
        health: dispatcherHealth,
        queues: dispatcherQueues,
        sessions: { status: "ok", count: sessionsForUi.length, sessions: sessionsForUi },
        smartGuard: smartGuardStatus?.smartguard || { enabled: smartGuardEnabled }
      },
      incidents,
      orchestrator: {
        sessionsCount: sessions.length,
        outbox
      }
    });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

/**
 * Apply RPM override to ALL connected sessions (quick buttons 5/10/15/20)
 * Body: { rpm: 5|10|15|20|null }
 */
router.post("/global/rpm", requireApiKey, async (req, res) => {
  try {
    const rpm = req.body?.rpm;
    const redis = getRedis();

    const allowed = [5, 10, 15, 20];
    const value = rpm === null ? null : Number(rpm);
    if (value !== null && !allowed.includes(value)) {
      return res.status(400).json({ status: "error", reason: "Invalid rpm. Allowed: 5,10,15,20 or null" });
    }

    const sessions = await getActiveSessions();
    const connected = sessions.filter(s => s.status === "CONNECTED" && s.sessionId);

    for (const s of connected) {
      if (value === null) {
        await redis.del(`config:session:${s.sessionId}:rpm`);
      } else {
        await redis.set(`config:session:${s.sessionId}:rpm`, String(value));
      }
    }

    // best-effort: immediate apply via Dispatcher API (optional)
    try {
      const dc = dispatcherClient();
      await Promise.all(connected.map(s =>
        dc.post(`/sessions/${encodeURIComponent(s.sessionId)}/rpm`, { rpm: value })
          .catch(() => null)
      ));
    } catch {
      // ignore
    }

    return res.json({ status: "ok", rpm: value, appliedTo: connected.length });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

/**
 * Toggle SmartGuard enabled flag
 * Body: { enabled: true|false }
 */
router.post("/smartguard/enable", requireApiKey, async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const redis = getRedis();
    await redis.set("config:smartguard:enabled", enabled ? "true" : "false");

    // best-effort: also notify Dispatcher (so it logs incident)
    try {
      const dc = dispatcherClient();
      await dc.post("/smartguard/enable", { enabled });
    } catch {
      // ignore
    }

    return res.json({ status: "ok", enabled });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

router.post("/sessions/:sessionId/rpm", requireApiKey, async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId || "").trim();
    const rpm = req.body?.rpm;
    const redis = getRedis();

    // Always store override in Redis (Dispatcher reads this key periodically)
    if (rpm === null) {
      await redis.del(`config:session:${sessionId}:rpm`);
    } else {
      await redis.set(`config:session:${sessionId}:rpm`, String(rpm));
    }

    // Best-effort: also call Dispatcher API for immediate apply (if reachable)
    try {
      const dc = dispatcherClient();
      const resp = await dc.post(`/sessions/${encodeURIComponent(sessionId)}/rpm`, { rpm });
      return res.json(resp.data);
    } catch {
      return res.json({ status: "ok", sessionId, rpm, applied: "redis-only" });
    }
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

/**
 * AI Advisor (Gemini) - returns recommendations based on anti-ban status/incidents.
 * NOTE: advisory only (no automatic actions).
 */
router.get("/ai/advice", requireApiKey, async (_req, res) => {
  try {
    // Build a compact statusData: pull from our own /status (internal) to keep consistency.
    // Since this is the same router, just call Redis + dispatcher endpoints similarly.
    const redis = getRedis();
    const dc = dispatcherClient();

    const [dispatcherQueues, dispatcherSessions, smartGuardStatus] = await Promise.all([
      dc.get("/queue/status").then(r => r.data).catch(e => ({ status: "error", reason: e.message })),
      dc.get("/sessions/metrics").then(r => r.data).catch(e => ({ status: "error", reason: e.message })),
      dc.get("/smartguard/status").then(r => r.data).catch(() => null),
    ]);

    const snapshot = await getAntiBanSnapshotForAi();

    const statusData = {
      dispatcherUrl: config.dispatcherUrl,
      dispatcher: {
        queues: dispatcherQueues,
        sessions: dispatcherSessions,
        smartGuard: smartGuardStatus?.smartguard || { enabled: snapshot.smartGuardEnabled }
      },
      incidents: snapshot.incidents,
      ts: snapshot.ts
    };

    const advice = await getAiAdvice({ statusData });
    return res.json({
      status: "ok",
      timestamp: Date.now(),
      model: advice.model,
      parsed: advice.parsed,
      rawText: advice.rawText
    });
  } catch (err) {
    const code = typeof err?.statusCode === "number" ? err.statusCode : 500;
    return res.status(code).json({ status: "error", reason: err.message });
  }
});

/**
 * Insights / Learning board data
 * Aggregates incidents into: byHour (0-23), byType, topSessions, topProxies, recent
 */
router.get("/insights", requireApiKey, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, Number(req.query.days || 7)));
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    const incidents = await listIncidents(500);
    const scoped = incidents.filter((x) => Number(x.ts || 0) >= since);

    const byHour = Array.from({ length: 24 }, () => 0);
    const byType = {};
    const bySession = {};
    const byProxy = {};

    for (const it of scoped) {
      const ts = Number(it.ts || 0);
      if (!ts) continue;
      const h = new Date(ts).getHours();
      byHour[h] = (byHour[h] || 0) + 1;

      const t = String(it.type || "UNKNOWN");
      byType[t] = (byType[t] || 0) + 1;

      const sid = it.sessionId ? String(it.sessionId) : null;
      if (sid) bySession[sid] = (bySession[sid] || 0) + 1;

      const pid = it.proxyId ? String(it.proxyId) : null;
      if (pid) byProxy[pid] = (byProxy[pid] || 0) + 1;
    }

    const topSessions = Object.entries(bySession)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sessionId, count]) => ({ sessionId, count }));

    const topProxies = Object.entries(byProxy)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([proxyId, count]) => ({ proxyId, count }));

    return res.json({
      status: "ok",
      timestamp: Date.now(),
      rangeDays: days,
      totals: { incidents: scoped.length },
      byHour,
      byType,
      topSessions,
      topProxies,
      recent: incidents.slice(0, 50)
    });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

/**
 * Session Brain proxy endpoints (read-only)
 */
router.get("/session-brain/blocks", requireApiKey, async (_req, res) => {
  try {
    const data = await sessionBrain.getBlocks();
    return res.json({ status: "ok", data });
  } catch (err) {
    return res.status(502).json({ status: "error", reason: err.message });
  }
});

router.get("/session-brain/decisions", requireApiKey, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));
    const data = await sessionBrain.getDecisions(limit);
    return res.json({ status: "ok", data });
  } catch (err) {
    return res.status(502).json({ status: "error", reason: err.message });
  }
});

router.post("/session-brain/analyze", requireApiKey, async (req, res) => {
  try {
    const data = await sessionBrain.analyze(req.body || {});
    return res.json({ status: "ok", data });
  } catch (err) {
    return res.status(502).json({ status: "error", reason: err.message });
  }
});

router.get("/session-brain/enforcer/status", requireApiKey, async (_req, res) => {
  try {
    return res.json({ status: "ok", data: sessionBrainEnforcer.getStatus() });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

router.post("/session-brain/enforcer/tick", requireApiKey, async (_req, res) => {
  try {
    await sessionBrainEnforcer.tick();
    return res.json({ status: "ok", data: sessionBrainEnforcer.getStatus() });
  } catch (err) {
    return res.status(500).json({ status: "error", reason: err.message });
  }
});

module.exports = router;



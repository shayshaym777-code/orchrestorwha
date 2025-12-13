const { config } = require("../config");
const { getRedis } = require("../infra/redis");
const sessionBrain = require("./sessionBrainClient");
const watchdogService = require("./watchdogService");
const { pushIncident } = require("./incidentService");

const LAST_APPLIED_TS_KEY = "sessionbrain:lastAppliedTsMs";

let interval = null;
let running = false;
let lastTick = null;
let lastError = null;

function normalizeTargetToProxyId(target) {
  if (!target) return null;
  const t = String(target).trim();
  if (!t) return null;
  if (t.startsWith("proxy:")) return t.slice("proxy:".length);
  if (t.startsWith("session:")) return null;
  return t;
}

async function tick() {
  if (running) return;
  running = true;
  lastTick = Date.now();
  lastError = null;

  try {
    if (!config.sessionBrainUrl || !config.sessionBrainEnforcerEnabled) return;

    const redis = getRedis();
    const lastAppliedTs = Number((await redis.get(LAST_APPLIED_TS_KEY)) || 0);

    const decisionsRes = await sessionBrain.getDecisions(100);
    const decisions = Array.isArray(decisionsRes?.decisions) ? decisionsRes.decisions : [];
    if (decisions.length === 0) return;

    const newDecisions = decisions
      .filter((d) => Number(d?.ts_ms || 0) > lastAppliedTs)
      .sort((a, b) => Number(a.ts_ms || 0) - Number(b.ts_ms || 0));

    for (const d of newDecisions) {
      const ts = Number(d?.ts_ms || 0);
      const kind = String(d?.kind || "");
      const target = String(d?.target || "");
      const reason = String(d?.reason || "SESSION_BRAIN_DECISION");
      const ttlSec = Number(d?.ttl_sec || 0);

      if (kind === "block_ip") {
        const proxyId = normalizeTargetToProxyId(target);
        if (proxyId) {
          // Apply action: treat as burned proxy, migrate sessions away.
          const cooldownMs = ttlSec > 0 ? ttlSec * 1000 : undefined;
          const burnReason = `SESSION_BRAIN:block_ip:${reason}`;

          const result = await watchdogService.handleProxyBurn(proxyId, burnReason, cooldownMs);
          await pushIncident({
            type: "SESSION_BRAIN_DECISION_APPLIED",
            kind,
            target,
            proxyId,
            ttlSec,
            reason,
            action: "handleProxyBurn",
            result
          });
        } else {
          await pushIncident({
            type: "SESSION_BRAIN_DECISION_SKIPPED",
            kind,
            target,
            ttlSec,
            reason,
            skipReason: "target_not_proxy"
          });
        }
      } else {
        await pushIncident({
          type: "SESSION_BRAIN_DECISION_IGNORED",
          kind,
          target,
          ttlSec,
          reason
        });
      }

      // Mark decision as applied (best-effort ordering)
      await redis.set(LAST_APPLIED_TS_KEY, String(ts));
    }
  } catch (err) {
    lastError = err?.message || String(err);
    try {
      await pushIncident({ type: "SESSION_BRAIN_ENFORCER_ERROR", reason: lastError });
    } catch {
      // ignore
    }
  } finally {
    running = false;
  }
}

function start() {
  if (interval) return;
  if (!config.sessionBrainEnforcerEnabled) return;
  interval = setInterval(tick, Math.max(1000, config.sessionBrainEnforcerIntervalMs || 15000));
  // run once on startup
  tick();
}

function stop() {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
}

function getStatus() {
  return {
    enabled: !!config.sessionBrainEnforcerEnabled,
    configured: !!config.sessionBrainUrl,
    active: interval !== null,
    running,
    lastTick,
    lastError
  };
}

module.exports = {
  start,
  stop,
  tick,
  getStatus
};



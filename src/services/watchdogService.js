/**
 * Watchdog Service
 * 
 * Monitors session health and takes automatic actions:
 * - Detects stale sessions (no PING)
 * - Auto-restarts failed containers
 * - Handles proxy burns and switches
 * - Generates alerts
 */

const { getRedis } = require("../infra/redis");
const { config } = require("../config");
const { 
  getActiveSessions, 
  getSession, 
  getSessionsByProxy,
  getCounters,
  updateSessionStatus,
  SessionStatus,
  FailureReason,
  markProxyBad,
  switchSessionProxy,
  getProxyHealth
} = require("./sessionRegistry");
const { restartWorker, stopWorker, getWorkerStatus } = require("./runnerService");
const { alertLowInventory, checkSessionHealth, checkProxyCapacity, storeAlerts } = require("./alertService");
const { getInventoryStatus } = require("./inventoryService");
const { pushIncident } = require("./incidentService");
const { sendEvent: sendBrainEvent } = require("./sessionBrainClient");

// Telegram Alerts
const { 
  alertSessionDown, 
  alertProxyBurned, 
  alertLowInventory: telegramLowInventory,
  alertWatchdogAction
} = require("./telegramAlertService");

// Configuration
const PING_TIMEOUT_MS = config.pingTimeoutMs || 3 * 60 * 1000; // 3 minutes
const WATCHDOG_INTERVAL_MS = config.watchdogIntervalMs || 60 * 1000; // 1 minute
const MAX_RESTART_ATTEMPTS = config.maxRestartAttempts || 3;
const RESTART_COOLDOWN_MS = config.restartCooldownMs || 5 * 60 * 1000; // 5 minutes

let watchdogInterval = null;
let isRunning = false;

/**
 * Check all sessions for health issues
 */
async function checkAllSessions() {
  if (isRunning) {
    console.log("[Watchdog] Previous check still running, skipping...");
    return;
  }
  
  isRunning = true;
  const startTime = Date.now();
  
  try {
    const redis = getRedis();
    const sessions = await getActiveSessions();
    const counters = await getCounters();
    
    let checked = 0;
    let stale = 0;
    let restarted = 0;
    let stopped = 0;
    
    for (const session of sessions) {
      checked++;
      const sessionId = session.sessionId;
      
      // Skip sessions not in CONNECTED status
      if (session.status !== SessionStatus.CONNECTED) {
        continue;
      }
      
      // Check last ping
      const lastPing = parseInt(session.lastPing || '0');
      const now = Date.now();
      
      if (lastPing > 0 && (now - lastPing) > PING_TIMEOUT_MS) {
        stale++;
        console.log(`[Watchdog] Session ${sessionId} is stale (no ping for ${Math.floor((now - lastPing) / 1000)}s)`);
        
        // Check restart attempts
        const restartKey = `watchdog:restarts:${sessionId}`;
        const restartData = await redis.get(restartKey);
        const restarts = restartData ? JSON.parse(restartData) : { count: 0, lastAt: 0 };
        
        // Check cooldown
        if (restarts.lastAt > 0 && (now - restarts.lastAt) < RESTART_COOLDOWN_MS) {
          console.log(`[Watchdog] Session ${sessionId} in cooldown, skipping restart`);
          continue;
        }
        
        // Check max attempts
        if (restarts.count >= MAX_RESTART_ATTEMPTS) {
          console.log(`[Watchdog] Session ${sessionId} exceeded max restarts (${MAX_RESTART_ATTEMPTS})`);
          
          // Mark session as ERROR
          await updateSessionStatus(sessionId, SessionStatus.ERROR, {
            failureReason: FailureReason.MAX_RECONNECTS,
            watchdogAction: 'STOPPED_MAX_RESTARTS'
          });
          
          // Stop container
          await stopWorker(sessionId);
          stopped++;
          
          // 🔔 Telegram Alert - Session Down
          alertSessionDown(sessionId, `Exceeded ${MAX_RESTART_ATTEMPTS} restart attempts`).catch(e => 
            console.error("[Watchdog] Telegram alert failed:", e.message)
          );
          
          // Check if proxy might be bad
          if (session.proxy) {
            const proxyHealth = await getProxyHealth(session.proxy);
            if (proxyHealth.sessionCount > 1) {
              // Multiple sessions on this proxy, might be proxy issue
              const otherSessions = await getSessionsByProxy(session.proxy);
              const staleSessions = otherSessions.filter(s => {
                const lp = parseInt(s.lastPing || '0');
                return lp > 0 && (now - lp) > PING_TIMEOUT_MS;
              });
              
              if (staleSessions.length >= 2) {
                console.log(`[Watchdog] Multiple stale sessions on proxy ${session.proxy.slice(-12)}, marking BAD`);
                await markProxyBad(session.proxy, 'MULTIPLE_STALE_SESSIONS');
                await pushIncident({
                  type: "PROXY_MARKED_BAD",
                  proxyId: session.proxy,
                  reason: "MULTIPLE_STALE_SESSIONS",
                  sessionsAffected: staleSessions.map(s => s.sessionId)
                });
              }
            }
          }
          
          continue;
        }
        
        // Attempt restart
        console.log(`[Watchdog] Restarting session ${sessionId} (attempt ${restarts.count + 1}/${MAX_RESTART_ATTEMPTS})`);
        
        const containerStatus = await getWorkerStatus(sessionId);
        
        if (containerStatus.exists && containerStatus.running) {
          // Container running but not pinging - restart it
          const result = await restartWorker(sessionId);
          
          if (result.success) {
            restarted++;
            
            // Update restart counter
            await redis.set(restartKey, JSON.stringify({
              count: restarts.count + 1,
              lastAt: now
            }), 'EX', 3600); // Expire after 1 hour
            
            await updateSessionStatus(sessionId, SessionStatus.RECONNECTING, {
              watchdogAction: 'RESTARTED',
              restartAttempt: restarts.count + 1
            });
          }
        } else if (!containerStatus.exists) {
          // Container doesn't exist - mark as error
          console.log(`[Watchdog] Container for ${sessionId} not found`);
          await updateSessionStatus(sessionId, SessionStatus.ERROR, {
            failureReason: FailureReason.UNKNOWN,
            watchdogAction: 'CONTAINER_NOT_FOUND'
          });
        }
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`[Watchdog] Check complete: ${checked} sessions, ${stale} stale, ${restarted} restarted, ${stopped} stopped (${duration}ms)`);
    
    // Inventory alerts (profiles/proxies missing)
    const inventory = await getInventoryStatus();
    await alertLowInventory({
      profilesAvailable: inventory.profiles.available,
      proxiesAvailable: inventory.proxies.available
    });
    
    // 🔔 Telegram Alert - Low Inventory
    const PROXIES_LOW_THRESHOLD = config.proxiesLowThreshold || 3;
    const PROFILES_LOW_THRESHOLD = config.profilesLowThreshold || 5;
    
    if (inventory.proxies.available < PROXIES_LOW_THRESHOLD) {
      telegramLowInventory("proxies", inventory.proxies.available, PROXIES_LOW_THRESHOLD).catch(e => 
        console.error("[Watchdog] Telegram alert failed:", e.message)
      );
    }
    if (inventory.profiles.available < PROFILES_LOW_THRESHOLD) {
      telegramLowInventory("profiles", inventory.profiles.available, PROFILES_LOW_THRESHOLD).catch(e => 
        console.error("[Watchdog] Telegram alert failed:", e.message)
      );
    }

    // Session health alerts (no ping / banned / logged out)
    const sessionAlerts = await checkSessionHealth(sessions);
    if (sessionAlerts.length > 0) await storeAlerts(sessionAlerts);

    // Proxy capacity alerts
    const proxyAlerts = await checkProxyCapacity(counters.proxyCounts || {});
    if (proxyAlerts.length > 0) await storeAlerts(proxyAlerts);
    
  } catch (error) {
    console.error("[Watchdog] Error during check:", error.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Handle proxy burn event (from webhook or manual)
 */
async function handleProxyBurn(proxyId, reason = 'UNKNOWN', cooldownMs = undefined) {
  console.log(`[Watchdog] Handling proxy burn: ${proxyId.slice(-12)}, reason: ${reason}`);
  
  // Mark proxy as BAD
  await markProxyBad(proxyId, reason, cooldownMs);
  await pushIncident({ type: "PROXY_BURN", proxyId, reason });
  await sendBrainEvent({
    ip: String(proxyId),
    session: null,
    endpoint: "watchdog:proxy_burn",
    status: 503,
    backend: "orchestrator:watchdog",
    error: String(reason || "PROXY_BURN"),
    meta: { proxyId }
  });
  
  // Get all sessions on this proxy
  const { getSessionsByProxy } = require("./sessionRegistry");
  const sessions = await getSessionsByProxy(proxyId);
  
  if (sessions.length === 0) {
    console.log(`[Watchdog] No sessions on proxy ${proxyId.slice(-12)}`);
    return { success: true, sessionsAffected: 0 };
  }
  
  // Get available proxies
  const redis = getRedis();
  const availableProxies = await redis.smembers('proxies:available');
  
  // Filter out BAD proxies
  const healthyProxies = [];
  for (const p of availableProxies) {
    if (p !== proxyId) {
      const health = await getProxyHealth(p);
      if (health.available) {
        healthyProxies.push(p);
      }
    }
  }
  
  if (healthyProxies.length === 0) {
    console.log(`[Watchdog] No healthy proxies available for migration!`);
    return { success: false, reason: 'NO_HEALTHY_PROXIES', sessionsAffected: sessions.length };
  }
  
  // Migrate sessions to new proxies
  let migrated = 0;
  for (const session of sessions) {
    // Pick proxy with least sessions
    const proxyLoads = await Promise.all(healthyProxies.map(async p => {
      const count = parseInt(await redis.get(`counter:proxy:${p}`) || '0');
      return { proxy: p, count };
    }));
    
    proxyLoads.sort((a, b) => a.count - b.count);
    const newProxy = proxyLoads[0].proxy;
    
    // Switch session to new proxy
    const result = await switchSessionProxy(session.sessionId, newProxy);
    if (result.success) {
      migrated++;
      
      // Restart the worker with new proxy
      // Note: Worker needs to be restarted to pick up new proxy
      console.log(`[Watchdog] Session ${session.sessionId} needs restart with new proxy`);
    }
  }
  
  console.log(`[Watchdog] Proxy burn handled: ${migrated}/${sessions.length} sessions migrated`);
  
  // 🔔 Telegram Alert - Proxy Burned
  alertProxyBurned(proxyId, sessions.length).catch(e => 
    console.error("[Watchdog] Telegram alert failed:", e.message)
  );
  
  return { 
    success: true, 
    sessionsAffected: sessions.length, 
    sessionsMigrated: migrated,
    newProxies: healthyProxies.slice(0, migrated)
  };
}

/**
 * Start the watchdog
 */
function startWatchdog() {
  if (watchdogInterval) {
    console.log("[Watchdog] Already running");
    return;
  }
  
  console.log(`[Watchdog] Starting (interval: ${WATCHDOG_INTERVAL_MS}ms, ping timeout: ${PING_TIMEOUT_MS}ms)`);
  
  // Run immediately
  checkAllSessions();
  
  // Schedule recurring checks
  watchdogInterval = setInterval(checkAllSessions, WATCHDOG_INTERVAL_MS);
}

/**
 * Stop the watchdog
 */
function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    console.log("[Watchdog] Stopped");
  }
}

/**
 * Get watchdog status
 */
function getWatchdogStatus() {
  return {
    running: !!watchdogInterval,
    isChecking: isRunning,
    config: {
      pingTimeoutMs: PING_TIMEOUT_MS,
      intervalMs: WATCHDOG_INTERVAL_MS,
      maxRestartAttempts: MAX_RESTART_ATTEMPTS,
      restartCooldownMs: RESTART_COOLDOWN_MS
    }
  };
}

module.exports = {
  startWatchdog,
  stopWatchdog,
  getWatchdogStatus,
  checkAllSessions,
  handleProxyBurn
};


/**
 * Alert Service
 * 
 * Monitors system state and generates alerts for:
 * - Proxy/phone limits reached
 * - Sessions expiring soon
 * - Inventory running low
 * - Session failures/bans
 */

const { getRedis } = require("../infra/redis");
const { config } = require("../config");

// ============================================
// ALERT TYPES
// ============================================

const AlertType = {
  // Capacity alerts
  PROXY_FULL: "PROXY_FULL",
  PROXY_ALMOST_FULL: "PROXY_ALMOST_FULL",
  PHONE_LIMIT: "PHONE_LIMIT",
  
  // Inventory alerts
  PROFILES_LOW: "PROFILES_LOW",
  PROFILES_EMPTY: "PROFILES_EMPTY",
  PROXIES_LOW: "PROXIES_LOW",
  PROXIES_EMPTY: "PROXIES_EMPTY",
  
  // Session alerts
  SESSION_EXPIRING: "SESSION_EXPIRING",
  SESSION_FAILED: "SESSION_FAILED",
  SESSION_BANNED: "SESSION_BANNED",
  SESSION_LOGGED_OUT: "SESSION_LOGGED_OUT",
  
  // Health alerts
  PROXY_BAD: "PROXY_BAD",
  HIGH_FAILURE_RATE: "HIGH_FAILURE_RATE",
  NO_PING: "NO_PING"
};

const AlertSeverity = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
  CRITICAL: "critical"
};

// ============================================
// LEGACY FUNCTION (kept for compatibility)
// ============================================

async function storeAlerts(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return 0;
  const redis = getRedis();
  const timestamp = Date.now();

  for (const alert of alerts) {
    const alertWithTime = {
      ...alert,
      timestamp,
      id: alert.id || `${alert.type}_${timestamp}_${Math.random().toString(36).slice(2, 8)}`
    };
    await redis.lpush("alerts:inventory", JSON.stringify(alertWithTime));
  }
  await redis.ltrim("alerts:inventory", 0, 99);
  return alerts.length;
}

// Track last alert time to prevent spam
let lastInventoryAlertTime = 0;
const INVENTORY_ALERT_COOLDOWN_MS = 60000; // 1 minute cooldown

async function alertLowInventory({ profilesAvailable, proxiesAvailable }) {
  const now = Date.now();
  
  // Only log every 1 minute to prevent spam
  if (now - lastInventoryAlertTime > INVENTORY_ALERT_COOLDOWN_MS) {
    console.warn(
      `[ALERT] Low inventory: profilesAvailable=${profilesAvailable}, proxiesAvailable=${proxiesAvailable}`
    );
    lastInventoryAlertTime = now;
  }
  
  const alerts = [];
  const profilesLow = Number(config.profilesLowThreshold || 5);
  const proxiesLow = Number(config.proxiesLowThreshold || 3);
  
  if (profilesAvailable === 0) {
    alerts.push({
      type: AlertType.PROFILES_EMPTY,
      severity: AlertSeverity.CRITICAL,
      message: "No profiles available!",
      data: { profilesAvailable }
    });
  } else if (profilesAvailable < profilesLow) {
    alerts.push({
      type: AlertType.PROFILES_LOW,
      severity: AlertSeverity.WARNING,
      message: `Low profiles: ${profilesAvailable} remaining`,
      data: { profilesAvailable }
    });
  }
  
  if (proxiesAvailable === 0) {
    alerts.push({
      type: AlertType.PROXIES_EMPTY,
      severity: AlertSeverity.CRITICAL,
      message: "No proxies available!",
      data: { proxiesAvailable }
    });
  } else if (proxiesAvailable < proxiesLow) {
    alerts.push({
      type: AlertType.PROXIES_LOW,
      severity: AlertSeverity.WARNING,
      message: `Low proxies: ${proxiesAvailable} remaining`,
      data: { proxiesAvailable }
    });
  }
  
  // Store alerts in Redis
  await storeAlerts(alerts);
  
  return alerts;
}

// ============================================
// NEW ALERT FUNCTIONS
// ============================================

/**
 * Check for sessions with no recent ping (stale)
 */
async function checkSessionHealth(sessions) {
  const alerts = [];
  const now = Date.now();
  const staleThreshold = 3 * 60 * 1000; // 3 minutes
  
  for (const session of sessions) {
    if (session.status === 'CONNECTED') {
      const lastPing = parseInt(session.lastPing || '0');
      if (lastPing > 0 && (now - lastPing) > staleThreshold) {
        alerts.push({
          type: AlertType.NO_PING,
          severity: AlertSeverity.WARNING,
          message: `Session ${session.sessionId} no ping for ${Math.floor((now - lastPing) / 1000)}s`,
          data: { 
            sessionId: session.sessionId, 
            lastPing,
            secondsSincePing: Math.floor((now - lastPing) / 1000)
          }
        });
      }
    }
    
    if (session.status === 'BANNED') {
      alerts.push({
        type: AlertType.SESSION_BANNED,
        severity: AlertSeverity.ERROR,
        message: `Session ${session.sessionId} was banned`,
        data: { sessionId: session.sessionId, phone: session.phone }
      });
    }
    
    if (session.status === 'LOGGED_OUT') {
      alerts.push({
        type: AlertType.SESSION_LOGGED_OUT,
        severity: AlertSeverity.WARNING,
        message: `Session ${session.sessionId} logged out`,
        data: { sessionId: session.sessionId, phone: session.phone }
      });
    }
  }
  
  return alerts;
}

/**
 * Check proxy capacity alerts
 */
async function checkProxyCapacity(proxyCounts) {
  const alerts = [];
  const maxPerProxy = config.maxSessionsPerProxy || 4;
  
  for (const [proxyId, count] of Object.entries(proxyCounts)) {
    if (count >= maxPerProxy) {
      alerts.push({
        type: AlertType.PROXY_FULL,
        severity: AlertSeverity.WARNING,
        message: `Proxy ${proxyId.slice(-8)} is at capacity (${count}/${maxPerProxy})`,
        data: { proxyId, count, max: maxPerProxy }
      });
    } else if (count >= maxPerProxy - 1) {
      alerts.push({
        type: AlertType.PROXY_ALMOST_FULL,
        severity: AlertSeverity.INFO,
        message: `Proxy ${proxyId.slice(-8)} almost full (${count}/${maxPerProxy})`,
        data: { proxyId, count, max: maxPerProxy }
      });
    }
  }
  
  return alerts;
}

/**
 * Get all stored alerts
 */
async function getStoredAlerts(limit = 50) {
  const redis = getRedis();
  const alerts = await redis.lrange('alerts:inventory', 0, limit - 1);
  return alerts.map(a => JSON.parse(a));
}

/**
 * Get alerts summary
 */
async function getAlertsSummary() {
  const alerts = await getStoredAlerts(100);
  
  const byType = {};
  const bySeverity = {};
  
  for (const alert of alerts) {
    byType[alert.type] = (byType[alert.type] || 0) + 1;
    bySeverity[alert.severity] = (bySeverity[alert.severity] || 0) + 1;
  }
  
  return {
    total: alerts.length,
    byType,
    bySeverity,
    critical: bySeverity[AlertSeverity.CRITICAL] || 0,
    errors: bySeverity[AlertSeverity.ERROR] || 0,
    warnings: bySeverity[AlertSeverity.WARNING] || 0
  };
}

// ============================================
// EXPORTS
// ============================================

module.exports = { 
  AlertType,
  AlertSeverity,
  storeAlerts,
  alertLowInventory,
  checkSessionHealth,
  checkProxyCapacity,
  getStoredAlerts,
  getAlertsSummary
};

/**
 * Session Registry Service
 * 
 * Manages session allocation with atomic Redis operations:
 * - Max 4 sessions per proxy
 * - Max 4 sessions per phone
 * - Sticky phone->proxy mapping (with fallback when proxy is BAD/FULL)
 * - Reason classification for failures
 */

const { getRedis } = require("../infra/redis");
const { config } = require("../config");
const { pushIncident } = require("./incidentService");
const { sendEvent: sendBrainEvent } = require("./sessionBrainClient");

// ============================================
// CONSTANTS
// ============================================
const MAX_SESSIONS_PER_PROXY = config.maxSessionsPerProxy || 4;
const MAX_SESSIONS_PER_PHONE = config.maxSessionsPerPhone || 4;

// Session statuses
const SessionStatus = {
  PENDING: "PENDING",
  PROVISIONING: "PROVISIONING",
  WAITING_QR: "WAITING_QR",
  CONNECTED: "CONNECTED",
  RECONNECTING: "RECONNECTING",
  LOGGED_OUT: "LOGGED_OUT",
  BANNED: "BANNED",
  ERROR: "ERROR",
  STOPPED: "STOPPED"
};

// Failure reasons (taxonomy)
const FailureReason = {
  PROXY_TIMEOUT: "PROXY_TIMEOUT",
  PROXY_AUTH_FAIL: "PROXY_AUTH_FAIL",
  PROXY_BANNED: "PROXY_BANNED",
  PROXY_FULL: "PROXY_FULL",
  WA_LOGGED_OUT: "WA_LOGGED_OUT",
  WA_BANNED: "WA_BANNED",
  WA_RATE_LIMIT: "WA_RATE_LIMIT",
  STREAM_ERROR_515: "STREAM_ERROR_515",
  DEVICE_CONFLICT: "DEVICE_CONFLICT",
  AUTH_CORRUPT: "AUTH_CORRUPT",
  MAX_RECONNECTS: "MAX_RECONNECTS",
  UNKNOWN: "UNKNOWN"
};

// ============================================
// LUA SCRIPTS FOR ATOMIC OPERATIONS
// ============================================

/**
 * Atomic session allocation:
 * 1. Check if phone already has sticky proxy
 * 2. If sticky proxy available and not FULL/BAD -> use it
 * 3. Otherwise find available proxy
 * 4. Increment counters atomically
 * 5. Create session record
 * 
 * KEYS: [1]=phone, [2]=sessionId
 * ARGV: [1]=maxPerProxy, [2]=maxPerPhone, [3]=timestamp, [4]=availableProxiesJSON
 * Returns: JSON {success, proxyId, reason}
 */
const ALLOCATE_SESSION_LUA = `
local phone = KEYS[1]
local sessionId = KEYS[2]
local maxPerProxy = tonumber(ARGV[1])
local maxPerPhone = tonumber(ARGV[2])
local timestamp = ARGV[3]
local proxiesJson = ARGV[4]

-- Check phone session count
local phoneCount = tonumber(redis.call('GET', 'counter:phone:' .. phone) or '0')
if phoneCount >= maxPerPhone then
  return cjson.encode({success=false, reason='PHONE_LIMIT_REACHED', phoneCount=phoneCount})
end

-- Get sticky proxy for this phone
local stickyProxy = redis.call('GET', 'sticky:phone:' .. phone)

-- Parse available proxies
local proxies = cjson.decode(proxiesJson)
local selectedProxy = nil

-- Try sticky proxy first
if stickyProxy then
  local proxyStatus = redis.call('GET', 'proxy:status:' .. stickyProxy)
  if proxyStatus ~= 'BAD' and proxyStatus ~= 'DISABLED' then
    local proxyCount = tonumber(redis.call('GET', 'counter:proxy:' .. stickyProxy) or '0')
    if proxyCount < maxPerProxy then
      selectedProxy = stickyProxy
    end
  end
end

-- If no sticky or sticky unavailable, find available proxy
if not selectedProxy then
  for _, proxy in ipairs(proxies) do
    local proxyStatus = redis.call('GET', 'proxy:status:' .. proxy)
    if proxyStatus ~= 'BAD' and proxyStatus ~= 'DISABLED' then
      local proxyCount = tonumber(redis.call('GET', 'counter:proxy:' .. proxy) or '0')
      if proxyCount < maxPerProxy then
        selectedProxy = proxy
        break
      end
    end
  end
end

if not selectedProxy then
  return cjson.encode({success=false, reason='NO_PROXY_AVAILABLE'})
end

-- Atomic increment and bind
redis.call('INCR', 'counter:phone:' .. phone)
redis.call('INCR', 'counter:proxy:' .. selectedProxy)
redis.call('SET', 'sticky:phone:' .. phone, selectedProxy)

-- Create session record
redis.call('HSET', 'session:' .. sessionId,
  'phone', phone,
  'proxy', selectedProxy,
  'status', 'PENDING',
  'createdAt', timestamp,
  'lastUpdated', timestamp
)

-- Add to active sessions set
redis.call('SADD', 'sessions:active', sessionId)
redis.call('SADD', 'sessions:byPhone:' .. phone, sessionId)
redis.call('SADD', 'sessions:byProxy:' .. selectedProxy, sessionId)

return cjson.encode({success=true, proxyId=selectedProxy, sessionId=sessionId})
`;

/**
 * Atomic session release:
 * Decrement counters and cleanup
 * 
 * KEYS: [1]=sessionId
 * Returns: JSON {success, phone, proxy}
 */
const RELEASE_SESSION_LUA = `
local sessionId = KEYS[1]

-- Get session data
local phone = redis.call('HGET', 'session:' .. sessionId, 'phone')
local proxy = redis.call('HGET', 'session:' .. sessionId, 'proxy')

if not phone or not proxy then
  return cjson.encode({success=false, reason='SESSION_NOT_FOUND'})
end

-- Decrement counters (min 0)
local phoneCount = tonumber(redis.call('GET', 'counter:phone:' .. phone) or '0')
if phoneCount > 0 then
  redis.call('DECR', 'counter:phone:' .. phone)
end

local proxyCount = tonumber(redis.call('GET', 'counter:proxy:' .. proxy) or '0')
if proxyCount > 0 then
  redis.call('DECR', 'counter:proxy:' .. proxy)
end

-- Remove from active sets
redis.call('SREM', 'sessions:active', sessionId)
redis.call('SREM', 'sessions:byPhone:' .. phone, sessionId)
redis.call('SREM', 'sessions:byProxy:' .. proxy, sessionId)

-- Update session status
redis.call('HSET', 'session:' .. sessionId, 'status', 'STOPPED', 'lastUpdated', ARGV[1])

return cjson.encode({success=true, phone=phone, proxy=proxy})
`;

// ============================================
// SESSION REGISTRY FUNCTIONS
// ============================================

/**
 * Allocate a new session for a phone number
 */
async function allocateSession(phone, sessionId, availableProxies) {
  const redis = getRedis();
  const timestamp = Date.now().toString();
  
  const result = await redis.eval(
    ALLOCATE_SESSION_LUA,
    2,
    phone,
    sessionId,
    MAX_SESSIONS_PER_PROXY,
    MAX_SESSIONS_PER_PHONE,
    timestamp,
    JSON.stringify(availableProxies)
  );
  
  return JSON.parse(result);
}

/**
 * Release a session (on stop/logout/ban)
 */
async function releaseSession(sessionId) {
  const redis = getRedis();
  const timestamp = Date.now().toString();
  
  const result = await redis.eval(
    RELEASE_SESSION_LUA,
    1,
    sessionId,
    timestamp
  );
  
  return JSON.parse(result);
}

/**
 * Update session status
 */
async function updateSessionStatus(sessionId, status, extra = {}) {
  const redis = getRedis();
  const timestamp = Date.now().toString();
  
  const updates = {
    status,
    lastUpdated: timestamp,
    ...extra
  };
  
  const args = [];
  for (const [key, value] of Object.entries(updates)) {
    args.push(key, String(value));
  }
  
  await redis.hset(`session:${sessionId}`, ...args);
  
  // If status is terminal, release the session
  if ([SessionStatus.LOGGED_OUT, SessionStatus.BANNED, SessionStatus.STOPPED].includes(status)) {
    await releaseSession(sessionId);
  }
}

/**
 * Get session details
 */
async function getSession(sessionId) {
  const redis = getRedis();
  const data = await redis.hgetall(`session:${sessionId}`);
  
  if (!data || Object.keys(data).length === 0) {
    return null;
  }
  
  return data;
}

/**
 * Get all active sessions
 */
async function getActiveSessions() {
  const redis = getRedis();
  const sessionIds = await redis.smembers('sessions:active');
  
  const sessions = [];
  for (const id of sessionIds) {
    const session = await getSession(id);
    if (session) {
      sessions.push({ sessionId: id, ...session });
    }
  }
  
  return sessions;
}

/**
 * Get sessions by phone
 */
async function getSessionsByPhone(phone) {
  const redis = getRedis();
  const sessionIds = await redis.smembers(`sessions:byPhone:${phone}`);
  
  const sessions = [];
  for (const id of sessionIds) {
    const session = await getSession(id);
    if (session) {
      sessions.push({ sessionId: id, ...session });
    }
  }
  
  return sessions;
}

/**
 * Get sessions by proxy
 */
async function getSessionsByProxy(proxyId) {
  const redis = getRedis();
  const sessionIds = await redis.smembers(`sessions:byProxy:${proxyId}`);
  
  const sessions = [];
  for (const id of sessionIds) {
    const session = await getSession(id);
    if (session) {
      sessions.push({ sessionId: id, ...session });
    }
  }
  
  return sessions;
}

/**
 * Get counters for monitoring
 */
async function getCounters() {
  const redis = getRedis();
  
  // Get all counter keys
  const phoneKeys = await redis.keys('counter:phone:*');
  const proxyKeys = await redis.keys('counter:proxy:*');
  
  const phoneCounts = {};
  for (const key of phoneKeys) {
    const phone = key.replace('counter:phone:', '');
    phoneCounts[phone] = parseInt(await redis.get(key) || '0');
  }
  
  const proxyCounts = {};
  for (const key of proxyKeys) {
    const proxy = key.replace('counter:proxy:', '');
    proxyCounts[proxy] = parseInt(await redis.get(key) || '0');
  }
  
  return { phoneCounts, proxyCounts };
}

/**
 * Mark proxy as BAD with cooldown
 * @param {string} proxyId - Proxy identifier
 * @param {string} reason - Why it's bad
 * @param {number} cooldownMs - Cooldown period in ms (default 30 min)
 */
async function markProxyBad(proxyId, reason, cooldownMs = 30 * 60 * 1000) {
  const redis = getRedis();
  const now = Date.now();
  const cooldownUntil = now + cooldownMs;
  
  await redis.set(`proxy:status:${proxyId}`, 'BAD');
  await redis.set(`proxy:badReason:${proxyId}`, reason);
  await redis.set(`proxy:badAt:${proxyId}`, now.toString());
  await redis.set(`proxy:cooldownUntil:${proxyId}`, cooldownUntil.toString());
  
  // Auto-expire after cooldown (proxy becomes available again)
  const ttlSeconds = Math.ceil(cooldownMs / 1000);
  await redis.expire(`proxy:status:${proxyId}`, ttlSeconds);
  
  console.log(`[Proxy] Marked ${proxyId.slice(-12)} as BAD: ${reason}, cooldown ${cooldownMs/1000}s`);
}

/**
 * Mark proxy as OK (clear BAD status)
 */
async function markProxyOk(proxyId) {
  const redis = getRedis();
  await redis.del(`proxy:status:${proxyId}`);
  await redis.del(`proxy:badReason:${proxyId}`);
  await redis.del(`proxy:badAt:${proxyId}`);
  await redis.del(`proxy:cooldownUntil:${proxyId}`);
  
  console.log(`[Proxy] Marked ${proxyId.slice(-12)} as OK`);
}

/**
 * Check if proxy is available (not BAD or past cooldown)
 */
async function isProxyAvailable(proxyId) {
  const redis = getRedis();
  const status = await redis.get(`proxy:status:${proxyId}`);
  
  if (!status) return true;
  if (status !== 'BAD') return true;
  
  // Check cooldown
  const cooldownUntil = parseInt(await redis.get(`proxy:cooldownUntil:${proxyId}`) || '0');
  if (cooldownUntil > 0 && Date.now() > cooldownUntil) {
    // Cooldown expired, clear BAD status
    await markProxyOk(proxyId);
    return true;
  }
  
  return false;
}

/**
 * Get proxy health info
 */
async function getProxyHealth(proxyId) {
  const redis = getRedis();
  const status = await redis.get(`proxy:status:${proxyId}`);
  const reason = await redis.get(`proxy:badReason:${proxyId}`);
  const badAt = await redis.get(`proxy:badAt:${proxyId}`);
  const cooldownUntil = await redis.get(`proxy:cooldownUntil:${proxyId}`);
  const sessionCount = parseInt(await redis.get(`counter:proxy:${proxyId}`) || '0');
  
  return {
    proxyId,
    status: status || 'OK',
    reason,
    badAt: badAt ? parseInt(badAt) : null,
    cooldownUntil: cooldownUntil ? parseInt(cooldownUntil) : null,
    sessionCount,
    available: !status || status !== 'BAD' || (cooldownUntil && Date.now() > parseInt(cooldownUntil))
  };
}

/**
 * Switch session to new proxy (when current proxy burns)
 */
async function switchSessionProxy(sessionId, newProxyId) {
  const redis = getRedis();
  const session = await getSession(sessionId);
  
  if (!session) {
    return { success: false, reason: 'SESSION_NOT_FOUND' };
  }
  
  const oldProxyId = session.proxy;
  const phone = session.phone;
  
  // Decrement old proxy counter
  if (oldProxyId) {
    const oldCount = parseInt(await redis.get(`counter:proxy:${oldProxyId}`) || '0');
    if (oldCount > 0) {
      await redis.decr(`counter:proxy:${oldProxyId}`);
    }
    await redis.srem(`sessions:byProxy:${oldProxyId}`, sessionId);
  }
  
  // Increment new proxy counter
  await redis.incr(`counter:proxy:${newProxyId}`);
  await redis.sadd(`sessions:byProxy:${newProxyId}`, sessionId);
  
  // Update sticky mapping
  await redis.set(`sticky:phone:${phone}`, newProxyId);
  
  // Update session record
  await redis.hset(`session:${sessionId}`, 
    'proxy', newProxyId,
    'lastUpdated', Date.now().toString(),
    'proxySwitchedAt', Date.now().toString(),
    'previousProxy', oldProxyId || ''
  );
  
  console.log(`[Proxy] Switched session ${sessionId} from ${oldProxyId?.slice(-12) || 'none'} to ${newProxyId.slice(-12)}`);
  
  return { 
    success: true, 
    sessionId, 
    oldProxy: oldProxyId, 
    newProxy: newProxyId 
  };
}

// ============================================
// REASON CLASSIFIER
// ============================================

/**
 * Classify failure reason from webhook events and context
 */
function classifyFailureReason(events, sessionMeta = {}) {
  if (!events || events.length === 0) {
    return FailureReason.UNKNOWN;
  }
  
  // Sort events by timestamp (newest first)
  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
  
  // Check recent events for patterns
  const recentEvents = sorted.slice(0, 20);
  
  // Count reconnects in last 5 minutes
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const recentReconnects = recentEvents.filter(
    e => e.type === 'STATUS_CHANGE' && 
    e.data?.status === 'RECONNECTING' && 
    e.timestamp > fiveMinAgo
  ).length;
  
  // Check for specific status changes
  for (const event of recentEvents) {
    if (event.type === 'STATUS_CHANGE') {
      const status = event.data?.status;
      
      if (status === 'LOGGED_OUT') {
        return FailureReason.WA_LOGGED_OUT;
      }
      
      if (status === 'MAX_RECONNECTS_EXCEEDED') {
        return FailureReason.MAX_RECONNECTS;
      }
    }
    
    // Check for 515 errors
    if (event.data?.statusCode === 515 || 
        event.data?.error?.includes('515') ||
        event.data?.error?.includes('Stream Errored')) {
      return FailureReason.STREAM_ERROR_515;
    }
    
    // Check for proxy errors
    if (event.data?.error?.includes('proxy') || 
        event.data?.error?.includes('ECONNREFUSED') ||
        event.data?.error?.includes('ETIMEDOUT')) {
      return FailureReason.PROXY_TIMEOUT;
    }
  }
  
  // Many reconnects in short time = rate limit suspicion
  if (recentReconnects >= 5) {
    return FailureReason.WA_RATE_LIMIT;
  }
  
  return FailureReason.UNKNOWN;
}

/**
 * Process webhook event and update session registry
 */
async function processWebhookEvent(event) {
  const { sessionId, type, data, meta } = event;
  const redis = getRedis();
  
  // Get current session
  const session = await getSession(sessionId);
  if (!session) {
    console.warn(`[SessionRegistry] Unknown session: ${sessionId}`);
    return;
  }
  
  // Update based on event type
  switch (type) {
    case 'QR_UPDATE':
      await updateSessionStatus(sessionId, SessionStatus.WAITING_QR);
      break;
      
    case 'CONNECTED':
      await updateSessionStatus(sessionId, SessionStatus.CONNECTED, {
        phoneNumber: data.phoneNumber || '',
        jid: data.jid || '',
        connectedAt: Date.now().toString()
      });
      await pushIncident({
        type: "SESSION_CONNECTED",
        sessionId,
        phone: data.phoneNumber || session.phone || "",
        proxyId: session.proxy || ""
      });
      await sendBrainEvent({
        ip: String(session.proxy || `session:${sessionId}`),
        session: String(sessionId),
        endpoint: "webhook:CONNECTED",
        status: 200,
        backend: "orchestrator:webhook",
        error: null,
        meta: { phone: data.phoneNumber || session.phone || "" }
      });
      break;
      
    case 'STATUS_CHANGE':
      if (data.status === 'RECONNECTING') {
        // Only update to RECONNECTING if not already showing QR
        // (QR means reconnection is progressing well)
        const currentSession = await redis.hgetall(`session:${sessionId}`);
        if (currentSession.status !== SessionStatus.WAITING_QR) {
          await updateSessionStatus(sessionId, SessionStatus.RECONNECTING, {
            reconnectAttempt: data.attempt || 1
          });
        }
      } else if (data.status === 'LOGGED_OUT') {
        await updateSessionStatus(sessionId, SessionStatus.LOGGED_OUT, {
          failureReason: FailureReason.WA_LOGGED_OUT
        });
        await pushIncident({
          type: "SESSION_LOGGED_OUT",
          sessionId,
          phone: session.phone || session.phoneNumber || data.phoneNumber || "",
          proxyId: session.proxy || "",
          reason: FailureReason.WA_LOGGED_OUT
        });
        await sendBrainEvent({
          ip: String(session.proxy || `session:${sessionId}`),
          session: String(sessionId),
          endpoint: "webhook:STATUS_CHANGE",
          status: 401,
          backend: "orchestrator:webhook",
          error: FailureReason.WA_LOGGED_OUT,
          meta: { phone: session.phone || "", status: "LOGGED_OUT" }
        });
      } else if (data.status === 'MAX_RECONNECTS_EXCEEDED') {
        await updateSessionStatus(sessionId, SessionStatus.ERROR, {
          failureReason: FailureReason.MAX_RECONNECTS
        });
        await pushIncident({
          type: "SESSION_MAX_RECONNECTS",
          sessionId,
          phone: session.phone || session.phoneNumber || "",
          proxyId: session.proxy || "",
          reason: FailureReason.MAX_RECONNECTS
        });
        await sendBrainEvent({
          ip: String(session.proxy || `session:${sessionId}`),
          session: String(sessionId),
          endpoint: "webhook:STATUS_CHANGE",
          status: 503,
          backend: "orchestrator:webhook",
          error: FailureReason.MAX_RECONNECTS,
          meta: { phone: session.phone || "", status: "MAX_RECONNECTS_EXCEEDED" }
        });
      }
      break;
      
    case 'PING':
      await redis.hset(`session:${sessionId}`, 
        'lastPing', Date.now().toString(),
        'uptime', data.uptime?.toString() || '0'
      );
      break;
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Constants
  SessionStatus,
  FailureReason,
  MAX_SESSIONS_PER_PROXY,
  MAX_SESSIONS_PER_PHONE,
  
  // Session management
  allocateSession,
  releaseSession,
  updateSessionStatus,
  getSession,
  getActiveSessions,
  getSessionsByPhone,
  getSessionsByProxy,
  getCounters,
  
  // Proxy management
  markProxyBad,
  markProxyOk,
  isProxyAvailable,
  getProxyHealth,
  switchSessionProxy,
  
  // Classification
  classifyFailureReason,
  processWebhookEvent
};


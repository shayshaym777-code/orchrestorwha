/**
 * Session Router
 * 
 * Intelligent session selection for message sending:
 * - Load balancing across sessions
 * - Sticky routing for conversations
 * - Health-based selection
 * - Future: routing to different providers (Baileys, Cloud API, etc.)
 */

/**
 * Session selection strategies
 */
const Strategy = {
  ROUND_ROBIN: "round_robin",
  LEAST_LOADED: "least_loaded",
  STICKY: "sticky",
  RANDOM: "random",
  HEALTH_BASED: "health_based",
};

// State for round-robin
let roundRobinIndex = 0;

// State for sticky routing (recipient -> sessionId)
const stickyMap = new Map();
const STICKY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Select a session for sending a message
 * 
 * @param {Array} sessions - Available sessions from Orchestrator
 * @param {Object} job - The job containing message details
 * @param {Object} options - Selection options
 * @returns {Object} Selected session
 */
function selectSession(sessions, job, options = {}) {
  if (!sessions || sessions.length === 0) {
    throw new Error("No sessions available");
  }
  
  // Filter to only healthy sessions
  const healthySessions = sessions.filter(s => 
    s.status === "CONNECTED" && 
    !s.banned && 
    !s.rateLimited
  );
  
  if (healthySessions.length === 0) {
    // Fall back to any CONNECTED session
    const connected = sessions.filter(s => s.status === "CONNECTED");
    if (connected.length === 0) {
      throw new Error("No connected sessions available");
    }
    return connected[0];
  }
  
  const strategy = options.strategy || Strategy.HEALTH_BASED;
  const recipient = job.message?.to;
  
  // Check for preferred session in job
  if (job.routing?.preferredSession) {
    const preferred = healthySessions.find(s => s.sessionId === job.routing.preferredSession);
    if (preferred) {
      return preferred;
    }
  }
  
  // Check for from number routing
  if (job.routing?.fromNumber) {
    const matching = healthySessions.find(s => s.phone === job.routing.fromNumber);
    if (matching) {
      return matching;
    }
  }
  
  // Apply strategy
  switch (strategy) {
    case Strategy.STICKY:
      return selectSticky(healthySessions, recipient);
      
    case Strategy.ROUND_ROBIN:
      return selectRoundRobin(healthySessions);
      
    case Strategy.LEAST_LOADED:
      return selectLeastLoaded(healthySessions);
      
    case Strategy.RANDOM:
      return selectRandom(healthySessions);
      
    case Strategy.HEALTH_BASED:
    default:
      return selectHealthBased(healthySessions, recipient);
  }
}

/**
 * Sticky routing - same recipient always goes to same session
 */
function selectSticky(sessions, recipient) {
  if (!recipient) {
    return selectRandom(sessions);
  }
  
  // Check existing sticky mapping
  const sticky = stickyMap.get(recipient);
  if (sticky && sticky.expiresAt > Date.now()) {
    const session = sessions.find(s => s.sessionId === sticky.sessionId);
    if (session) {
      return session;
    }
  }
  
  // Create new sticky mapping
  const selected = selectLeastLoaded(sessions);
  stickyMap.set(recipient, {
    sessionId: selected.sessionId,
    expiresAt: Date.now() + STICKY_TTL_MS
  });
  
  return selected;
}

/**
 * Round-robin selection
 */
function selectRoundRobin(sessions) {
  const selected = sessions[roundRobinIndex % sessions.length];
  roundRobinIndex++;
  return selected;
}

/**
 * Select session with least messages in last hour
 */
function selectLeastLoaded(sessions) {
  // Sort by message count (ascending)
  const sorted = [...sessions].sort((a, b) => {
    const aCount = a.messageCount || 0;
    const bCount = b.messageCount || 0;
    return aCount - bCount;
  });
  
  return sorted[0];
}

/**
 * Random selection
 */
function selectRandom(sessions) {
  const index = Math.floor(Math.random() * sessions.length);
  return sessions[index];
}

/**
 * Health-based selection (combines multiple factors)
 */
function selectHealthBased(sessions, recipient) {
  // Score each session
  const scored = sessions.map(session => {
    let score = 100;
    
    // Penalize high message count
    const msgCount = session.messageCount || 0;
    score -= Math.min(msgCount / 10, 30);
    
    // Penalize recent errors
    const errorCount = session.recentErrors || 0;
    score -= errorCount * 10;
    
    // Penalize if last ping is old
    const lastPing = session.lastPing ? parseInt(session.lastPing) : 0;
    const pingAge = lastPing > 0 ? Date.now() - lastPing : 60000;
    if (pingAge > 120000) { // 2 minutes
      score -= 20;
    }
    
    // Bonus for sticky match
    if (recipient) {
      const sticky = stickyMap.get(recipient);
      if (sticky && sticky.sessionId === session.sessionId) {
        score += 20;
      }
    }
    
    // Add some randomness to prevent all traffic going to one session
    score += Math.random() * 10;
    
    return { session, score };
  });
  
  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);
  
  // Update sticky mapping for top choice
  if (recipient && scored[0]) {
    stickyMap.set(recipient, {
      sessionId: scored[0].session.sessionId,
      expiresAt: Date.now() + STICKY_TTL_MS
    });
  }
  
  return scored[0].session;
}

/**
 * Clear expired sticky mappings
 */
function cleanupStickyMap() {
  const now = Date.now();
  for (const [key, value] of stickyMap) {
    if (value.expiresAt < now) {
      stickyMap.delete(key);
    }
  }
}

// Cleanup every hour
setInterval(cleanupStickyMap, 60 * 60 * 1000);

/**
 * Get routing statistics
 */
function getRoutingStats() {
  return {
    roundRobinIndex,
    stickyMapSize: stickyMap.size,
    strategies: Object.values(Strategy),
  };
}

/**
 * Clear sticky mapping for a recipient
 */
function clearSticky(recipient) {
  stickyMap.delete(recipient);
}

/**
 * Clear all sticky mappings
 */
function clearAllSticky() {
  stickyMap.clear();
  roundRobinIndex = 0;
}

module.exports = {
  selectSession,
  Strategy,
  getRoutingStats,
  clearSticky,
  clearAllSticky,
};


/**
 * Smart Warming Dispatcher
 * 
 * Intelligently routes messages to sessions based on trust level
 * to prevent bans while maximizing throughput
 */

const { getRedis } = require("../infra/redis");
const {
  TRUST_LEVEL,
  canSessionSend,
  recordMessageSent,
  getSessionGradeInfo,
  getAllSessionsByGrade
} = require("./sessionGradingService");

/**
 * Message priority levels
 */
const MESSAGE_PRIORITY = {
  HIGH: 3,      // VIP/urgent - use best sessions
  NORMAL: 2,    // Regular campaign messages
  WARMUP: 1     // Warming messages for new sessions
};

/**
 * Select the best session for sending a message
 * 
 * @param {Object} options
 * @param {string} options.targetPhone - Target phone number
 * @param {number} options.priority - Message priority (HIGH, NORMAL, WARMUP)
 * @param {string} options.preferredSessionId - Preferred session (optional)
 * @param {boolean} options.allowCold - Allow cold sessions (for warmup only)
 */
async function selectBestSession(options = {}) {
  const {
    targetPhone,
    priority = MESSAGE_PRIORITY.NORMAL,
    preferredSessionId = null,
    allowCold = false
  } = options;
  
  const redis = getRedis();
  const sessions = await getAllSessionsByGrade();
  
  // If preferred session is specified and available, use it
  if (preferredSessionId) {
    const info = await getSessionGradeInfo(preferredSessionId);
    if (info.canSend) {
      return {
        sessionId: preferredSessionId,
        grade: info.grade,
        reason: "PREFERRED_SESSION"
      };
    }
  }
  
  // For WARMUP messages, prefer cold sessions
  if (priority === MESSAGE_PRIORITY.WARMUP || allowCold) {
    // Find a cold session that can send
    for (const session of sessions.cold) {
      if (session.canSend) {
        return {
          sessionId: session.sessionId,
          grade: "Cold",
          reason: "WARMUP_COLD_SESSION"
        };
      }
    }
    
    // Fallback to warming if no cold available
    for (const session of sessions.warming) {
      if (session.canSend) {
        return {
          sessionId: session.sessionId,
          grade: "Warming",
          reason: "WARMUP_WARMING_SESSION"
        };
      }
    }
  }
  
  // For HIGH priority, only use HOT sessions
  if (priority === MESSAGE_PRIORITY.HIGH) {
    for (const session of sessions.hot) {
      if (session.canSend) {
        return {
          sessionId: session.sessionId,
          grade: "Hot",
          reason: "HIGH_PRIORITY_HOT_SESSION"
        };
      }
    }
    
    // No hot sessions available
    return { 
      sessionId: null,
      grade: null,
      reason: "NO_HOT_SESSIONS_AVAILABLE",
      error: true
    };
  }
  
  // For NORMAL priority: Hot > Warming > (never Cold for production)
  
  // Try hot sessions first
  for (const session of sessions.hot) {
    if (session.canSend) {
      return {
        sessionId: session.sessionId,
        grade: "Hot",
        reason: "NORMAL_HOT_SESSION"
      };
    }
  }
  
  // Then warming sessions
  for (const session of sessions.warming) {
    if (session.canSend) {
      return {
        sessionId: session.sessionId,
        grade: "Warming",
        reason: "NORMAL_WARMING_SESSION"
      };
    }
  }
  
  // Never use cold sessions for normal messages!
  // This is intentional - cold sessions are for warmup only
  
  return {
    sessionId: null,
    grade: null,
    reason: "NO_SESSIONS_AVAILABLE",
    error: true,
    stats: {
      hotCount: sessions.hot.length,
      warmingCount: sessions.warming.length,
      coldCount: sessions.cold.length
    }
  };
}

/**
 * Dispatch a message through the smart router
 */
async function dispatchMessage(options) {
  const {
    targetPhone,
    message,
    priority = MESSAGE_PRIORITY.NORMAL,
    preferredSessionId = null,
    jobId = null
  } = options;
  
  const redis = getRedis();
  
  // Select best session
  const selection = await selectBestSession({
    targetPhone,
    priority,
    preferredSessionId,
    allowCold: priority === MESSAGE_PRIORITY.WARMUP
  });
  
  if (selection.error || !selection.sessionId) {
    // Queue the message for later
    await queueMessageForLater({
      targetPhone,
      message,
      priority,
      jobId,
      reason: selection.reason
    });
    
    return {
      status: "QUEUED",
      reason: selection.reason,
      ...selection
    };
  }
  
  // Record that we're about to send
  const sendResult = await recordMessageSent(selection.sessionId);
  
  // Add to outgoing queue for the selected session
  const messageData = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    targetPhone,
    message,
    priority,
    jobId,
    sessionId: selection.sessionId,
    grade: selection.grade,
    timestamp: Date.now(),
    cooldownUntil: Date.now() + sendResult.cooldownMs
  };
  
  await redis.lpush(`queue:outgoing:${selection.sessionId}`, JSON.stringify(messageData));
  
  // Store dispatch record
  await redis.lpush("dispatch:log", JSON.stringify({
    ...messageData,
    reason: selection.reason
  }));
  await redis.ltrim("dispatch:log", 0, 999); // Keep last 1000
  
  return { 
    status: "DISPATCHED",
    messageId: messageData.id,
    sessionId: selection.sessionId,
    grade: selection.grade,
    reason: selection.reason,
    cooldownSec: sendResult.cooldownSec
  };
}

/**
 * Queue a message for later when no sessions available
 */
async function queueMessageForLater(data) {
  const redis = getRedis();
  
  const queueItem = {
    ...data,
    queuedAt: Date.now(),
    retryCount: 0
  };
  
  // Use sorted set with priority as score for smart ordering
  await redis.zadd("queue:pending", data.priority, JSON.stringify(queueItem));
  
  return queueItem;
}

/**
 * Process pending queue - called periodically
 */
async function processPendingQueue(maxItems = 10) {
  const redis = getRedis();
  
  // Get highest priority items first
  const items = await redis.zrevrange("queue:pending", 0, maxItems - 1);
  
  const results = [];
  
  for (const itemJson of items) {
    const item = JSON.parse(itemJson);
    
    // Try to dispatch
    const result = await dispatchMessage({
      targetPhone: item.targetPhone,
      message: item.message,
      priority: item.priority,
      jobId: item.jobId
    });
    
    if (result.status === "DISPATCHED") {
      // Remove from pending queue
      await redis.zrem("queue:pending", itemJson);
      results.push({ ...result, fromQueue: true });
      } else {
      // Increment retry count
      item.retryCount = (item.retryCount || 0) + 1;
      
      if (item.retryCount > 10) {
        // Too many retries, move to failed
        await redis.zrem("queue:pending", itemJson);
        await redis.lpush("queue:failed", JSON.stringify({
          ...item,
          failedAt: Date.now(),
          reason: "MAX_RETRIES_EXCEEDED"
        }));
      }
    }
  }
  
  return results;
}

/**
 * Distribute a campaign across available sessions
 */
async function distributeCampaign(campaign) {
  const {
    id: campaignId,
    targets,  // Array of phone numbers
    message,
    priority = MESSAGE_PRIORITY.NORMAL
  } = campaign;
  
  const redis = getRedis();
  const sessions = await getAllSessionsByGrade();
  
  // Calculate capacity
  const hotCapacity = sessions.hot.reduce((sum, s) => sum + s.stats.remainingToday, 0);
  const warmingCapacity = sessions.warming.reduce((sum, s) => sum + s.stats.remainingToday, 0);
  const coldCapacity = sessions.cold.reduce((sum, s) => sum + s.stats.remainingToday, 0);
  
  const totalTargets = targets.length;
  const totalCapacity = hotCapacity + warmingCapacity; // Don't use cold for campaigns
  
  console.log(`[Dispatcher] Campaign ${campaignId}: ${totalTargets} targets`);
  console.log(`[Dispatcher] Capacity: Hot=${hotCapacity}, Warming=${warmingCapacity}, Cold=${coldCapacity}`);
  
  if (totalTargets > totalCapacity) {
    console.log(`[Dispatcher] WARNING: Campaign exceeds daily capacity! Will take multiple days.`);
  }
  
  // Distribution plan
  const plan = {
    campaignId,
    totalTargets,
    capacity: {
      hot: hotCapacity,
      warming: warmingCapacity,
      cold: coldCapacity,
      total: totalCapacity
    },
    distribution: [],
    overflow: 0
  };
  
  let assigned = 0;
  
  // Assign to hot sessions first (they can handle the load)
  for (const session of sessions.hot) {
    if (assigned >= totalTargets) break;
    
    const toAssign = Math.min(session.stats.remainingToday, totalTargets - assigned);
    if (toAssign > 0) {
      plan.distribution.push({
        sessionId: session.sessionId,
        grade: "Hot",
        count: toAssign
      });
      assigned += toAssign;
    }
  }
  
  // Then warming sessions
  for (const session of sessions.warming) {
    if (assigned >= totalTargets) break;
    
    const toAssign = Math.min(session.stats.remainingToday, totalTargets - assigned);
    if (toAssign > 0) {
      plan.distribution.push({
        sessionId: session.sessionId,
        grade: "Warming",
        count: toAssign
      });
      assigned += toAssign;
    }
  }
  
  // Optionally use cold sessions for "warmup" portion only (max 5 per cold session)
  const warmupFromCampaign = Math.min(totalTargets - assigned, sessions.cold.length * 5);
  if (warmupFromCampaign > 0) {
    for (const session of sessions.cold) {
      if (assigned >= totalTargets) break;
      
      const toAssign = Math.min(5, session.stats.remainingToday, totalTargets - assigned);
      if (toAssign > 0) {
        plan.distribution.push({
          sessionId: session.sessionId,
          grade: "Cold",
          count: toAssign,
          isWarmup: true
        });
        assigned += toAssign;
      }
    }
  }
  
  plan.overflow = totalTargets - assigned;
  
  // Store plan
  await redis.set(`campaign:plan:${campaignId}`, JSON.stringify(plan), "EX", 86400);
  
  return plan;
}

/**
 * Execute campaign based on distribution plan
 */
async function executeCampaignPlan(campaignId, targets, message) {
  const redis = getRedis();
  
  const planJson = await redis.get(`campaign:plan:${campaignId}`);
  if (!planJson) {
    return { error: "PLAN_NOT_FOUND" };
  }
  
  const plan = JSON.parse(planJson);
  let targetIndex = 0;
  const results = [];
  
  for (const assignment of plan.distribution) {
    for (let i = 0; i < assignment.count && targetIndex < targets.length; i++) {
      const target = targets[targetIndex++];
      
      const result = await dispatchMessage({
        targetPhone: target,
        message,
        priority: assignment.isWarmup ? MESSAGE_PRIORITY.WARMUP : MESSAGE_PRIORITY.NORMAL,
        preferredSessionId: assignment.sessionId,
        jobId: `${campaignId}-${targetIndex}`
      });
      
      results.push(result);
    }
  }
  
  // Queue overflow for later
  if (plan.overflow > 0) {
    const overflow = targets.slice(targetIndex);
    for (const target of overflow) {
      await queueMessageForLater({
        targetPhone: target,
        message,
        priority: MESSAGE_PRIORITY.NORMAL,
        jobId: `${campaignId}-overflow-${targetIndex++}`
      });
    }
  }
  
  return {
    campaignId,
    dispatched: results.filter(r => r.status === "DISPATCHED").length,
    queued: results.filter(r => r.status === "QUEUED").length,
    overflow: plan.overflow
  };
}

/**
 * Generate warmup tasks for cold sessions
 */
async function generateWarmupTasks() {
  const redis = getRedis();
  const sessions = await getAllSessionsByGrade();
  
  const tasks = [];
  
  // For each cold session, generate internal ping/test messages
  for (const session of sessions.cold) {
    if (!session.canSend) continue;
    
    // Generate up to the daily limit of warmup messages
    const warmupCount = Math.min(3, session.stats.remainingToday);
    
    for (let i = 0; i < warmupCount; i++) {
      tasks.push({
        sessionId: session.sessionId,
        type: "WARMUP_PING",
        priority: MESSAGE_PRIORITY.WARMUP
      });
    }
  }
  
  // Store tasks
  if (tasks.length > 0) {
    await redis.set("warmup:tasks", JSON.stringify(tasks), "EX", 3600);
  }
  
  console.log(`[Dispatcher] Generated ${tasks.length} warmup tasks for ${sessions.cold.length} cold sessions`);
  
  return tasks;
}

/**
 * Get dispatcher status and stats
 */
async function getDispatcherStatus() {
  const redis = getRedis();
  const sessions = await getAllSessionsByGrade();
  
  const pendingCount = await redis.zcard("queue:pending") || 0;
  const failedCount = await redis.llen("queue:failed") || 0;
  
  return {
    timestamp: Date.now(),
    sessions: {
      hot: {
        count: sessions.hot.length,
        capacity: sessions.hot.reduce((sum, s) => sum + s.stats.remainingToday, 0),
        sessions: sessions.hot.map(s => ({
          id: s.sessionId,
          remaining: s.stats.remainingToday,
          canSend: s.canSend
        }))
      },
      warming: {
        count: sessions.warming.length,
        capacity: sessions.warming.reduce((sum, s) => sum + s.stats.remainingToday, 0),
        sessions: sessions.warming.map(s => ({
          id: s.sessionId,
          remaining: s.stats.remainingToday,
          canSend: s.canSend
        }))
      },
      cold: {
        count: sessions.cold.length,
        capacity: sessions.cold.reduce((sum, s) => sum + s.stats.remainingToday, 0),
        sessions: sessions.cold.map(s => ({
          id: s.sessionId,
          remaining: s.stats.remainingToday,
          canSend: s.canSend
        }))
      }
    },
    queues: {
      pending: pendingCount,
      failed: failedCount
    },
    totalCapacity: sessions.hot.reduce((sum, s) => sum + s.stats.remainingToday, 0) +
                   sessions.warming.reduce((sum, s) => sum + s.stats.remainingToday, 0)
  };
}

module.exports = {
  MESSAGE_PRIORITY,
  selectBestSession,
  dispatchMessage,
  processPendingQueue,
  distributeCampaign,
  executeCampaignPlan,
  generateWarmupTasks,
  getDispatcherStatus
};

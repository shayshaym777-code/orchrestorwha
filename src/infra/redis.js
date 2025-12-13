const Redis = require("ioredis");

const { config } = require("../config");

let redisClient = null;
let redisBlockingClient = null;
let useMemory = false;

// In-memory fallback storage when Redis is not available
const memoryStore = {
  strings: new Map(),
  hashes: new Map(),
  sets: new Map(),
  lists: new Map()
};

// Memory-based mock Redis client
class MemoryRedis {
  constructor() {
    this.connected = true;
  }

  async get(key) {
    return memoryStore.strings.get(key) || null;
  }

  async set(key, value, ...args) {
    memoryStore.strings.set(key, value);
    return 'OK';
  }

  async del(key) {
    memoryStore.strings.delete(key);
    memoryStore.hashes.delete(key);
    memoryStore.sets.delete(key);
    memoryStore.lists.delete(key);
    return 1;
  }

  async hget(key, field) {
    const hash = memoryStore.hashes.get(key);
    return hash ? hash.get(field) || null : null;
  }

  async hset(key, field, value) {
    if (!memoryStore.hashes.has(key)) {
      memoryStore.hashes.set(key, new Map());
    }
    memoryStore.hashes.get(key).set(field, value);
    return 1;
  }

  async hgetall(key) {
    const hash = memoryStore.hashes.get(key);
    if (!hash) return null;
    const result = {};
    for (const [k, v] of hash) {
      result[k] = v;
    }
    return result;
  }

  async hdel(key, ...fields) {
    const hash = memoryStore.hashes.get(key);
    if (!hash) return 0;
    let count = 0;
    for (const field of fields) {
      if (hash.delete(field)) count++;
    }
    return count;
  }

  async sadd(key, ...members) {
    if (!memoryStore.sets.has(key)) {
      memoryStore.sets.set(key, new Set());
    }
    const set = memoryStore.sets.get(key);
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added++;
      }
    }
    return added;
  }

  async srem(key, ...members) {
    const set = memoryStore.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed++;
    }
    return removed;
  }

  async smembers(key) {
    const set = memoryStore.sets.get(key);
    return set ? Array.from(set) : [];
  }

  async sismember(key, member) {
    const set = memoryStore.sets.get(key);
    return set && set.has(member) ? 1 : 0;
  }

  async lpush(key, ...values) {
    if (!memoryStore.lists.has(key)) {
      memoryStore.lists.set(key, []);
    }
    const list = memoryStore.lists.get(key);
    list.unshift(...values.reverse());
    return list.length;
  }

  async rpush(key, ...values) {
    if (!memoryStore.lists.has(key)) {
      memoryStore.lists.set(key, []);
    }
    const list = memoryStore.lists.get(key);
    list.push(...values);
    return list.length;
  }

  async lpop(key) {
    const list = memoryStore.lists.get(key);
    return list && list.length > 0 ? list.shift() : null;
  }

  async rpop(key) {
    const list = memoryStore.lists.get(key);
    return list && list.length > 0 ? list.pop() : null;
  }

  async lrange(key, start, stop) {
    const list = memoryStore.lists.get(key);
    if (!list) return [];
    const end = stop === -1 ? list.length : stop + 1;
    return list.slice(start, end);
  }

  async llen(key) {
    const list = memoryStore.lists.get(key);
    return list ? list.length : 0;
  }

  async ltrim(key, start, stop) {
    const list = memoryStore.lists.get(key);
    if (!list) return 'OK';
    const end = stop === -1 ? list.length : stop + 1;
    const trimmed = list.slice(start, end);
    memoryStore.lists.set(key, trimmed);
    return 'OK';
  }

  async keys(pattern) {
    const allKeys = [
      ...memoryStore.strings.keys(),
      ...memoryStore.hashes.keys(),
      ...memoryStore.sets.keys(),
      ...memoryStore.lists.keys()
    ];
    if (pattern === '*') return allKeys;
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return allKeys.filter(k => regex.test(k));
  }

  async exists(key) {
    return memoryStore.strings.has(key) || 
           memoryStore.hashes.has(key) || 
           memoryStore.sets.has(key) || 
           memoryStore.lists.has(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    // Memory store doesn't support expiry, but return OK
    return 1;
  }

  async incr(key) {
    const val = parseInt(memoryStore.strings.get(key) || '0', 10);
    memoryStore.strings.set(key, String(val + 1));
    return val + 1;
  }

  async scard(key) {
    const set = memoryStore.sets.get(key);
    return set ? set.size : 0;
  }

  async quit() {
    return 'OK';
  }

  on(event, callback) {
    // No-op for memory client
    return this;
  }

  // Simple eval implementation for allocate/release session operations
  async eval(script, numKeys, ...args) {
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);
    
    // Detect which operation based on keys pattern
    if (script.includes('ALLOCATE') || script.includes('phoneCount')) {
      // Allocate session
      const phone = keys[0];
      const sessionId = keys[1];
      const maxPerProxy = parseInt(argv[0], 10);
      const maxPerPhone = parseInt(argv[1], 10);
      const timestamp = argv[2];
      const proxies = JSON.parse(argv[3] || '[]');
      
      // Check phone limit
      const phoneCountStr = memoryStore.strings.get(`counter:phone:${phone}`) || '0';
      const phoneCount = parseInt(phoneCountStr, 10);
      if (phoneCount >= maxPerPhone) {
        return JSON.stringify({ success: false, reason: 'PHONE_LIMIT_REACHED', phoneCount });
      }
      
      // Find available proxy
      let selectedProxy = proxies[0] || 'no-proxy';
      for (const proxy of proxies) {
        const proxyCountStr = memoryStore.strings.get(`counter:proxy:${proxy}`) || '0';
        const proxyCount = parseInt(proxyCountStr, 10);
        if (proxyCount < maxPerProxy) {
          selectedProxy = proxy;
          break;
        }
      }
      
      // Increment counters
      const newPhoneCount = phoneCount + 1;
      memoryStore.strings.set(`counter:phone:${phone}`, String(newPhoneCount));
      
      const proxyCountStr = memoryStore.strings.get(`counter:proxy:${selectedProxy}`) || '0';
      const newProxyCount = parseInt(proxyCountStr, 10) + 1;
      memoryStore.strings.set(`counter:proxy:${selectedProxy}`, String(newProxyCount));
      
      // Create session record
      if (!memoryStore.hashes.has(`session:${sessionId}`)) {
        memoryStore.hashes.set(`session:${sessionId}`, new Map());
      }
      const sessionHash = memoryStore.hashes.get(`session:${sessionId}`);
      sessionHash.set('sessionId', sessionId);
      sessionHash.set('phone', phone);
      sessionHash.set('proxyId', selectedProxy);
      sessionHash.set('status', 'PENDING');
      sessionHash.set('createdAt', timestamp);
      sessionHash.set('lastUpdated', timestamp);
      
      // Add to sessions set
      if (!memoryStore.sets.has('sessions:all')) {
        memoryStore.sets.set('sessions:all', new Set());
      }
      memoryStore.sets.get('sessions:all').add(sessionId);
      
      return JSON.stringify({ 
        success: true, 
        sessionId, 
        proxyId: selectedProxy,
        phoneCount: newPhoneCount,
        proxyCount: newProxyCount 
      });
    } 
    else if (script.includes('RELEASE') || script.includes('releaseSession')) {
      // Release session
      const sessionId = keys[0];
      const timestamp = argv[0];
      
      const sessionHash = memoryStore.hashes.get(`session:${sessionId}`);
      if (!sessionHash) {
        return JSON.stringify({ success: false, reason: 'SESSION_NOT_FOUND' });
      }
      
      const phone = sessionHash.get('phone');
      const proxyId = sessionHash.get('proxyId');
      
      // Decrement counters
      if (phone) {
        const phoneCountStr = memoryStore.strings.get(`counter:phone:${phone}`) || '1';
        const newCount = Math.max(0, parseInt(phoneCountStr, 10) - 1);
        memoryStore.strings.set(`counter:phone:${phone}`, String(newCount));
      }
      
      if (proxyId) {
        const proxyCountStr = memoryStore.strings.get(`counter:proxy:${proxyId}`) || '1';
        const newCount = Math.max(0, parseInt(proxyCountStr, 10) - 1);
        memoryStore.strings.set(`counter:proxy:${proxyId}`, String(newCount));
      }
      
      // Update session status
      sessionHash.set('status', 'STOPPED');
      sessionHash.set('releasedAt', timestamp);
      
      // Remove from active sessions
      const sessionsSet = memoryStore.sets.get('sessions:all');
      if (sessionsSet) sessionsSet.delete(sessionId);
      
      return JSON.stringify({ success: true, sessionId, phone, proxyId });
    }
    
    // Unknown script - return empty result
    console.warn('[MemoryRedis] Unknown eval script, returning empty result');
    return JSON.stringify({ success: true });
  }
}

function getRedis() {
  if (redisClient) return redisClient;
  
  // If no Redis URL or empty, use memory
  if (!config.redisUrl || config.redisUrl === '' || config.redisUrl === 'memory') {
    console.log('[Redis] Using in-memory storage (no Redis URL configured)');
    useMemory = true;
    redisClient = new MemoryRedis();
    return redisClient;
  }
  
  try {
    redisClient = new Redis(config.redisUrl, {
      // Prefer IPv4 on Windows to avoid odd IPv6/WSL/Docker resolution issues.
      family: 4,
      enableReadyCheck: true,
      // Keep the default offline queue ON to avoid "Stream isn't writeable" race on startup.
      // We still fail fast on bad connections via maxRetriesPerRequest/connectTimeout.
      enableOfflineQueue: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      lazyConnect: true
    });
    
    // Handle connection errors gracefully
    redisClient.on('error', (err) => {
      if (!useMemory) {
        console.log('[Redis] Connection error, falling back to memory storage:', err.message);
        useMemory = true;
        redisClient = new MemoryRedis();
      }
    });
    
    return redisClient;
  } catch (err) {
    console.log('[Redis] Failed to create client, using memory storage:', err.message);
    useMemory = true;
    redisClient = new MemoryRedis();
    return redisClient;
  }
}

// Dedicated connection for blocking commands (BRPOP/BLPOP/BRPOPLPUSH),
// so long-polls do NOT block the main Redis connection used by HTTP handlers.
function getRedisBlocking() {
  if (redisBlockingClient) return redisBlockingClient;
  
  if (useMemory || !config.redisUrl || config.redisUrl === '' || config.redisUrl === 'memory') {
    redisBlockingClient = new MemoryRedis();
    return redisBlockingClient;
  }
  
  redisBlockingClient = new Redis(config.redisUrl, {
    family: 4,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1
  });
  return redisBlockingClient;
}

async function closeRedis() {
  if (!redisClient) return;
  await redisClient.quit();
  redisClient = null;

  if (redisBlockingClient) {
    await redisBlockingClient.quit();
    redisBlockingClient = null;
  }
}

function isUsingMemory() {
  return useMemory;
}

module.exports = { getRedis, getRedisBlocking, closeRedis, isUsingMemory };

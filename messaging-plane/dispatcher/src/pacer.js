/**
 * Session Pacer
 * 
 * Anti-ban pacing for message sending:
 * - Random delays between messages
 * - Burst detection and cooldown
 * - Per-session rate tracking
 * - Adaptive rate based on session health
 * - Optional RPM-based pacing (interval derived from RPM)
 */

/**
 * Generate random delay between min and max
 */
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Add jitter to a delay (±20%)
 */
function addJitter(delay) {
  const jitter = delay * 0.2;
  return delay + randomDelay(-jitter, jitter);
}

class SessionPacer {
  constructor(options = {}) {
    this.sessionId = options.sessionId;
    
    // Configurable delays (delay-mode)
    this.minDelayMs = options.minDelayMs || 2000;  // 2 seconds minimum
    this.maxDelayMs = options.maxDelayMs || 5000;  // 5 seconds maximum

    // Optional RPM mode (preferred for "messages per minute" controls)
    // If rpm is set, we derive min/max interval from it and keep jitter.
    this.rpm = options.rpm; // undefined means "delay-mode"
    
    // Burst detection
    this.burstLimit = options.burstLimit || 5;     // Messages before burst mode
    this.burstCooldownMs = options.burstCooldownMs || 30000; // 30 seconds cooldown
    
    // State
    this.lastSendTime = 0;
    this.sendCount = 0;
    this.burstStartTime = 0;
    this.inBurstCooldown = false;
    
    // Stats
    this.totalSent = 0;
    this.totalDelayMs = 0;
    this.burstCount = 0;
    
    // Adaptive rate (can be adjusted based on session health)
    this.rateMultiplier = 1.0;
  }
  
  /**
   * Update pacer configuration
   */
  updateConfig(config) {
    if (config.minDelayMs !== undefined) this.minDelayMs = config.minDelayMs;
    if (config.maxDelayMs !== undefined) this.maxDelayMs = config.maxDelayMs;
    if (config.rpm !== undefined) this.setRpm(config.rpm);
    if (config.burstLimit !== undefined) this.burstLimit = config.burstLimit;
    if (config.burstCooldownMs !== undefined) this.burstCooldownMs = config.burstCooldownMs;
    if (config.rateMultiplier !== undefined) this.rateMultiplier = config.rateMultiplier;
  }

  /**
   * Set target RPM (messages per minute). Uses interval = 60000 / rpm and applies jitter.
   * rpm must be a positive number.
   */
  setRpm(rpm) {
    if (rpm === null || rpm === undefined) {
      this.rpm = undefined;
      return;
    }
    const r = Number(rpm);
    if (!Number.isFinite(r) || r <= 0) {
      throw new Error("Invalid rpm");
    }
    this.rpm = r;

    // Derive a delay window around the ideal interval with some natural variance.
    const baseInterval = 60000 / r;
    this.minDelayMs = Math.max(0, Math.floor(baseInterval * 0.8));
    this.maxDelayMs = Math.max(this.minDelayMs, Math.floor(baseInterval * 1.2));
  }
  
  /**
   * Get current configuration
   */
  getConfig() {
    return {
      minDelayMs: this.minDelayMs,
      maxDelayMs: this.maxDelayMs,
      rpm: this.rpm,
      burstLimit: this.burstLimit,
      burstCooldownMs: this.burstCooldownMs,
      rateMultiplier: this.rateMultiplier,
    };
  }
  
  /**
   * Calculate the required delay before sending
   */
  calculateDelay() {
    const now = Date.now();
    
    // Check burst cooldown
    if (this.inBurstCooldown) {
      const cooldownRemaining = this.burstCooldownMs - (now - this.burstStartTime);
      if (cooldownRemaining > 0) {
        return cooldownRemaining + randomDelay(1000, 3000); // Extra random delay after burst
      }
      // Cooldown complete
      this.inBurstCooldown = false;
      this.sendCount = 0;
    }
    
    // Check if we're approaching burst
    if (this.sendCount >= this.burstLimit) {
      this.inBurstCooldown = true;
      this.burstStartTime = now;
      this.burstCount++;
      console.log(`[Pacer:${this.sessionId}] Burst detected, entering cooldown`);
      return this.burstCooldownMs + randomDelay(1000, 3000);
    }
    
    // Calculate time since last send
    const timeSinceLastSend = now - this.lastSendTime;
    
    // Base delay with jitter
    const baseDelay = randomDelay(this.minDelayMs, this.maxDelayMs);
    const adjustedDelay = Math.floor(baseDelay * this.rateMultiplier);
    const finalDelay = addJitter(adjustedDelay);
    
    // If enough time has passed, no additional delay needed
    if (timeSinceLastSend >= finalDelay) {
      return 0;
    }
    
    // Return remaining delay
    return finalDelay - timeSinceLastSend;
  }
  
  /**
   * Wait for the next available slot
   */
  async waitForSlot() {
    const delay = this.calculateDelay();
    
    if (delay > 0) {
      this.totalDelayMs += delay;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    
    return delay;
  }
  
  /**
   * Record that a message was sent
   */
  recordSend() {
    this.lastSendTime = Date.now();
    this.sendCount++;
    this.totalSent++;
  }
  
  /**
   * Slow down the pacer (e.g., when detecting issues)
   */
  slowDown(factor = 1.5) {
    this.rateMultiplier = Math.min(this.rateMultiplier * factor, 5.0);
    console.log(`[Pacer:${this.sessionId}] Slowing down, multiplier: ${this.rateMultiplier}`);
  }
  
  /**
   * Speed up the pacer (e.g., when session is healthy)
   */
  speedUp(factor = 0.9) {
    this.rateMultiplier = Math.max(this.rateMultiplier * factor, 0.5);
    console.log(`[Pacer:${this.sessionId}] Speeding up, multiplier: ${this.rateMultiplier}`);
  }
  
  /**
   * Reset to default rate
   */
  resetRate() {
    this.rateMultiplier = 1.0;
  }
  
  /**
   * Get pacer statistics
   */
  getStats() {
    return {
      totalSent: this.totalSent,
      totalDelayMs: this.totalDelayMs,
      avgDelayMs: this.totalSent > 0 ? Math.floor(this.totalDelayMs / this.totalSent) : 0,
      burstCount: this.burstCount,
      inBurstCooldown: this.inBurstCooldown,
      rateMultiplier: this.rateMultiplier,
      lastSendTime: this.lastSendTime,
      currentBurstCount: this.sendCount,
    };
  }
}

/**
 * Global rate limiter for all sessions combined
 */
class GlobalRateLimiter {
  constructor(options = {}) {
    this.maxPerMinute = options.maxPerMinute || 60;
    this.maxPerHour = options.maxPerHour || 1000;
    
    this.minuteCount = 0;
    this.hourCount = 0;
    this.minuteStart = Date.now();
    this.hourStart = Date.now();
  }
  
  /**
   * Check if sending is allowed
   */
  canSend() {
    const now = Date.now();
    
    // Reset minute counter
    if (now - this.minuteStart >= 60000) {
      this.minuteCount = 0;
      this.minuteStart = now;
    }
    
    // Reset hour counter
    if (now - this.hourStart >= 3600000) {
      this.hourCount = 0;
      this.hourStart = now;
    }
    
    return this.minuteCount < this.maxPerMinute && this.hourCount < this.maxPerHour;
  }
  
  /**
   * Record a send
   */
  recordSend() {
    this.minuteCount++;
    this.hourCount++;
  }
  
  /**
   * Get remaining capacity
   */
  getCapacity() {
    return {
      minuteRemaining: this.maxPerMinute - this.minuteCount,
      hourRemaining: this.maxPerHour - this.hourCount,
    };
  }
}

module.exports = {
  SessionPacer,
  GlobalRateLimiter,
  randomDelay,
  addJitter
};


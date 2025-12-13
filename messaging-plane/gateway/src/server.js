/**
 * WhatsApp Messaging Gateway (GATEWAY_SPEC.md compliant)
 * 
 * Single endpoint: POST /v1/jobs
 * - JSON mode: message + contacts
 * - Multipart mode: image + contacts JSON string
 * - Idempotency support
 * - Redis queue integration
 * - Strict validation
 */

require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs").promises;
const path = require("path");
const { jsonModeSchema, validateMultipartMode } = require("./validators");

const app = express();

// ===========================================
// CONFIGURATION
// ===========================================

const config = {
  port: Number(process.env.PORT || 4000),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  apiKey: process.env.API_KEY || "change-me",
  
  // Queue settings
  queueKey: process.env.QUEUE_KEY || "gateway:jobs",
  
  // Idempotency TTL (24 hours)
  idempotencyTtl: Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400),
  
  // Rate limiting
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 100),
  
  // Media storage
  mediaDir: process.env.MEDIA_DIR || "./tmp/media",
};

// Create media directory
(async () => {
  try {
    await fs.mkdir(config.mediaDir, { recursive: true });
  } catch (err) {
    console.error("[Gateway] Failed to create media directory:", err.message);
  }
})();

// ===========================================
// REDIS CONNECTION
// ===========================================

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: true,
  lazyConnect: true, // Don't auto-connect (we'll handle manually)
});

let redisReady = false;

redis.on("connect", () => {
  console.log("[Gateway] Redis connecting...");
});

redis.on("ready", () => {
  console.log("[Gateway] Redis connected and ready");
  redisReady = true;
});

redis.on("error", (err) => {
  console.error("[Gateway] Redis error:", err.message);
  redisReady = false;
});

redis.on("close", () => {
  console.log("[Gateway] Redis connection closed");
  redisReady = false;
});

// Connect to Redis
redis.connect().catch(err => {
  console.error("[Gateway] Failed to connect to Redis:", err.message);
});

// ===========================================
// MULTER SETUP (for image uploads)
// ===========================================

const upload = multer({
  storage: multer.memoryStorage(), // Keep in memory for validation
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    files: 1
  }
});

// ===========================================
// MIDDLEWARE
// ===========================================

app.use(helmet());
app.use(cors({ origin: "*" }));

// Body parsing (required for JSON mode)
app.use(express.json({ limit: "1mb" }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  handler: (req, res) => {
    res.status(429).json({
      status: "error",
      reason: "Rate limit exceeded",
      code: "RATE_LIMIT"
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ===========================================
// AUTHENTICATION MIDDLEWARE
// ===========================================

function authenticateApiKey(req, res, next) {
  const apiKey = req.header("X-API-KEY");
  
  if (!apiKey) {
    return res.status(401).json({
      status: "error",
      reason: "Missing API key",
      code: "AUTH_MISSING"
    });
  }
  
  if (apiKey !== config.apiKey) {
    return res.status(401).json({
      status: "error",
      reason: "Invalid API key",
      code: "AUTH_INVALID"
    });
  }
  
  next();
}

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Generate unique job ID
 */
function generateJobId() {
  return uuidv4();
}

/**
 * Check idempotency and return existing jobId if key was used
 */
async function checkIdempotency(idempotencyKey) {
  if (!idempotencyKey) return null;
  
  try {
    const existingJobId = await redis.get(`idempotency:${idempotencyKey}`);
    return existingJobId;
  } catch (err) {
    throw err; // Will be caught and return 503
  }
}

/**
 * Store idempotency mapping
 */
async function storeIdempotency(idempotencyKey, jobId) {
  if (!idempotencyKey) return;
  
  try {
    await redis.set(
      `idempotency:${idempotencyKey}`,
      jobId,
      "EX",
      config.idempotencyTtl
    );
  } catch (err) {
    throw err;
  }
}

/**
 * Enqueue job to Redis
 */
async function enqueueJob(jobId, payload) {
  try {
    // Store job data
    await redis.set(
      `job:${jobId}`,
      JSON.stringify({
        jobId,
        ...payload,
        createdAt: Date.now(),
        status: "QUEUED"
      }),
      "EX",
      config.idempotencyTtl
    );
    
    // Add to queue
    await redis.lpush(config.queueKey, jobId);

    // Emit job lifecycle event (for Telegram / monitoring)
    await redis.lpush(
      "jobs:events",
      JSON.stringify({
        ts: Date.now(),
        type: "JOB_ACCEPTED",
        jobId,
        received: Array.isArray(payload?.contacts) ? payload.contacts.length : null,
        hasImage: !!payload?.hasImage,
        mode: payload?.mode || null
      })
    );
    await redis.ltrim("jobs:events", 0, 1999);
    
    return true;
  } catch (err) {
    throw err;
  }
}

/**
 * Save image file temporarily
 */
async function saveImageFile(file, jobId) {
  try {
    const ext = path.extname(file.originalname) || ".jpg";
    const filename = `${jobId}${ext}`;
    const filepath = path.join(config.mediaDir, filename);
    
    await fs.writeFile(filepath, file.buffer);
    
    return {
      mediaRef: filename,
      path: filepath
    };
  } catch (err) {
    console.error("[Gateway] Failed to save image:", err.message);
    throw new Error("MEDIA_UNAVAILABLE");
  }
}

// ===========================================
// MAIN ENDPOINT: POST /v1/jobs
// ===========================================

app.post("/v1/jobs", limiter, authenticateApiKey, upload.single("image"), async (req, res) => {
  try {
    // Check Redis availability
    if (!redisReady) {
      return res.status(503).json({
        status: "error",
        reason: "Queue unavailable",
        code: "QUEUE_UNAVAILABLE"
      });
    }
    
    const contentType = req.get("content-type") || "";
    let validationResult;
    let mode;
    let jobPayload;
    
    // ===========================================
    // MODE DETECTION
    // ===========================================
    
    if (contentType.includes("application/json")) {
      // JSON MODE (message)
      mode = "message";
      
      console.log("[Gateway] JSON mode - body:", JSON.stringify(req.body));
      console.log("[Gateway] jsonModeSchema type:", typeof jsonModeSchema);
      
      const { error, value } = jsonModeSchema.validate(req.body, { abortEarly: false });
      
      console.log("[Gateway] Validation result - error:", error);
      console.log("[Gateway] Validation result - value:", value);
      
      if (error) {
        return res.status(400).json({
          status: "error",
          reason: error.details[0].message,
          code: "PAYLOAD_INVALID"
        });
      }
      
      jobPayload = {
        mode: "message",
        message: value.message,
        contacts: value.contacts,
        hasImage: false
      };
      
      validationResult = { idempotencyKey: value.idempotencyKey };
      
    } else if (contentType.includes("multipart/form-data")) {
      // MULTIPART MODE (image)
      mode = "image";
      
      const result = validateMultipartMode(req.body, req.file);
      
      if (!result.valid) {
        const statusCode = result.statusCode || 400;
        return res.status(statusCode).json({
          status: "error",
          reason: result.reason,
          code: result.code
        });
      }
      
      validationResult = { idempotencyKey: result.data.idempotencyKey };
      
      jobPayload = {
        mode: "image",
        contacts: result.data.contacts,
        hasImage: true,
        image: result.data.image // Will be saved after jobId generated
      };
      
    } else {
      return res.status(400).json({
        status: "error",
        reason: "Content-Type must be application/json or multipart/form-data",
        code: "CONTENT_TYPE_INVALID"
      });
    }
    
    // ===========================================
    // IDEMPOTENCY CHECK
    // ===========================================
    
    const idempotencyKey = validationResult.idempotencyKey;
    
    if (idempotencyKey) {
      try {
        const existingJobId = await checkIdempotency(idempotencyKey);
        
        if (existingJobId) {
          // Return existing job (idempotent response)
          const existingJob = await redis.get(`job:${existingJobId}`);
          
          if (existingJob) {
            const job = JSON.parse(existingJob);
            return res.status(200).json({
              status: "ok",
              jobId: existingJobId,
              received: job.contacts.length,
              hasImage: job.hasImage
            });
          }
          // If job data expired but idempotency key still exists, continue creating new job
        }
      } catch (err) {
        console.error("[Gateway] Idempotency check failed:", err.message);
        return res.status(503).json({
          status: "error",
          reason: "Queue unavailable",
          code: "QUEUE_UNAVAILABLE"
        });
      }
    }
    
    // ===========================================
    // CREATE NEW JOB
    // ===========================================
    
    const jobId = generateJobId();
    
    // Save image if in image mode
    if (mode === "image") {
      try {
        const { mediaRef, path: filepath } = await saveImageFile(jobPayload.image, jobId);
        jobPayload.mediaRef = mediaRef;
        jobPayload.mediaPath = filepath;
        delete jobPayload.image; // Remove buffer from payload
      } catch (err) {
        if (err.message === "MEDIA_UNAVAILABLE") {
          return res.status(503).json({
            status: "error",
            reason: "Media storage unavailable",
            code: "MEDIA_UNAVAILABLE"
          });
        }
        throw err;
      }
    }
    
    // Enqueue job
    try {
      await enqueueJob(jobId, jobPayload);
      
      // Store idempotency mapping
      if (idempotencyKey) {
        await storeIdempotency(idempotencyKey, jobId);
      }
      
      // Success response
      return res.status(200).json({
        status: "ok",
        jobId,
        received: jobPayload.contacts.length,
        hasImage: jobPayload.hasImage
      });
      
    } catch (err) {
      console.error("[Gateway] Enqueue failed:", err.message);
      return res.status(503).json({
        status: "error",
        reason: "Queue unavailable",
        code: "QUEUE_UNAVAILABLE"
      });
    }
    
  } catch (err) {
    console.error("[Gateway] Unhandled error:", err);
    return res.status(500).json({
      status: "error",
      reason: "Internal server error",
      code: "INTERNAL_ERROR"
    });
  }
});

// ===========================================
// HEALTH & UTILITY ENDPOINTS
// ===========================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "gateway",
    redis: redisReady ? "connected" : "disconnected",
    timestamp: Date.now()
  });
});

app.get("/health/queue", authenticateApiKey, async (req, res) => {
  try {
    if (!redisReady) {
      return res.status(503).json({
        status: "error",
        reason: "Redis unavailable"
      });
    }
    
    const queueLength = await redis.llen(config.queueKey);
    
    res.json({
      status: "ok",
      queue: {
        key: config.queueKey,
        length: queueLength
      },
      timestamp: Date.now()
    });
  } catch (err) {
    console.error("[Gateway] Queue status error:", err.message);
    res.status(503).json({
      status: "error",
      reason: "Queue unavailable"
    });
  }
});

// ===========================================
// ERROR HANDLING
// ===========================================

app.use((err, req, res, next) => {
  console.error("[Gateway] Unhandled error:", err);
  res.status(500).json({
    status: "error",
    reason: "Internal server error",
    code: "INTERNAL_ERROR"
  });
});

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    reason: "Not found",
    code: "NOT_FOUND"
  });
});

// ===========================================
// START SERVER
// ===========================================

function start() {
  const server = app.listen(config.port, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           WhatsApp Messaging Gateway                      ║
║           (GATEWAY_SPEC.md compliant)                     ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoint: POST /v1/jobs                                  ║
║  Port: ${config.port.toString().padEnd(51)}║
║  Redis: ${config.redisUrl.slice(0, 47).padEnd(49)}║
║  Queue: ${config.queueKey.padEnd(49)}║
║  Rate Limit: ${config.rateLimitMax} req/${(config.rateLimitWindowMs / 1000)}s${" ".repeat(37)}║
╚═══════════════════════════════════════════════════════════╝
    `);
  });

  server.on("error", (err) => {
    console.error("[Gateway] Server error:", err.message);
    process.exit(1);
  });

  return server;
}

if (require.main === module) {
  start();
}

module.exports = { app, start };

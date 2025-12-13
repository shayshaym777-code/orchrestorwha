/**
 * Backup & Alert Routes
 * API endpoints for backup management and Telegram alerts
 */

const express = require("express");
const router = express.Router();

const { 
  createBackup, 
  listBackups, 
  restoreBackup, 
  getBackupStatus,
  deleteBackup
} = require("../services/backupService");

const { 
  testTelegramConnection, 
  getTelegramStatus,
  sendTelegramAlert,
  alertDailySummary
} = require("../services/telegramAlertService");

// =====================================================
// BACKUP ENDPOINTS
// =====================================================

/**
 * GET /api/v1/backups
 * List all available backups
 */
router.get("/", async (req, res, next) => {
  try {
    const backups = await listBackups();
    res.json({
      status: "ok",
      count: backups.length,
      backups
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/backups/status
 * Get backup configuration and status
 */
router.get("/status", async (req, res, next) => {
  try {
    const status = await getBackupStatus();
    res.json({
      status: "ok",
      ...status
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/backups/create
 * Create a new backup
 */
router.post("/create", async (req, res, next) => {
  try {
    console.log("[Backup API] Creating backup...");
    const result = await createBackup();
    
    if (result.success) {
      res.json({
        status: "ok",
        message: "Backup created successfully",
        ...result
      });
    } else {
      res.status(400).json({
        status: "error",
        message: "Backup failed",
        ...result
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/backups/restore
 * Restore from a backup
 * Body: { backupName: string, sessionId?: string }
 */
router.post("/restore", async (req, res, next) => {
  try {
    const { backupName, sessionId } = req.body;
    
    if (!backupName) {
      return res.status(400).json({
        status: "error",
        message: "backupName is required"
      });
    }
    
    console.log(`[Backup API] Restoring from ${backupName}${sessionId ? ` (session: ${sessionId})` : ""}...`);
    const result = await restoreBackup(backupName, sessionId);
    
    if (result.success) {
      res.json({
        status: "ok",
        message: "Restore completed",
        ...result
      });
    } else {
      res.status(400).json({
        status: "error",
        message: "Restore failed",
        ...result
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/v1/backups/:name
 * Delete a specific backup
 */
router.delete("/:name", async (req, res, next) => {
  try {
    const { name } = req.params;
    const result = await deleteBackup(name);
    
    if (result.success) {
      res.json({
        status: "ok",
        message: "Backup deleted",
        ...result
      });
    } else {
      res.status(400).json({
        status: "error",
        ...result
      });
    }
  } catch (error) {
    next(error);
  }
});

// =====================================================
// TELEGRAM ALERT ENDPOINTS
// =====================================================

/**
 * GET /api/v1/alerts/telegram/status
 * Get Telegram configuration status
 */
router.get("/telegram/status", (req, res) => {
  const status = getTelegramStatus();
  res.json({
    status: "ok",
    telegram: status
  });
});

/**
 * POST /api/v1/alerts/telegram/test
 * Test Telegram connection
 */
router.post("/telegram/test", async (req, res, next) => {
  try {
    console.log("[Alert API] Testing Telegram connection...");
    const result = await testTelegramConnection();
    
    res.json({
      status: result.sent ? "ok" : "error",
      message: result.sent ? "Test message sent to Telegram" : "Failed to send test message",
      ...result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/alerts/telegram/send
 * Send a custom alert to Telegram
 * Body: { type: string, title: string, message: string, details?: object }
 */
router.post("/telegram/send", async (req, res, next) => {
  try {
    const { type, title, message, details } = req.body;
    
    if (!title || !message) {
      return res.status(400).json({
        status: "error",
        message: "title and message are required"
      });
    }
    
    const result = await sendTelegramAlert(type || "info", title, message, details || {});
    
    res.json({
      status: result.sent ? "ok" : "error",
      ...result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/alerts/daily-summary
 * Trigger daily summary alert
 */
router.post("/daily-summary", async (req, res, next) => {
  try {
    // Get stats from request or calculate
    const stats = req.body.stats || {
      activeSessions: 0,
      messagesSent: 0,
      messagesFailed: 0,
      proxiesAvailable: 0,
      proxiesBad: 0
    };
    
    const result = await alertDailySummary(stats);
    
    res.json({
      status: result.sent ? "ok" : "error",
      ...result
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;


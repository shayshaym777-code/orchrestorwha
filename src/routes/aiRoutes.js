/**
 * AI Routes - Gemini Integration
 * 
 * API endpoints for AI-powered learning and analysis
 */

const express = require("express");
const router = express.Router();

const {
  askGemini,
  analyzeBanReason,
  analyzeActivityPatterns,
  askAboutWhatsApp,
  analyzeMessageRisk,
  learnFromBan,
  getRecentInsights,
  getBanHistory,
  getDailyImprovement,
  healthCheck
} = require("../services/geminiAIService");

/**
 * GET /api/v1/ai/health
 * בדיקת חיבור AI
 */
router.get("/health", async (req, res, next) => {
  try {
    const status = await healthCheck();
    res.json({
      status: status.status === "OK" ? "ok" : "error",
      ai: status
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/ai/ask
 * שאלה חופשית ל-AI
 */
router.post("/ask", async (req, res, next) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({
        status: "error",
        message: "question is required"
      });
    }
    
    console.log(`[AI] Question: ${question.slice(0, 50)}...`);
    const result = await askAboutWhatsApp(question);
    
    res.json({
      status: result.success ? "ok" : "error",
      question,
      answer: result.response || null,
      error: result.error || null
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/ai/analyze/ban
 * ניתוח סיבת חסימה
 */
router.post("/analyze/ban", async (req, res, next) => {
  try {
    const { sessionData, events } = req.body;
    
    if (!sessionData) {
      return res.status(400).json({
        status: "error",
        message: "sessionData is required"
      });
    }
    
    console.log(`[AI] Analyzing ban for session: ${sessionData.sessionId || 'unknown'}`);
    const result = await analyzeBanReason(sessionData, events || []);
    
    res.json({
      status: result.success ? "ok" : "error",
      analysis: result.response || null,
      error: result.error || null
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/ai/analyze/activity
 * ניתוח דפוסי פעילות
 */
router.post("/analyze/activity", async (req, res, next) => {
  try {
    const { stats } = req.body;
    
    if (!stats) {
      return res.status(400).json({
        status: "error",
        message: "stats is required"
      });
    }
    
    console.log("[AI] Analyzing activity patterns");
    const result = await analyzeActivityPatterns(stats);
    
    res.json({
      status: result.success ? "ok" : "error",
      analysis: result.response || null,
      parsed: result.parsed || null,
      error: result.error || null
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/ai/analyze/message
 * בדיקת סיכון הודעה לפני שליחה
 */
router.post("/analyze/message", async (req, res, next) => {
  try {
    const { message, sessionAge, messagesToday } = req.body;
    
    if (!message) {
      return res.status(400).json({
        status: "error",
        message: "message is required"
      });
    }
    
    const result = await analyzeMessageRisk(
      message,
      sessionAge || 0,
      messagesToday || 0
    );
    
    res.json({
      status: result.success ? "ok" : "error",
      analysis: result.response || null,
      risk: result.parsed || null,
      error: result.error || null
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/ai/learn/ban
 * למידה מאירוע חסימה
 */
router.post("/learn/ban", async (req, res, next) => {
  try {
    const { sessionId, banData } = req.body;
    
    if (!sessionId || !banData) {
      return res.status(400).json({
        status: "error",
        message: "sessionId and banData are required"
      });
    }
    
    console.log(`[AI] Learning from ban: ${sessionId}`);
    const result = await learnFromBan(sessionId, banData);
    
    res.json({
      status: result.success ? "ok" : "error",
      learned: result.success,
      analysis: result.response || null
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/ai/insights
 * תובנות אחרונות
 */
router.get("/insights", async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const insights = await getRecentInsights(limit);
    
    res.json({
      status: "ok",
      count: insights.length,
      insights
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/ai/ban-history
 * היסטוריית חסימות
 */
router.get("/ban-history", async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const history = await getBanHistory(limit);
    
    res.json({
      status: "ok",
      count: history.length,
      history
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/ai/daily-improvement
 * המלצות יומיות
 */
router.get("/daily-improvement", async (req, res, next) => {
  try {
    console.log("[AI] Getting daily improvement recommendations");
    const result = await getDailyImprovement();
    
    res.json({
      status: result.success ? "ok" : "error",
      recommendations: result.response || null,
      error: result.error || null
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;


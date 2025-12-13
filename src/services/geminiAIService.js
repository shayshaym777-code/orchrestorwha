/**
 * Gemini AI Service
 * 
 * מודול AI ללמידה והבנת דפוסי חסימות WhatsApp
 * - ניתוח אירועים וזיהוי דפוסים
 * - הבנת סיבות לחסימות
 * - המלצות לשיפור
 */

const axios = require("axios");
const { getRedis } = require("../infra/redis");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent";

// Cache for AI responses (avoid duplicate calls)
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * שליחת שאלה ל-Gemini
 */
async function askGemini(prompt, context = {}) {
  if (!GEMINI_API_KEY) {
    console.log("[Gemini] API key not configured");
    return { success: false, error: "GEMINI_API_KEY not configured" };
  }

  // Check cache
  const cacheKey = prompt.slice(0, 100);
  const cached = responseCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.response;
  }

  try {
    const response = await axios.post(
      `${GEMINI_URL}?key=${GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1024
        }
      },
      { timeout: 30000 }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    const result = {
      success: true,
      response: text,
      timestamp: Date.now()
    };

    // Cache response
    responseCache.set(cacheKey, { response: result, timestamp: Date.now() });

    return result;
  } catch (error) {
    console.error("[Gemini] Error:", error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message
    };
  }
}

/**
 * ניתוח סיבת חסימה
 */
async function analyzeBanReason(sessionData, events) {
  const prompt = `
אתה מומחה לאנטי-ספאם של WhatsApp. נתח את המקרה הבא והסבר למה הסשן נחסם:

פרטי הסשן:
- גיל הסשן: ${sessionData.ageInDays || 0} ימים
- הודעות שנשלחו: ${sessionData.totalSent || 0}
- הודעות היום: ${sessionData.sentToday || 0}
- Trust Level: ${sessionData.trustLevel || 'COLD'}
- פרוקסי: ${sessionData.proxy ? 'מוגדר' : 'ישיר'}

אירועים אחרונים:
${events.slice(-10).map(e => `- ${e.type}: ${e.details || ''}`).join('\n')}

ענה בעברית בפורמט:
1. סיבה עיקרית משוערת (משפט אחד)
2. גורמי סיכון שזוהו (רשימה)
3. המלצות למניעה בעתיד (3 נקודות)
`;

  return await askGemini(prompt);
}

/**
 * ניתוח דפוסי פעילות
 */
async function analyzeActivityPatterns(stats) {
  const prompt = `
אתה מומחה לאנטי-ספאם. נתח את הסטטיסטיקות ותן המלצות:

סטטיסטיקות:
- סשנים פעילים: ${stats.activeSessions || 0}
- הודעות נשלחו היום: ${stats.messagesSent || 0}
- הודעות נכשלו: ${stats.messagesFailed || 0}
- אחוז הצלחה: ${stats.successRate || 0}%
- פרוקסים בשימוש: ${stats.proxiesInUse || 0}
- ממוצע הודעות לסשן: ${stats.avgMessagesPerSession || 0}

ענה בעברית בפורמט JSON:
{
  "riskLevel": "LOW/MEDIUM/HIGH",
  "insights": ["תובנה 1", "תובנה 2"],
  "recommendations": ["המלצה 1", "המלצה 2"],
  "optimalSettings": {
    "messagesPerHour": number,
    "delayBetweenMessages": number,
    "jitterPercent": number
  }
}
`;

  const result = await askGemini(prompt);
  
  if (result.success) {
    try {
      // Try to parse JSON from response
      const jsonMatch = result.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result.parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      // Keep raw response if JSON parsing fails
    }
  }
  
  return result;
}

/**
 * שאלה חופשית על התנהגות WhatsApp
 */
async function askAboutWhatsApp(question) {
  const prompt = `
אתה מומחה לאנטי-ספאם ואוטומציה של WhatsApp Business.

שאלה: ${question}

ענה בעברית. אם השאלה קשורה להימנעות מחסימות - תן טיפים מעשיים.
אם השאלה טכנית - הסבר בפשטות.
`;

  return await askGemini(prompt);
}

/**
 * ניתוח הודעה לפני שליחה (בדיקת סיכון)
 */
async function analyzeMessageRisk(message, sessionAge, messagesToday) {
  const prompt = `
בדוק את ההודעה הבאה לסיכון חסימה ב-WhatsApp:

הודעה: "${message}"
גיל הסשן: ${sessionAge} ימים
הודעות היום: ${messagesToday}

ענה בעברית בפורמט JSON:
{
  "riskScore": 1-10,
  "riskFactors": ["גורם 1", "גורם 2"],
  "suggestions": ["הצעה לשיפור"],
  "safe": true/false
}
`;

  const result = await askGemini(prompt);
  
  if (result.success) {
    try {
      const jsonMatch = result.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result.parsed = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {}
  }
  
  return result;
}

/**
 * למידה מאירוע חסימה - שמירה בזיכרון
 */
async function learnFromBan(sessionId, banData) {
  const redis = getRedis();
  
  // Store ban event for learning
  const banRecord = {
    sessionId,
    timestamp: Date.now(),
    ...banData
  };
  
  await redis.lpush("ai:ban_history", JSON.stringify(banRecord));
  await redis.ltrim("ai:ban_history", 0, 99); // Keep last 100
  
  // Analyze and store insight
  const events = banData.recentEvents || [];
  const analysis = await analyzeBanReason(banData, events);
  
  if (analysis.success) {
    const insight = {
      type: "BAN_ANALYSIS",
      sessionId,
      analysis: analysis.response,
      timestamp: Date.now()
    };
    
    await redis.lpush("ai:insights", JSON.stringify(insight));
    await redis.ltrim("ai:insights", 0, 49); // Keep last 50
  }
  
  return analysis;
}

/**
 * קבלת תובנות אחרונות
 */
async function getRecentInsights(limit = 10) {
  const redis = getRedis();
  const insights = await redis.lrange("ai:insights", 0, limit - 1);
  return insights.map(i => {
    try {
      return JSON.parse(i);
    } catch (e) {
      return { raw: i };
    }
  });
}

/**
 * קבלת היסטוריית חסימות
 */
async function getBanHistory(limit = 20) {
  const redis = getRedis();
  const history = await redis.lrange("ai:ban_history", 0, limit - 1);
  return history.map(h => {
    try {
      return JSON.parse(h);
    } catch (e) {
      return { raw: h };
    }
  });
}

/**
 * שאלת שיפור יומית - מה לשפר?
 */
async function getDailyImprovement() {
  const redis = getRedis();
  
  // Get recent stats
  const banHistory = await getBanHistory(10);
  const insights = await getRecentInsights(5);
  
  const prompt = `
אתה יועץ אנטי-ספאם. בהתבסס על הנתונים, תן 3 המלצות לשיפור היום:

היסטוריית חסימות אחרונה:
${banHistory.slice(0, 5).map(b => `- סשן ${b.sessionId}: ${b.reason || 'לא ידוע'}`).join('\n') || 'אין נתונים'}

תובנות אחרונות:
${insights.slice(0, 3).map(i => `- ${i.type}: ${(i.analysis || '').slice(0, 100)}`).join('\n') || 'אין תובנות'}

ענה בעברית - 3 המלצות קצרות וישימות:
`;

  return await askGemini(prompt);
}

/**
 * בדיקת בריאות AI
 */
async function healthCheck() {
  if (!GEMINI_API_KEY) {
    return {
      configured: false,
      status: "NOT_CONFIGURED",
      message: "GEMINI_API_KEY חסר"
    };
  }

  const testResult = await askGemini("בדיקה - ענה OK");
  
  return {
    configured: true,
    status: testResult.success ? "OK" : "ERROR",
    message: testResult.success ? "Gemini מחובר ועובד" : testResult.error
  };
}

module.exports = {
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
};


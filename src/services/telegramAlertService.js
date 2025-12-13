/**
 * Telegram Alert Service
 * Sends real-time alerts to Telegram for monitoring
 */

const axios = require("axios");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Rate limiting - prevent spam
const alertCooldowns = new Map();
const COOLDOWN_MS = 60000; // 1 minute between same alerts

const ALERT_ICONS = {
  error: "🚨",
  warning: "⚠️",
  info: "ℹ️",
  success: "✅",
  session: "📱",
  proxy: "🌐",
  inventory: "📦",
  backup: "💾",
  system: "🖥️"
};

/**
 * Check if alert is in cooldown
 */
function isInCooldown(alertKey) {
  const lastSent = alertCooldowns.get(alertKey);
  if (!lastSent) return false;
  return (Date.now() - lastSent) < COOLDOWN_MS;
}

/**
 * Send alert to Telegram
 */
async function sendTelegramAlert(type, title, message, details = {}, options = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram] Not configured, skipping alert:", title);
    return { sent: false, reason: "NOT_CONFIGURED" };
  }

  // Check cooldown (unless forced)
  const alertKey = `${type}:${title}`;
  if (!options.force && isInCooldown(alertKey)) {
    console.log("[Telegram] Alert in cooldown:", title);
    return { sent: false, reason: "COOLDOWN" };
  }

  const icon = ALERT_ICONS[type] || "📢";
  const timestamp = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });

  let text = `${icon} <b>${title}</b>\n\n${message}\n`;
  
  if (Object.keys(details).length > 0) {
    text += `\n<b>פרטים:</b>\n`;
    for (const [key, value] of Object.entries(details)) {
      text += `• ${key}: <code>${value}</code>\n`;
    }
  }
  
  text += `\n🕐 ${timestamp}`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_notification: type === "info" || options.silent
      },
      { timeout: 10000 }
    );
    
    // Update cooldown
    alertCooldowns.set(alertKey, Date.now());
    
    console.log(`[Telegram] ✅ Alert sent: ${title}`);
    return { sent: true };
  } catch (error) {
    console.error("[Telegram] ❌ Failed to send alert:", error.message);
    return { sent: false, error: error.message };
  }
}

// =====================================================
// SPECIFIC ALERT FUNCTIONS
// =====================================================

/**
 * Alert: Session disconnected and can't reconnect
 */
async function alertSessionDown(sessionId, reason) {
  return sendTelegramAlert(
    "error",
    "סשן נפל!",
    `הסשן <code>${sessionId}</code> התנתק ולא מצליח להתחבר מחדש.`,
    { 
      "Session ID": sessionId, 
      "סיבה": reason 
    }
  );
}

/**
 * Alert: Session banned by WhatsApp
 */
async function alertSessionBanned(sessionId, phone) {
  return sendTelegramAlert(
    "error",
    "⛔ סשן נחסם!",
    `הסשן <code>${sessionId}</code> נחסם על ידי WhatsApp!\nיש לבדוק מיד ולהחליף את המספר.`,
    { 
      "Session ID": sessionId, 
      "מספר": phone || "לא ידוע" 
    },
    { force: true } // Always send ban alerts
  );
}

/**
 * Alert: Proxy burned/blocked
 */
async function alertProxyBurned(proxyId, sessionsAffected) {
  const shortProxy = proxyId.length > 30 ? `...${proxyId.slice(-25)}` : proxyId;
  return sendTelegramAlert(
    "warning",
    "פרוקסי נשרף",
    `הפרוקסי סומן כ-BAD ו-${sessionsAffected} סשנים הועברו.`,
    { 
      "Proxy": shortProxy, 
      "סשנים מושפעים": sessionsAffected 
    }
  );
}

/**
 * Alert: Low inventory (proxies/profiles)
 */
async function alertLowInventory(type, available, minimum) {
  const typeHeb = type === "proxies" ? "פרוקסים" : "פרופילים";
  return sendTelegramAlert(
    "inventory",
    "מלאי נמוך!",
    `נשארו רק ${available} ${typeHeb} - פחות מהמינימום הנדרש (${minimum})!`,
    { 
      "סוג": typeHeb, 
      "זמין": available, 
      "מינימום": minimum 
    }
  );
}

/**
 * Alert: Session connected successfully
 */
async function alertSessionConnected(sessionId, phone) {
  return sendTelegramAlert(
    "success",
    "סשן התחבר!",
    `הסשן <code>${sessionId}</code> התחבר בהצלחה.`,
    { 
      "Session ID": sessionId, 
      "מספר": phone || "pending" 
    },
    { silent: true }
  );
}

/**
 * Alert: Session logged out
 */
async function alertSessionLoggedOut(sessionId, phone) {
  return sendTelegramAlert(
    "warning",
    "סשן התנתק",
    `הסשן <code>${sessionId}</code> התנתק (logged out).`,
    { 
      "Session ID": sessionId, 
      "מספר": phone || "לא ידוע" 
    }
  );
}

/**
 * Alert: Backup completed
 */
async function alertBackupComplete(backupName, sizeMB, sessionsCount) {
  return sendTelegramAlert(
    "backup",
    "גיבוי הושלם",
    `גיבוי יומי הושלם בהצלחה.`,
    { 
      "קובץ": backupName, 
      "גודל": `${sizeMB} MB`,
      "סשנים": sessionsCount
    },
    { silent: true }
  );
}

/**
 * Alert: Backup failed
 */
async function alertBackupFailed(error) {
  return sendTelegramAlert(
    "error",
    "גיבוי נכשל!",
    `הגיבוי היומי נכשל. יש לבדוק את המערכת.`,
    { "שגיאה": error }
  );
}

/**
 * Alert: Daily summary
 */
async function alertDailySummary(stats) {
  const lines = [
    `📊 <b>סיכום יומי</b>`,
    ``,
    `📱 סשנים פעילים: ${stats.activeSessions || 0}`,
    `✉️ הודעות נשלחו: ${stats.messagesSent || 0}`,
    `❌ הודעות נכשלו: ${stats.messagesFailed || 0}`,
    `🌐 פרוקסים זמינים: ${stats.proxiesAvailable || 0}`,
    `⚠️ פרוקסים BAD: ${stats.proxiesBad || 0}`
  ];
  
  return sendTelegramAlert(
    "info",
    "📊 סיכום יומי",
    lines.join("\n"),
    {},
    { force: true }
  );
}

/**
 * Alert: System startup
 */
async function alertSystemStartup() {
  return sendTelegramAlert(
    "system",
    "המערכת עלתה",
    `ה-Orchestrator התחיל לפעול.`,
    { 
      "זמן": new Date().toISOString() 
    },
    { force: true }
  );
}

/**
 * Alert: Watchdog action
 */
async function alertWatchdogAction(action, sessionId, details) {
  return sendTelegramAlert(
    "warning",
    `Watchdog: ${action}`,
    `הווטשדוג ביצע פעולה על סשן <code>${sessionId}</code>.`,
    { 
      "פעולה": action, 
      "Session ID": sessionId,
      ...details
    }
  );
}

/**
 * Alert: Incident bridge (generic)
 * Sends only for important incident types to keep Telegram "quiet".
 */
async function alertIncident(incident) {
  const t = String(incident?.type || "").trim();
  if (!t) return { sent: false, reason: "NO_TYPE" };

  // Keep Telegram for problems / actions (not for every metric)
  switch (t) {
    case "PROXY_BURN":
      return alertProxyBurned(String(incident.proxyId || incident.proxy || ""), Number(incident.sessionsAffected || 0) || 0);

    case "PROXY_MARKED_BAD":
      return sendTelegramAlert(
        "warning",
        "פרוקסי סומן BAD",
        "המערכת סימנה פרוקסי כ-BAD עקב בעיה חוזרת.",
        {
          Proxy: String(incident.proxyId || incident.proxy || ""),
          סיבה: String(incident.reason || "")
        }
      );

    case "SESSION_LOGGED_OUT":
      return alertSessionLoggedOut(String(incident.sessionId || ""), String(incident.phone || ""));

    case "SESSION_MAX_RECONNECTS":
      return alertSessionDown(String(incident.sessionId || ""), String(incident.reason || "MAX_RECONNECTS"));

    case "SESSION_BRAIN_ENFORCER_ERROR":
      return sendTelegramAlert(
        "error",
        "Session Brain Enforcer שגיאה",
        "נכשלה הרצת enforcer (בדוק לוגים).",
        { שגיאה: String(incident.reason || "") }
      );

    case "SESSION_BRAIN_DECISION_APPLIED":
      return sendTelegramAlert(
        "warning",
        "Session Brain החליט + יושם",
        "בוצעה פעולה אוטומטית בעקבות החלטת Session Brain.",
        {
          kind: String(incident.kind || ""),
          target: String(incident.target || ""),
          action: String(incident.action || ""),
          reason: String(incident.reason || "")
        },
        { silent: true }
      );

    case "SEND_FAILED":
      // Throttled by cooldown in sendTelegramAlert; still keep it light.
      return sendTelegramAlert(
        "warning",
        `כשל שליחה (${String(incident.sessionId || "").slice(0, 12)})`,
        "נכשל ניסיון שליחה דרך סשן. אם זה חוזר - מומלץ להוריד RPM / להחליף פרוקסי.",
        {
          sessionId: String(incident.sessionId || ""),
          phone: String(incident.phone || ""),
          reason: String(incident.reason || incident.error || "")
        }
      );

    default:
      return { sent: false, reason: "IGNORED_TYPE" };
  }
}

/**
 * Test Telegram connection
 */
async function testTelegramConnection() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { 
      configured: false, 
      error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" 
    };
  }

  try {
    const result = await sendTelegramAlert(
      "success",
      "🔔 בדיקת חיבור",
      "החיבור לטלגרם עובד תקין!",
      { "Test": "OK" },
      { force: true }
    );
    
    return { configured: true, ...result };
  } catch (error) {
    return { configured: true, sent: false, error: error.message };
  }
}

/**
 * Get Telegram config status
 */
function getTelegramStatus() {
  return {
    configured: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    botToken: TELEGRAM_BOT_TOKEN ? "***configured***" : null,
    chatId: TELEGRAM_CHAT_ID || null,
    cooldownMs: COOLDOWN_MS,
    activeCooldowns: alertCooldowns.size
  };
}

module.exports = {
  sendTelegramAlert,
  alertSessionDown,
  alertSessionBanned,
  alertProxyBurned,
  alertLowInventory,
  alertSessionConnected,
  alertSessionLoggedOut,
  alertBackupComplete,
  alertBackupFailed,
  alertDailySummary,
  alertSystemStartup,
  alertWatchdogAction,
  alertIncident,
  testTelegramConnection,
  getTelegramStatus
};


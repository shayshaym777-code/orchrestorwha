# 🔐 קובץ `.env` מומלץ לפריסה

## 📝 העתק את זה ל-`.env` ועדכן את הערכים

```bash
# =====================================================
# WhatsApp Orchestrator - Production Configuration
# =====================================================

# === Server ===
PORT=3000
NODE_ENV=production
ORCH_PORT=3001

# === API Security ===
# ⚠️ חובה: החלף לערכים רנדומליים!
# ליצירת API_KEY: openssl rand -base64 32
# ליצירת WEBHOOK_SECRET: openssl rand -base64 32
API_KEY=CHANGE-ME-run-openssl-rand-base64-32
WEBHOOK_SECRET=CHANGE-ME-run-openssl-rand-base64-32

# === Redis (Docker) ===
REDIS_URL=redis://redis:6379

# === Database ===
DB_PATH=./data/orchestrator.sqlite

# === Session Limits ===
MAX_SESSIONS_PER_PROXY=4
MAX_SESSIONS_PER_PHONE=4

# === Timing/Intervals ===
PROVISIONING_INTERVAL_MS=2000
MONITOR_INTERVAL_MS=30000
WATCHDOG_INTERVAL_MS=60000
PING_TIMEOUT_MS=180000

# === Inventory Thresholds ===
PROFILES_LOW_THRESHOLD=5
PROXIES_LOW_THRESHOLD=3

# =====================================================
# PROXIES - חובה להגדיר!
# =====================================================
# Format: socks5h://user:pass@host:port
# חובה socks5h (עם h!) לאנטי-באן - מבטיח DNS דרך הפרוקסי
#
# דוגמה לפורמט Decodo/Smartproxy:
# socks5h://user-SESSION-ip-STICKY_IP:password@gate.decodo.com:10001
#
PROXY_URL_1=socks5h://user:pass@proxy1.example.com:10001
PROXY_URL_2=socks5h://user:pass@proxy2.example.com:10002
PROXY_URL_3=socks5h://user:pass@proxy3.example.com:10003
PROXY_URL_4=
PROXY_URL_5=

# =====================================================
# Telegram Alerts (אופציונלי - מומלץ!)
# =====================================================
# קבל token מ-@BotFather בטלגרם
TELEGRAM_BOT_TOKEN=
# קבל chat ID מ-@userinfobot או מהגדרות הקבוצה
TELEGRAM_CHAT_ID=
# התראות אוטומטיות על אירועים חשובים
TELEGRAM_INCIDENT_ALERTS_ENABLED=false
TELEGRAM_INCIDENT_POLL_INTERVAL_MS=5000
# התראות על Jobs
TELEGRAM_JOB_ALERTS_ENABLED=false
TELEGRAM_JOB_POLL_INTERVAL_MS=5000

# =====================================================
# AI Integration (אופציונלי)
# =====================================================
# Google Gemini API
GEMINI_API_KEY=

# =====================================================
# Session Brain (אופציונלי - מתקדם)
# =====================================================
SESSION_BRAIN_URL=http://127.0.0.1:9000
SESSION_BRAIN_ENFORCER_ENABLED=false
SESSION_BRAIN_ENFORCER_INTERVAL_MS=15000

# =====================================================
# Backup Configuration
# =====================================================
SESSIONS_DIR=./sessions
BACKUPS_DIR=./backups
MAX_BACKUPS=7

# =====================================================
# Worker Settings (לdocker-compose - לא לשנות!)
# =====================================================
# ENABLE_KEEP_ALIVE=true
# PRESENCE_INTERVAL_MS=15000
# HIDDEN_MSG_INTERVAL_MS=600000
```

---

## 🔑 ייצור מפתחות רנדומליים

```bash
# API Key (32 תווים)
openssl rand -base64 32

# Webhook Secret (32 תווים)
openssl rand -base64 32
```

---

## 📌 הערות חשובות

1. **PROXY_URL_1/2/3** - חובה להגדיר לפחות אחד (לפחות worker אחד)
2. **API_KEY** - חובה להחליף (לא להשאיר default)
3. **WEBHOOK_SECRET** - חובה להחליף (לא להשאיר default)
4. **ORCH_PORT** - פורט האורקסטרטור (ברירת מחדל: 3001)

---

## 🎯 דוגמה לקובץ `.env` מוכן

```bash
# Server
PORT=3000
NODE_ENV=production
ORCH_PORT=3001

# Security (הוחלף!)
API_KEY=e1QHGhQzBS8MuaJPgEnLvtKd7UhOlkIk2ScK6xgtWXk=
WEBHOOK_SECRET=YyDIdeGqO8UJiSJfVk+jGfho3q7S5A7g5NJR7JoC9E8=

# Redis
REDIS_URL=redis://redis:6379

# Proxies (דוגמה)
PROXY_URL_1=socks5h://user1:pass1@proxy1.example.com:10001
PROXY_URL_2=socks5h://user2:pass2@proxy2.example.com:10002
PROXY_URL_3=socks5h://user3:pass3@proxy3.example.com:10003

# Telegram (אופציונלי)
TELEGRAM_BOT_TOKEN=8232981712:AAHzSOgK3qcmnX6I7aQH7O6M9kZP3EMz2nQ
TELEGRAM_CHAT_ID=
```


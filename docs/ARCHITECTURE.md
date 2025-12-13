# 🏗️ WhatsApp Orchestrator - Architecture

## ⚠️ עיקרון מרכזי: Anti-Ban First

**הארכיטקטורה שלנו שונה מ-"Worker שמחזיק 50 סשנים".**  
אצלנו: **קונטיינר אחד = סשן אחד**, עם בידוד מלא ו-Sticky IP.

---

## 📊 תרשים ארכיטקטורה

```
┌────────────────────────────────────────────────────────────────────────┐
│                           EXTERNAL                                      │
│                                                                        │
│   📱 Client App / CRM / Automation                                     │
│              │                                                         │
│              │ POST /api/send { to, text, ... }                        │
│              ▼                                                         │
├────────────────────────────────────────────────────────────────────────┤
│                        API GATEWAY                                      │
│                    (Separate Service)                                   │
│                                                                        │
│   • API Key validation                                                 │
│   • Rate limiting (global)                                             │
│   • Request validation (Joi)                                           │
│   • Idempotency check                                                  │
│              │                                                         │
│              │ LPUSH gateway:jobs { ... }                              │
│              ▼                                                         │
├────────────────────────────────────────────────────────────────────────┤
│                        REDIS                                            │
│                                                                        │
│   gateway:jobs ─────────────────────────────────────────┐              │
│   queue:session:<phone> ────────────────────────────────┤              │
│   session:outbox:<sessionId> ───────────────────────────┤              │
│   sessions:active ──────────────────────────────────────┤              │
│   proxies:available ────────────────────────────────────┤              │
│   phone:proxy:<phone> (Sticky mapping) ─────────────────┘              │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│                       DISPATCHER                                        │
│                    (Anti-Ban Engine)                                    │
│                                                                        │
│   • BRPOP gateway:jobs                                                 │
│   • Routes to queue:session:<phone>                                    │
│   • Enforces:                                                          │
│     - RPM per session (Trust Level based)                              │
│     - Jitter/randomization                                             │
│     - Burst detection                                                  │
│              │                                                         │
│              │ Per-session queues                                      │
│              ▼                                                         │
├────────────────────────────────────────────────────────────────────────┤
│                      ORCHESTRATOR                                       │
│                      (Server A)                                         │
│                                                                        │
│   • Session Registry (Lua atomic)                                      │
│   • Proxy Management:                                                  │
│     - Phone→Proxy Sticky mapping                                       │
│     - Max 4 sessions per proxy                                         │
│     - BAD/OK health tracking                                           │
│   • Profile inventory                                                  │
│   • Watchdog (health monitoring)                                       │
│   • Runner (docker start/stop/restart)                                 │
│   • Webhook ingestion from Workers                                     │
│   • Outbox per session: session:outbox:<sessionId>                     │
│              │                                                         │
│              │ docker run -e PROXY_URL=... -e SESSION_ID=...           │
│              ▼                                                         │
├────────────────────────────────────────────────────────────────────────┤
│                        WORKERS                                          │
│              (One Container = One Session)                              │
│                                                                        │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                │
│   │  Worker A    │  │  Worker B    │  │  Worker C    │                │
│   │              │  │              │  │              │                │
│   │ SESSION_ID=1 │  │ SESSION_ID=2 │  │ SESSION_ID=3 │                │
│   │ PROXY=1.2.3.4│  │ PROXY=1.2.3.4│  │ PROXY=5.6.7.8│                │
│   │ PHONE=97250..│  │ PHONE=97252..│  │ PHONE=97254..│                │
│   │              │  │              │  │              │                │
│   │ • Baileys    │  │ • Baileys    │  │ • Baileys    │                │
│   │ • Keep-Alive │  │ • Keep-Alive │  │ • Keep-Alive │                │
│   │ • Outbox pull│  │ • Outbox pull│  │ • Outbox pull│                │
│   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                │
│          │                 │                 │                         │
│          │ Webhook: QR/CONNECTED/PING/ERROR                            │
│          └─────────────────┴─────────────────┘                         │
│                            │                                           │
│                            ▼                                           │
│                     WhatsApp Servers                                   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🔑 עקרונות מפתח

### 1. קונטיינר אחד = סשן אחד
```
❌ Worker שמחזיק 50 סשנים
✅ Worker אחד = סשן אחד = בידוד מלא
```

**למה?**
- קריסה של סשן אחד לא מפילה אחרים
- קל לנטר ולדבג
- Restart מהיר בלי להשפיע על אחרים
- Session volume נפרד לכל אחד

### 2. Sticky IP (Phone→Proxy)
```
❌ Proxy קבוע ל-Worker
✅ Proxy קבוע למספר טלפון
```

**למה?**
- WhatsApp עוקב אחרי IP
- קפיצות IP = חשד = באן
- אותו מספר תמיד מאותו IP

### 3. מקסימום 4 סשנים לפרוקסי
```
❌ 50 סשנים על פרוקסי אחד
✅ מקס 4 סשנים לפרוקסי
```

**למה?**
- פיזור עומס
- אם פרוקסי נשרף - רק 4 סשנים מושפעים
- מקטין סיכון לזיהוי כ-"farm"

---

## 📦 רכיבים קיימים

| רכיב | סטטוס | תיאור |
|------|-------|-------|
| **API Gateway** | ✅ קיים | שירות נפרד, validation, rate limit |
| **Dispatcher** | ✅ קיים | Anti-ban, per-session queues, RPM/jitter |
| **Orchestrator** | ✅ קיים | Sessions, proxies, profiles, watchdog |
| **Worker** | ✅ קיים | Baileys, keep-alive, outbox pull |
| **Redis** | ✅ קיים | Queues, state, Lua scripts |
| **Dashboard** | ✅ קיים | Basic HTML/JS |
| **Telegram Alerts** | ✅ קיים | Session down, proxy burned, low inventory |
| **Backup Service** | ✅ קיים | Daily backup at 3 AM |

---

## 📦 רכיבים לא קיימים (אופציונלי)

| רכיב | סטטוס | הערה |
|------|-------|------|
| NGINX Load Balancer | ❌ | לא נדרש כרגע |
| Prometheus | ❌ | ניטור מתקדם |
| Grafana | ❌ | דשבורדים |
| Loki | ❌ | Log aggregation |
| Elasticsearch | ❌ | חיפוש לוגים |

---

## 🚀 פקודת Worker מלאה

```bash
docker run -d --restart unless-stopped \
  --name wa_session_<SESSION_ID> \
  -v /host/data/sessions/<SESSION_ID>:/app/sessions/<SESSION_ID> \
  -e SESSION_ID="<SESSION_ID>" \
  -e PROXY_URL="socks5h://user-xxxxx-ip-1.2.3.4:password123@isp.decodo.com:10001" \
  -e WEBHOOK_URL="http://<ORCHESTRATOR_HOST>:3000/api/webhook" \
  -e WEBHOOK_SECRET="<SECRET>" \
  -e ENABLE_KEEP_ALIVE=true \
  whatsapp-worker-image:1.0.0
```

> ⚠️ **חובה `socks5h://`** - ה-`h` מבטיח DNS resolution דרך הפרוקסי (מונע דליפות DNS)

---

## 📊 Redis Keys

```
# Gateway
gateway:jobs                    → LIST of incoming jobs

# Dispatcher (per-session queues)
queue:session:<phone>           → LIST of tasks for this phone

# Orchestrator
sessions:active                 → SET of active session IDs
session:<sessionId>             → HASH { phone, proxy, status, ... }
session:outbox:<sessionId>      → LIST of messages to send

# Proxy Management
proxies:available               → SET of healthy proxies
proxies:all                     → SET of all proxies
phone:proxy:<phone>             → Sticky proxy URL
counter:proxy:<proxyUrl>        → Session count on proxy
proxy:status:<proxyUrl>         → "OK" | "BAD"

# Webhooks
session:qr:<sessionId>          → QR code data
session:status:<sessionId>      → Current status
session:events:<sessionId>      → LIST of events
```

---

## 🔄 Message Flow

```
1. Client POST /api/send { to: "972501234567", text: "Hello" }
           │
           ▼
2. Gateway validates → LPUSH gateway:jobs
           │
           ▼
3. Dispatcher BRPOP gateway:jobs
   → Finds session for phone 972501234567
   → LPUSH queue:session:972501234567
           │
           ▼
4. Orchestrator moves to outbox
   → BRPOPLPUSH queue:session:972501234567 → session:outbox:<sessionId>
           │
           ▼
5. Worker pulls from outbox
   → POST /api/worker/sessions/<id>/outbox/claim
   → Sends via Baileys
   → ACK on success, NACK on failure
```

---

## 📝 Summary for Docker Developer

> **"הדוקר לא מחליט פרוקסי. ה־Orchestrator מחזיק מיפוי Phone→Proxy (Sticky), ורק הוא מריץ את הקונטיינר עם PROXY_URL. רק במקרה תקלה (proxy burned/timeout) ה־Orchestrator מחליט להחליף ומרים מחדש את אותו סשן עם פרוקסי חדש."**

### 🚫 מה לא לעשות:
- לא לתת ל-Worker להחליף פרוקסי לבד
- לא להריץ יותר מסשן אחד בקונטיינר
- לא לשים יותר מ-4 סשנים על פרוקסי

### ✅ מה כן:
- Worker מקבל PROXY_URL ב-ENV ומשתמש בו כל הזמן
- Worker מדווח תקלות ב-webhook
- Orchestrator מחליט על החלפות


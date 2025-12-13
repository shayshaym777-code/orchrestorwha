# 🌐 Proxy Architecture - Sticky IP

## עיקרון מרכזי
**Worker לא מנהל פרוקסים. Orchestrator מייצר מיפוי Phone→Proxy (Sticky), מעביר PROXY_URL ב־ENV. רק אם יש תקלה Orchestrator מחליט על החלפה ומרים מחדש את הקונטיינר עם פרוקסי חדש.**

---

## 🎯 חלוקת אחריות

### Orchestrator (Server A) - מנהל הפרוקסים
| תפקיד | תיאור |
|-------|-------|
| **Sticky IP** | אותו מספר טלפון נשאר עם אותו פרוקסי לאורך זמן |
| **מגבלת שימוש** | מקס' 4 סשנים לכל פרוקסי (למניעת שריפה) |
| **Anti-Ban** | חלוקה + תזמון + קצב שליחה (Dispatcher/Queues) |
| **Proxy Health** | מעקב אחרי BAD/OK status |
| **Switch Proxy** | החלפת פרוקסי בתקלה + restart worker |

### Worker - משתמש בלבד
| תפקיד | תיאור |
|-------|-------|
| **קבלת PROXY_URL** | מקבל ב-ENV בזמן `docker run` |
| **שימוש קבוע** | משתמש באותו פרוקסי כל זמן שהסשן פעיל |
| **דיווח תקלות** | שולח webhook על `PROXY_ERROR` / `DISCONNECT` |
| **לא מחליף לבד** | ❌ לעולם לא מחליף פרוקסי באופן עצמאי |

---

## 🔄 Flow: הקצאת פרוקסי

```
┌─────────────────────────────────────────────────────────────┐
│                    SESSION ALLOCATION                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Request: allocateSession(phone, sessionId)              │
│                        │                                    │
│                        ▼                                    │
│  2. Orchestrator checks:                                    │
│     - Does phone already have a proxy? (Sticky)             │
│     - If not: pick least-loaded proxy                       │
│     - Verify proxy has < 4 sessions                         │
│                        │                                    │
│                        ▼                                    │
│  3. Store mapping in Redis:                                 │
│     phone:proxy:{phone} → {proxyUrl}                        │
│     session:{id} → { proxy: proxyUrl, ... }                 │
│                        │                                    │
│                        ▼                                    │
│  4. Start Worker with ENV:                                  │
│     docker run -e PROXY_URL={proxyUrl} ...                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## ⚠️ Flow: תקלת פרוקסי

```
┌─────────────────────────────────────────────────────────────┐
│                    PROXY FAILURE HANDLING                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Worker detects error:                                   │
│     - Connection timeout                                    │
│     - Status 515 (Stream Error)                             │
│     - Proxy unreachable                                     │
│                        │                                    │
│                        ▼                                    │
│  2. Worker sends webhook:                                   │
│     POST /api/webhook                                       │
│     { type: "STATUS_CHANGE",                                │
│       data: { status: "PROXY_ERROR", error: "..." } }       │
│                        │                                    │
│     ⚠️ Worker does NOT switch proxy!                        │
│                        │                                    │
│                        ▼                                    │
│  3. Orchestrator receives webhook:                          │
│     - Marks proxy as BAD (with cooldown)                    │
│     - Finds new healthy proxy                               │
│     - Updates session mapping                               │
│                        │                                    │
│                        ▼                                    │
│  4. Orchestrator restarts worker:                           │
│     - docker stop {old_container}                           │
│     - docker run -e PROXY_URL={new_proxy} ...               │
│     - Auth volume preserved (no re-scan needed)             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 📊 Redis Keys Structure

```
# Proxy Pool
proxies:available           → SET of all proxy URLs
proxies:all                 → SET of all proxies (including BAD)

# Proxy Health
proxy:status:{proxyUrl}     → "OK" | "BAD"
proxy:bad_at:{proxyUrl}     → timestamp when marked bad
proxy:bad_reason:{proxyUrl} → reason string

# Sticky Mapping
phone:proxy:{phone}         → proxy URL for this phone
counter:proxy:{proxyUrl}    → number of sessions on this proxy

# Session Data
session:{sessionId}         → HASH { proxy, phone, status, ... }
```

---

## 🛡️ Anti-Ban Benefits

| Benefit | Description |
|---------|-------------|
| **No IP Jumping** | אותו מספר תמיד מאותו IP - לא חשוד |
| **Load Balance** | מקסימום 4 סשנים לפרוקסי |
| **Quick Recovery** | תקלה בפרוקסי = החלפה מהירה בלי לאבד סשן |
| **Centralized Control** | Orchestrator רואה תמונה מלאה |

---

## 🔧 Configuration

```env
# Orchestrator
MAX_SESSIONS_PER_PROXY=4
PROXY_BAD_COOLDOWN_MS=300000  # 5 minutes

# Worker (set by Orchestrator)
PROXY_URL=http://user:pass@proxy.example.com:8080
```

---

## 📝 Summary for Docker Developer

> **"Worker לא מנהל פרוקסים. Orchestrator מייצר מיפוי Phone→Proxy (Sticky), מעביר PROXY_URL ב־ENV. רק אם יש תקלה Orchestrator מחליט על החלפה ומרים מחדש את הקונטיינר עם פרוקסי חדש."**


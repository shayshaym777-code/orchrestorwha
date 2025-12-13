# 📋 שרת הדוקר - איפיון מלא (Session Management)

---

## 🎯 מטרת השרת
ניהול מחזור חיים מלא של חיבורי WhatsApp:
- יצירת סשנים חדשים
- ייצור QR לסריקה
- שמירת Auth credentials
- Keep-Alive לשמירת חיבור
- גיבוי ושחזור
- ניהול פרוקסים (Sticky IP)

---

## 🏗️ עקרונות ליבה

### 1. בידוד מלא
```
קונטיינר אחד = סשן אחד = מספר טלפון אחד
```
- כל חשבון WhatsApp רץ בקונטיינר נפרד
- תקלה בסשן אחד לא משפיעה על אחרים
- ניתן לאתחל/למחוק סשן בודד

### 2. Sticky IP
```
מספר טלפון → פרוקסי (קבוע)
```
- אותו טלפון תמיד עם אותו IP
- מניעת "קפיצות IP" שגורמות לבאן
- החלפה רק בתקלת פרוקסי

### 3. מגבלות פרוקסי
```
מקסימום 4 סשנים לפרוקסי
```
- מניעת שריפת פרוקסים
- חלוקה אוטומטית של עומס

---

## 📦 קומפוננטות

### Redis Keys
```
# סטטוס סשן
session:<id>:status     = "pending" | "qr_ready" | "connected" | "disconnected" | "failed"
session:<id>:phone      = "972501234567"
session:<id>:proxy      = "socks5h://..."
session:<id>:qr         = "2@ABC..." (זמני)
session:<id>:lock       = "container_xyz"
session:<id>:created    = 1702500000000
session:<id>:lastPing   = 1702500060000

# Sticky IP
phone:<number>:proxy    = "socks5h://..."
phone:<number>:session  = "worker_1"

# Proxy Pool
proxy:<url>:status      = "active" | "bad"
proxy:<url>:sessions    = 3
```

### קבצי Auth
```
sessions/
├── worker_1/
│   ├── creds.json
│   ├── app-state-sync-key-*.json
│   └── pre-key-*.json
├── worker_2/
│   └── ...
```

---

## 🔄 זרימות

### Flow 1: יצירת סשן חדש

```
POST /api/sessions/provision
{ phone?: "972...", proxy?: "socks5h://..." }
```

**שלבים:**

1. **Validation**
   - בדיקת פורמט טלפון
   - בדיקת פורמט פרוקסי (חייב להיות `socks5h://`)
   - בדיקה שהטלפון לא רשום כבר

2. **בחירת Proxy**
   ```
   if (proxy provided) → use it
   else if (phone has sticky) → use existing
   else → select from pool (capacity < 4)
   ```

3. **יצירת רשומה ב-Redis**
   ```
   session:X:status = "pending"
   session:X:proxy = selectedProxy
   session:X:created = Date.now()
   ```

4. **הפעלת Worker**
   ```bash
   docker run -d \
     --name wa_session_X \
     -e SESSION_ID=X \
     -e PROXY_URL=socks5h://... \
     -e WEBHOOK_URL=http://orchestrator:3000/webhook \
     -v sessions/X:/app/session \
     worker-image
   ```

5. **Worker מתחבר ומייצר QR**
   - Webhook: `{type: "QR_CODE", data: {qr: "..."}}`

6. **משתמש סורק QR**

7. **Worker מדווח חיבור**
   - Webhook: `{type: "CONNECTED", data: {phoneNumber: "972..."}}`

8. **יצירת Sticky IP**
   ```
   phone:972...:proxy = socks5h://...
   phone:972...:session = worker_X
   ```

### Flow 2: Keep-Alive

**Worker (כל 15 שניות):**
```javascript
sock.sendPresenceUpdate('available');
webhook('PING', { timestamp: Date.now() });
```

**Worker (כל 10 דקות):**
```javascript
sock.sendMessage(myJid, { text: "🔄" }, {
  ephemeralExpiration: 86400
});
```

**Orchestrator (Watchdog - כל דקה):**
```javascript
if (lastPing > 3 minutes) {
  markUnhealthy(session);
  restartWorker(session);
}
```

### Flow 3: התנתקות

**סוגי התנתקות:**

| סוג | טיפול |
|-----|-------|
| Proxy Error | החלפת פרוקסי, הפעלה מחדש |
| Logged Out | מחיקת Auth, דרישת QR חדש |
| Connection Lost | Worker מתחבר מחדש אוטומטית |

### Flow 4: Failover (תקלת פרוקסי)

```
1. Worker מדווח PROXY_ERROR
2. Orchestrator מסמן פרוקסי כ-BAD
3. בחירת פרוקסי חדש מהבריכה
4. עצירת Worker ישן
5. הפעלת Worker חדש עם פרוקסי חדש
6. עדכון Sticky: phone → newProxy
```

### Flow 5: גיבוי ושחזור

**גיבוי יומי (CRON 03:00):**
```
1. עצירת Workers
2. zip sessions/ → backups/backup_YYYY-MM-DD.zip
3. שמירת 7 גיבויים אחרונים
4. הפעלת Workers
```

**שחזור:**
```
1. עצירת Workers
2. מחיקת sessions/
3. חילוץ גיבוי
4. בניית מצב Redis מהקבצים
5. הפעלת Workers
```

---

## 📡 API Endpoints

### Sessions

| Method | Endpoint | תיאור |
|--------|----------|-------|
| POST | `/api/sessions/provision` | יצירת סשן |
| GET | `/api/sessions/:id/qr` | קבלת QR |
| GET | `/api/sessions/:id/status` | סטטוס |
| DELETE | `/api/sessions/:id` | מחיקה |
| POST | `/api/sessions/:id/restart` | הפעלה מחדש |

### Dashboard

| Method | Endpoint | תיאור |
|--------|----------|-------|
| GET | `/api/v1/dashboard/sessions` | כל הסשנים |
| GET | `/api/v1/dashboard/stats` | סטטיסטיקות |

### Backups

| Method | Endpoint | תיאור |
|--------|----------|-------|
| GET | `/api/v1/backups` | רשימת גיבויים |
| POST | `/api/v1/backups/create` | יצירת גיבוי |
| POST | `/api/v1/backups/restore/:id` | שחזור |

### Webhook (מ-Workers)

| Method | Endpoint | תיאור |
|--------|----------|-------|
| POST | `/webhook` | קבלת אירועים |

---

## 📊 Webhook Events

| Event | Data | תיאור |
|-------|------|-------|
| `QR_CODE` | `{qr: "2@..."}` | QR מוכן לסריקה |
| `CONNECTED` | `{phoneNumber: "972..."}` | התחבר בהצלחה |
| `DISCONNECTED` | `{reason, code}` | התנתק |
| `PING` | `{timestamp}` | Keep-alive |
| `PROXY_ERROR` | `{error}` | תקלת פרוקסי |
| `AUTH_FAILURE` | `{reason}` | נדרש QR חדש |

---

## 🔐 חוקי Proxy

| חוק | ערך | סיבה |
|-----|-----|------|
| פורמט | `socks5h://` | DNS דרך הפרוקסי |
| מקסימום | 4 סשנים/פרוקסי | מניעת שריפה |
| Sticky | Phone → Proxy | אותו IP תמיד |
| Failover | אוטומטי | החלפה בתקלה |

---

## ⚙️ Environment Variables

```bash
# Core
NODE_ENV=production
API_KEY=<random-32>
WEBHOOK_SECRET=<random-32>
REDIS_URL=redis://redis:6379

# Limits
MAX_SESSIONS_PER_PROXY=4
MAX_SESSIONS_PER_PHONE=4

# Timing
WATCHDOG_INTERVAL_MS=60000
PING_TIMEOUT_MS=180000

# Proxies
PROXY_URL_1=socks5h://user:pass@host:port
PROXY_URL_2=socks5h://user:pass@host:port

# Telegram
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<chat-id>

# Backups
SESSIONS_DIR=./sessions
BACKUPS_DIR=./backups
MAX_BACKUPS=7
```

---

## 🐳 Docker Compose

```yaml
version: "3.8"

networks:
  whatsapp-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16

services:
  redis:
    image: redis:7-alpine
    container_name: wa_redis
    networks:
      whatsapp-network:
        ipv4_address: 172.28.0.2

  orchestrator:
    build: .
    container_name: wa_orchestrator
    ports:
      - "${ORCH_PORT:-3001}:3000"
    environment:
      - REDIS_URL=redis://redis:6379
    volumes:
      - ./sessions:/app/sessions
      - ./backups:/app/backups
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      whatsapp-network:
        ipv4_address: 172.28.0.3
```

---

## 📁 מבנה קבצים

```
docker-server/
├── docker-compose.yml
├── Dockerfile
├── .env
├── package.json
│
├── src/
│   ├── server.js
│   ├── controllers/
│   │   ├── orchestratorController.js
│   │   └── webhookController.js
│   ├── services/
│   │   ├── sessionService.js
│   │   ├── runnerService.js
│   │   ├── proxyPoolService.js
│   │   ├── watchdogService.js
│   │   ├── backupService.js
│   │   └── telegramService.js
│   ├── routes/
│   └── infra/
│       └── redis.js
│
├── docker-wa-worker/
│   ├── Dockerfile
│   ├── package.json
│   └── index.ts          # Baileys + Keep-Alive
│
├── sessions/             # Auth data
└── backups/              # Backup files
```


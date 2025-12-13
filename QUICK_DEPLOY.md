# 🚀 מדריך פריסה מהיר - WhatsApp Orchestrator

## שלב 1: העלאת הקבצים לשרת

```bash
# בשרת - צור תיקייה
mkdir -p /opt/whatsapp-orchestrator
cd /opt/whatsapp-orchestrator

# העלה את הקבצים (SCP/SFTP/Git)
# אפשרות א: Git
git clone YOUR_REPO_URL .

# אפשרות ב: SCP (מהמחשב המקומי)
# scp -r * user@server:/opt/whatsapp-orchestrator/
```

---

## שלב 2: הגדרת Environment

```bash
cd /opt/whatsapp-orchestrator

# צור קובץ .env מהתבנית
cp env.example .env

# ערוך את הקובץ
nano .env
```

### הגדרות חובה לעדכן ב-.env:

```env
# === חובה ===
API_KEY=your-random-secret-key-here
WEBHOOK_SECRET=your-random-webhook-secret-here
ORCH_PORT=3001

# === Proxies (חובה - socks5h!) ===
PROXY_URL_1=socks5h://user:pass@proxy1.example.com:10001
PROXY_URL_2=socks5h://user:pass@proxy2.example.com:10002
PROXY_URL_3=socks5h://user:pass@proxy3.example.com:10003

# === אופציונלי - Telegram Alerts ===
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id

# === אופציונלי - AI ===
GEMINI_API_KEY=your-gemini-key
```

**ליצירת מפתחות רנדומליים:**
```bash
# API_KEY
openssl rand -base64 32

# WEBHOOK_SECRET
openssl rand -hex 16
```

---

## שלב 3: יצירת תיקיות

```bash
mkdir -p sessions backups data
chmod 755 sessions backups data
```

---

## שלב 4: בניית Docker Images

```bash
cd /opt/whatsapp-orchestrator

# בנה את כל ה-images
docker compose build --no-cache

# זה לוקח 2-5 דקות
```

---

## שלב 5: הפעלה

```bash
# הפעל את כל השירותים
docker compose up -d

# המתן 10 שניות
sleep 10

# בדוק סטטוס
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

**פלט צפוי:**
```
NAMES             STATUS
wa_worker_3       Up X seconds
wa_worker_2       Up X seconds
wa_worker_1       Up X seconds
wa_orchestrator   Up X seconds (healthy)
wa_redis          Up X seconds (healthy)
```

---

## שלב 6: בדיקות

```bash
# Health Check
curl http://localhost:3001/health

# Dashboard Stats
curl -s http://localhost:3001/api/v1/dashboard/stats \
  -H "X-API-KEY: YOUR_API_KEY" | jq .

# בדוק Dashboard בדפדפן
echo "Dashboard: http://YOUR_SERVER_IP:3001/"
echo "QR Scan: http://YOUR_SERVER_IP:3001/scan"
echo "Live Log: http://YOUR_SERVER_IP:3001/live-log"
echo "Anti-Ban: http://YOUR_SERVER_IP:3001/anti-ban"
```

---

## שלב 7: ניקוי Locks (אם יש בעיה)

אם ה-workers תקועים עם "Session is locked":

```bash
# עצור workers
docker stop wa_worker_1 wa_worker_2 wa_worker_3

# נקה locks מ-Redis
docker exec wa_redis redis-cli DEL session:worker_1:lock session:worker_2:lock session:worker_3:lock

# הפעל מחדש
docker start wa_worker_1 wa_worker_2 wa_worker_3
```

---

## 📋 פקודה אחת לכל התהליך

```bash
cd /opt/whatsapp-orchestrator && \
mkdir -p sessions backups data && \
docker compose down 2>/dev/null; \
docker compose build --no-cache && \
docker compose up -d && \
sleep 15 && \
echo "=== STATUS ===" && \
docker ps --format 'table {{.Names}}\t{{.Status}}' && \
echo "" && \
echo "=== HEALTH ===" && \
curl -s http://localhost:3001/health && \
echo "" && \
echo "" && \
echo "=== DONE ===" && \
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):3001/"
```

---

## 🔧 פקודות שימושיות

```bash
# צפייה בלוגים
docker logs wa_orchestrator --tail 50 -f
docker logs wa_worker_1 --tail 50 -f

# restart כל המערכת
docker compose restart

# עצירה מלאה
docker compose down

# עדכון קוד והפעלה מחדש
git pull && docker compose build && docker compose up -d
```

---

## 🌐 URLs

| עמוד | כתובת |
|------|-------|
| Dashboard | `http://SERVER:3001/` |
| QR Scan | `http://SERVER:3001/scan` |
| Live Log | `http://SERVER:3001/live-log` |
| Anti-Ban | `http://SERVER:3001/anti-ban` |
| Warming | `http://SERVER:3001/warming` |
| Learning | `http://SERVER:3001/learning` |
| Health | `http://SERVER:3001/health` |

---

## ⚠️ Troubleshooting

### בעיה: Workers תקועים
```bash
docker exec wa_redis redis-cli KEYS "session:*:lock"
# אם יש locks - נקה אותם
docker exec wa_redis redis-cli DEL session:worker_1:lock session:worker_2:lock session:worker_3:lock
docker compose restart worker-1 worker-2 worker-3
```

### בעיה: Port 3001 תפוס
```bash
# מצא מה תופס את הפורט
lsof -i :3001
# או שנה את ORCH_PORT ב-.env
```

### בעיה: Redis לא מתחבר
```bash
docker logs wa_redis
docker exec wa_redis redis-cli ping
# צפוי: PONG
```

### בעיה: Proxy לא עובד
```bash
# בדוק חיבור proxy
curl --proxy socks5h://user:pass@proxy:port https://api.ipify.org
```

---

## ✅ Checklist לאחר פריסה

- [ ] `docker ps` - כל 5 הקונטיינרים רצים
- [ ] `curl localhost:3001/health` - מחזיר OK
- [ ] Dashboard נטען בדפדפן
- [ ] QR נסרק והסשן מתחבר
- [ ] הודעה נשלחת בהצלחה

---

**🎉 המערכת מוכנה לעבודה!**


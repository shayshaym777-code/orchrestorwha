# 📋 מדריך פריסה מהירה - Ubuntu Server

## 🎯 הנחות
- **IP השרת**: `130.94.113.40` (או החלף ב-IP שלך)
- **Workers**: 3 (worker_1, worker_2, worker_3)
- **Firewall**: UFW (אם יש)

---

## 1️⃣ התקנת Docker + Compose (פעם אחת)

```bash
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc > /dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update -y

sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker

# ✅ בדיקה
docker version && docker compose version
```

**תוצאה צפויה**: גרסאות Docker ו-Compose

---

## 2️⃣ פריסה מה-Repo

```bash
sudo mkdir -p /opt/whatsapp-orchestrator
sudo chown -R $USER:$USER /opt/whatsapp-orchestrator
cd /opt/whatsapp-orchestrator

git clone https://github.com/shayshaym777-code/orchrestorwha.git .
cp env.example .env
nano .env
```

---

## 3️⃣ העברת הסשנים (olssessions/)

**מהמחשב המקומי (Windows):**
```bash
scp -r ./olssessions user@130.94.113.40:/opt/whatsapp-orchestrator/olssessions
```

**בשרת - וידוא:**
```bash
ls -la /opt/whatsapp-orchestrator/olssessions | head
```

---

## 4️⃣ הגדרת `.env` (חובה!)

ראה `docs/ENV_TEMPLATE.md` לקובץ `.env` מומלץ.

**ערכים חובה:**
- `API_KEY` - מפתח API (32 תווים)
- `WEBHOOK_SECRET` - סיסמת Webhook (32 תווים)
- `PROXY_URL_1`, `PROXY_URL_2`, `PROXY_URL_3` - פרוקסים (socks5h://...)
- `ORCH_PORT=3001` - פורט האורקסטרטור

**אופציונלי (אם יש סשנים קיימים):**
- `WORKER_1_SESSION_ID=972508959715`
- `WORKER_2_SESSION_ID=972552905370`
- `WORKER_3_SESSION_ID=...`

---

## 5️⃣ הרצה

```bash
cd /opt/whatsapp-orchestrator
docker compose up -d --build
docker compose ps
```

---

## 6️⃣ פתיחת פורטים (UFW)

```bash
sudo ufw allow 3001/tcp  # Orchestrator
sudo ufw allow 6380/tcp  # Redis (אם צריך)
sudo ufw reload
sudo ufw status
```

---

## 7️⃣ בדיקות PASS/FAIL

### ✅ בדיקה 1: Health Checks
```bash
curl -s http://localhost:3001/health
```
**PASS**: `{"status":"ok"}`  
**FAIL**: שגיאה או timeout

### ✅ בדיקה 2: Redis
```bash
docker exec wa_redis redis-cli ping
```
**PASS**: `PONG`  
**FAIL**: שגיאה

### ✅ בדיקה 3: קונטיינרים רצים
```bash
docker compose ps
```
**PASS**: כל הקונטיינרים ב-`Up`  
**FAIL**: קונטיינרים ב-`Restarting` או `Exited`

### ✅ בדיקה 4: Workers שולחים QR
```bash
docker logs wa_worker_1 --tail 5 | grep -i "QR_UPDATE"
```
**PASS**: רואה `QR_UPDATE` או `WEBHOOK_QR_UPDATE`  
**FAIL**: אין QR או שגיאות

### ✅ בדיקה 5: API סשנים
```bash
curl -s -H "X-API-KEY: YOUR_API_KEY" http://localhost:3001/api/v1/dashboard/sessions | python3 -m json.tool | head -20
```
**PASS**: רואה רשימת סשנים  
**FAIL**: `401 Unauthorized` או שגיאה

### ✅ בדיקה 6: דף סריקה
```bash
curl -s http://localhost:3001/scan | head -10
```
**PASS**: רואה HTML של דף הסריקה  
**FAIL**: `404` או שגיאה

### ✅ בדיקה 7: גישה חיצונית
```bash
curl -s http://130.94.113.40:3001/health
```
**PASS**: `{"status":"ok"}`  
**FAIL**: timeout או connection refused (firewall)

---

## 8️⃣ בדיקות מתקדמות

### בדיקת סשנים ב-Redis
```bash
docker exec wa_redis redis-cli SMEMBERS sessions:active
```

### בדיקת פרוקסים במלאי
```bash
docker exec wa_redis redis-cli SCARD proxies:available
```

### בדיקת לוגים
```bash
docker logs wa_orchestrator --tail 20
docker logs wa_worker_1 --tail 20
```

---

## 🎯 סיכום

אם כל הבדיקות עוברות:
- ✅ השרת מוכן לשימוש
- ✅ גש ל-`http://130.94.113.40:3001/scan` לסריקת QR
- ✅ Workers מחכים לסריקה

אם יש בעיות:
- בדוק את הלוגים: `docker logs wa_orchestrator --tail 50`
- בדוק את ה-`.env`: `cat .env | grep -v "^#"`
- בדוק את ה-Firewall: `sudo ufw status`


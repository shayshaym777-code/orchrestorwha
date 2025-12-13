# 📋 שרת השליחות - איפיון מלא (Message Distribution)

---

## 🎯 מטרת השרת
שליחת הודעות WhatsApp בצורה בטוחה עם מנגנוני Anti-Ban:
- תורים פר-סשן
- Rate Limiting (מגבלת קצב)
- Jitter (אקראיות)
- Trust Levels (רמות אמון)
- Human-Like Behavior (התנהגות אנושית)

---

## 🏗️ עקרונות ליבה

### 1. תור לכל סשן
```
queue:session:972501234567 = [msg1, msg2, msg3...]
queue:session:972502222222 = [msg1, msg2...]
```
- כל סשן עם תור משלו
- הודעות מעובדות לפי סדר (FIFO)
- הודעות דחופות נכנסות להתחלה

### 2. Rate Limiting
```
Cold:  5 msg/min,  20 msg/day
Warm:  15 msg/min, 100 msg/day
Hot:   30 msg/min, 500 msg/day
```

### 3. Jitter (אקראיות)
```javascript
delay = baseDelay + (Math.random() * jitterRange);
// 3000 + (0-2000) = 3-5 שניות
```

---

## 📦 קומפוננטות

### Redis Keys
```
# תורי הודעות
queue:session:972501234567 = [msg1, msg2, ...]
queue:scheduled = SortedSet(timestamp → msg)

# Outbox (הודעה בעיבוד)
outbox:worker_1 = { messageId, to, text, timestamp }

# סטטיסטיקות
stats:session:worker_1:2024-01-15:sent = 45
stats:session:worker_1:2024-01-15:failed = 2

# Dead Letter Queue
queue:dead_letter = [failed_msg1, failed_msg2, ...]

# Trust Level
session:worker_1:trustLevel = "warm"
session:worker_1:createdAt = 1702500000000
```

---

## 🌡️ Trust Levels

| Level | גיל הסשן | הודעות/יום | הודעות/דקה | דיליי |
|-------|----------|------------|------------|-------|
| 🥶 Cold | 0-3 ימים | 20 | 5 | 5-8 שניות |
| 🌡️ Warm | 3-14 ימים | 100 | 15 | 3-5 שניות |
| 🔥 Hot | 14+ ימים | 500 | 30 | 2-4 שניות |

### חישוב Trust Level
```javascript
function getTrustLevel(sessionId) {
  const createdAt = redis.get(`session:${sessionId}:created`);
  const ageInDays = (Date.now() - createdAt) / (24 * 60 * 60 * 1000);
  
  if (ageInDays < 3) return 'cold';
  if (ageInDays < 14) return 'warm';
  return 'hot';
}
```

---

## 🔄 זרימות

### Flow 1: קבלת בקשת שליחה

```
POST /api/v1/send
{
  "to": "972509876543",
  "message": "שלום!",
  "sessionId": "worker_1",
  "priority": 1
}
```

**שלבים:**

1. **Validation**
   ```javascript
   // בדיקת API Key
   // בדיקת פורמט טלפון (to)
   // בדיקת אורך הודעה (< 4096)
   // בדיקת sessionId קיים ומחובר
   ```

2. **בדיקת מכסות**
   ```javascript
   const trustLevel = getTrustLevel(sessionId);
   const dailyLimit = LIMITS[trustLevel].daily;
   const todaySent = redis.get(`stats:session:${id}:${today}:sent`);
   
   if (todaySent >= dailyLimit) {
     return { error: "DAILY_LIMIT_REACHED" };
   }
   ```

3. **הוספה לתור**
   ```javascript
   const message = {
     id: generateId(),
     to: "972509876543",
     text: "שלום!",
     priority: 1,
     createdAt: Date.now(),
     attempts: 0
   };
   
   if (priority === 3) {
     redis.lpush(`queue:session:${phone}`, message);  // תחילת התור
   } else {
     redis.rpush(`queue:session:${phone}`, message);  // סוף התור
   }
   ```

4. **תשובה**
   ```javascript
   return {
     queued: true,
     messageId: message.id,
     position: queueSize + 1
   };
   ```

### Flow 2: עיבוד תור (Dispatcher)

```javascript
async function processQueue(sessionId, phone) {
  while (true) {
    // 1. חכה להודעה (blocking)
    const msg = await redis.blpop(`queue:session:${phone}`, 30);
    
    if (!msg) continue;
    
    // 2. בדוק שהסשן מחובר
    const status = redis.get(`session:${sessionId}:status`);
    if (status !== 'connected') {
      redis.lpush(`queue:session:${phone}`, msg);  // החזר לתור
      await sleep(5000);
      continue;
    }
    
    // 3. חישוב דיליי עם Jitter
    const trustLevel = getTrustLevel(sessionId);
    const baseDelay = DELAYS[trustLevel].base;
    const jitter = Math.random() * DELAYS[trustLevel].jitter;
    await sleep(baseDelay + jitter);
    
    // 4. שלח ל-Worker
    await sendToWorker(sessionId, msg);
  }
}
```

### Flow 3: שליחה בפועל (Worker)

```javascript
// Worker מקבל פקודת שליחה
app.post('/internal/send', async (req, res) => {
  const { to, text, messageId } = req.body;
  
  try {
    // 1. Typing indicator (התנהגות אנושית)
    await sock.sendPresenceUpdate('composing', to);
    await sleep(1000 + Math.random() * 2000);  // 1-3 שניות "מקליד"
    
    // 2. שליחת ההודעה
    const result = await sock.sendMessage(to, { text });
    
    // 3. דיווח הצלחה
    webhook('MESSAGE_SENT', {
      messageId,
      to,
      whatsappId: result.key.id
    });
    
  } catch (error) {
    // 4. דיווח כשלון
    webhook('MESSAGE_FAILED', {
      messageId,
      to,
      error: error.message
    });
  }
});
```

### Flow 4: טיפול בכשלון (Retry)

```javascript
case 'MESSAGE_FAILED':
  redis.incr(`stats:session:${id}:${today}:failed`);
  
  if (msg.attempts < 3) {
    // ניסיון חוזר
    msg.attempts++;
    redis.rpush(`queue:session:${phone}`, msg);
  } else {
    // העבר ל-Dead Letter Queue
    redis.rpush('queue:dead_letter', msg);
    telegram.send(`❌ Message failed after 3 attempts`);
  }
```

### Flow 5: שליחה מרובה (Batch)

```
POST /api/v1/send/batch
{
  "messages": [
    { "to": "972501111111", "text": "הודעה 1" },
    { "to": "972502222222", "text": "הודעה 2" },
    { "to": "972503333333", "text": "הודעה 3" }
  ],
  "sessionId": "worker_1",
  "spreadMinutes": 30
}
```

**עיבוד:**
```javascript
const delayBetween = (spreadMinutes * 60 * 1000) / messages.length;

for (let i = 0; i < messages.length; i++) {
  const msg = messages[i];
  msg.scheduledFor = Date.now() + (i * delayBetween);
  
  // הוסף לתור מתוזמן
  redis.zadd('queue:scheduled', msg.scheduledFor, JSON.stringify(msg));
}

return {
  queued: messages.length,
  estimatedCompletion: Date.now() + (spreadMinutes * 60000)
};
```

**Scheduler (כל 10 שניות):**
```javascript
setInterval(async () => {
  const now = Date.now();
  const ready = await redis.zrangebyscore('queue:scheduled', 0, now);
  
  for (const msgStr of ready) {
    const msg = JSON.parse(msgStr);
    redis.rpush(`queue:session:${msg.phone}`, msgStr);
    redis.zrem('queue:scheduled', msgStr);
  }
}, 10000);
```

---

## 📡 API Endpoints

### שליחה

| Method | Endpoint | תיאור |
|--------|----------|-------|
| POST | `/api/v1/send` | שליחת הודעה בודדת |
| POST | `/api/v1/send/batch` | שליחה מרובה |

### סטטוס

| Method | Endpoint | תיאור |
|--------|----------|-------|
| GET | `/api/v1/messages/:id/status` | סטטוס הודעה |
| GET | `/api/v1/queue/:sessionId` | צפייה בתור |
| DELETE | `/api/v1/queue/:sessionId/:messageId` | ביטול הודעה |

### סטטיסטיקות

| Method | Endpoint | תיאור |
|--------|----------|-------|
| GET | `/api/v1/stats/:sessionId` | סטטיסטיקות סשן |
| GET | `/api/v1/stats/daily` | סטטיסטיקות יומיות |

---

## 📊 Webhook Events

| Event | Data | תיאור |
|-------|------|-------|
| `MESSAGE_SENT` | `{messageId, to, whatsappId}` | נשלח בהצלחה |
| `MESSAGE_FAILED` | `{messageId, to, error}` | כשל בשליחה |
| `MESSAGE_DELIVERED` | `{messageId, to}` | הודעה הגיעה |
| `MESSAGE_READ` | `{messageId, to}` | הודעה נקראה |

---

## 🛡️ Anti-Ban Summary

| מנגנון | פירוט |
|--------|-------|
| Rate Limiting | מגבלת הודעות לדקה/יום לפי Trust Level |
| Jitter | דיליי אקראי בין הודעות |
| Typing | אינדיקטור "מקליד" לפני שליחה |
| Time Restrictions | אין שליחה 23:00-07:00 |
| Cool-Down | הפסקה של 30 דקות אם יש Rate Limit מ-WhatsApp |
| Retry Logic | 3 ניסיונות, אח"כ Dead Letter |

---

## ⚙️ Environment Variables

```bash
# Rate Limits
COLD_DAILY_LIMIT=20
COLD_RPM=5
WARM_DAILY_LIMIT=100
WARM_RPM=15
HOT_DAILY_LIMIT=500
HOT_RPM=30

# Delays (ms)
COLD_BASE_DELAY=5000
COLD_JITTER=3000
WARM_BASE_DELAY=3000
WARM_JITTER=2000
HOT_BASE_DELAY=2000
HOT_JITTER=2000

# Retry
MAX_RETRY_ATTEMPTS=3

# Time Restrictions
QUIET_HOURS_START=23
QUIET_HOURS_END=7
```

---

## 📁 מבנה קבצים

```
message-server/
├── src/
│   ├── services/
│   │   ├── dispatcherService.js    # תורים + Rate Limiting
│   │   ├── outboxService.js        # עיבוד Outbox
│   │   ├── schedulerService.js     # הודעות מתוזמנות
│   │   └── statsService.js         # סטטיסטיקות
│   │
│   ├── routes/
│   │   ├── sendRoutes.js           # POST /send, /send/batch
│   │   ├── queueRoutes.js          # GET/DELETE queue
│   │   └── statsRoutes.js          # GET stats
│   │
│   └── config/
│       └── rateLimits.js           # Trust Level configs
```


# 📋 מערכת 2: פיזור הודעות (Message Distribution)

---

## 🎯 מטרה
שליחת הודעות WhatsApp בצורה בטוחה עם מנגנוני Anti-Ban - תורים, rate limiting, ו-jitter.

---

## 🏗️ ארכיטקטורה

```
┌─────────────────────────────────────────────────────────────────┐
│                  MESSAGE DISTRIBUTION SYSTEM                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  [External API] ──► [Gateway] ──► [Dispatcher] ──► [Workers]    │
│                         │              │                         │
│                         ▼              ▼                         │
│                    ┌─────────────────────────┐                  │
│                    │         Redis           │                  │
│                    │  ┌───────────────────┐  │                  │
│                    │  │ queue:session:A   │  │                  │
│                    │  │ queue:session:B   │  │                  │
│                    │  │ queue:session:C   │  │                  │
│                    │  │ ...               │  │                  │
│                    │  └───────────────────┘  │                  │
│                    └─────────────────────────┘                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📦 קומפוננטות

### 1. Redis Keys (תורים והודעות)
```
# תור הודעות לכל סשן
queue:session:972501234567 = [
  { to: "972509999999", text: "הודעה 1", priority: 1 },
  { to: "972508888888", text: "הודעה 2", priority: 1 },
  ...
]

# Outbox (הודעות בעיבוד)
outbox:worker_1 = { messageId: "abc", to: "...", sentAt: null }

# סטטיסטיקות יומיות
stats:session:worker_1:2024-01-15:sent = 45
stats:session:worker_1:2024-01-15:failed = 2

# Trust Level
session:worker_1:trustLevel = "warm"
session:worker_1:createdAt = 1702500000000

# Rate Limits
ratelimit:session:worker_1:rpm = 15
ratelimit:session:worker_1:daily = 100
```

### 2. Trust Levels

| Level | גיל הסשן | הודעות/יום | הודעות/דקה |
|-------|----------|------------|------------|
| 🥶 Cold | 0-3 ימים | 20 | 5 |
| 🌡️ Warm | 3-14 ימים | 100 | 15 |
| 🔥 Hot | 14+ ימים | 500 | 30 |

---

## 🔄 זרימות

### Flow 1: קבלת בקשת שליחה

```
[External System] ─► POST /api/v1/send
{
  "to": "972509876543",
  "message": "שלום! זו הודעה",
  "sessionId": "worker_1",       // אופציונלי
  "phone": "972501234567",       // אופציונלי (במקום sessionId)
  "priority": 1                  // 1=רגיל, 2=גבוה, 3=דחוף
}
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ STEP 1: Validation                                          │
│ ─────────────────                                           │
│ • Validate API Key                                          │
│ • Validate phone format (to)                                │
│ • Validate message length (< 4096 chars)                    │
│ • Find sessionId if only phone provided                     │
└─────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ STEP 2: Check Limits                                        │
│ ───────────────────                                         │
│                                                             │
│ trustLevel = getTrustLevel(sessionId);                      │
│ dailyLimit = LIMITS[trustLevel].daily;                      │
│ todaySent = redis.get(`stats:session:${id}:${today}:sent`); │
│                                                             │
│ if (todaySent >= dailyLimit) {                              │
│   return { error: "DAILY_LIMIT_REACHED", limit: dailyLimit };│
│ }                                                           │
│                                                             │
│ queueSize = redis.llen(`queue:session:${phone}`);           │
│ if (queueSize > 1000) {                                     │
│   return { error: "QUEUE_FULL" };                           │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ STEP 3: Enqueue Message                                     │
│ ──────────────────────                                      │
│                                                             │
│ messageId = generateId();                                   │
│                                                             │
│ message = {                                                 │
│   id: messageId,                                            │
│   to: "972509876543",                                       │
│   text: "שלום! זו הודעה",                                  │
│   priority: 1,                                              │
│   createdAt: Date.now(),                                    │
│   attempts: 0                                               │
│ };                                                          │
│                                                             │
│ if (priority === 3) {  // דחוף                              │
│   redis.lpush(`queue:session:${phone}`, message);  // תחילת התור│
│ } else {                                                    │
│   redis.rpush(`queue:session:${phone}`, message);  // סוף התור│
│ }                                                           │
│                                                             │
│ return {                                                    │
│   queued: true,                                             │
│   messageId: messageId,                                     │
│   position: queueSize + 1,                                  │
│   estimatedDelivery: calculateETA(queueSize)                │
│ };                                                          │
└─────────────────────────────────────────────────────────────┘
```

### Flow 2: עיבוד תור (Dispatcher)

```
┌─────────────────────────────────────────────────────────────┐
│ DISPATCHER - Main Loop (per session)                        │
│ ────────────────────────────────────                        │
│                                                             │
│ async function processQueue(sessionId, phone) {             │
│   while (true) {                                            │
│     // 1. Wait for message (blocking)                       │
│     const msg = await redis.blpop(                          │
│       `queue:session:${phone}`,                             │
│       30  // timeout 30 seconds                             │
│     );                                                      │
│                                                             │
│     if (!msg) continue;  // timeout, check again            │
│                                                             │
│     // 2. Check session is connected                        │
│     const status = await redis.get(`session:${id}:status`); │
│     if (status !== 'connected') {                           │
│       // Return to queue                                    │
│       await redis.lpush(`queue:session:${phone}`, msg);     │
│       await sleep(5000);                                    │
│       continue;                                             │
│     }                                                       │
│                                                             │
│     // 3. Calculate delay (Anti-Ban)                        │
│     const baseDelay = 3000;  // 3 seconds                   │
│     const jitter = Math.random() * 2000;  // 0-2 seconds    │
│     const delay = baseDelay + jitter;                       │
│                                                             │
│     await sleep(delay);                                     │
│                                                             │
│     // 4. Send to Worker                                    │
│     await sendToWorker(sessionId, msg);                     │
│   }                                                         │
│ }                                                           │
└─────────────────────────────────────────────────────────────┘
```

### Flow 3: שליחה בפועל (Worker)

```
┌─────────────────────────────────────────────────────────────┐
│ WORKER - Receive Send Command                               │
│ ────────────────────────────                                │
│                                                             │
│ // Orchestrator sends via internal API or Redis             │
│ app.post('/internal/send', async (req, res) => {            │
│   const { to, text, messageId } = req.body;                 │
│                                                             │
│   try {                                                     │
│     // Add random typing delay (human-like)                 │
│     const typingDelay = 1000 + Math.random() * 2000;        │
│     await sock.sendPresenceUpdate('composing', to);         │
│     await sleep(typingDelay);                               │
│                                                             │
│     // Send message                                         │
│     const result = await sock.sendMessage(to, { text });    │
│                                                             │
│     // Report success                                       │
│     webhook('MESSAGE_SENT', {                               │
│       messageId,                                            │
│       to,                                                   │
│       whatsappId: result.key.id,                            │
│       timestamp: Date.now()                                 │
│     });                                                     │
│                                                             │
│   } catch (error) {                                         │
│     webhook('MESSAGE_FAILED', {                             │
│       messageId,                                            │
│       to,                                                   │
│       error: error.message                                  │
│     });                                                     │
│   }                                                         │
│ });                                                         │
└─────────────────────────────────────────────────────────────┘
```

### Flow 4: עדכון סטטוס הודעה

```
┌─────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR - Handle Message Status                        │
│ ───────────────────────────────────                         │
│                                                             │
│ // Success                                                  │
│ case 'MESSAGE_SENT':                                        │
│   redis.incr(`stats:session:${id}:${today}:sent`);          │
│   redis.hset(`message:${messageId}`, {                      │
│     status: 'sent',                                         │
│     whatsappId: data.whatsappId,                            │
│     sentAt: data.timestamp                                  │
│   });                                                       │
│   break;                                                    │
│                                                             │
│ // Failure                                                  │
│ case 'MESSAGE_FAILED':                                      │
│   redis.incr(`stats:session:${id}:${today}:failed`);        │
│                                                             │
│   // Check retry                                            │
│   if (msg.attempts < 3) {                                   │
│     msg.attempts++;                                         │
│     redis.rpush(`queue:session:${phone}`, msg);  // Retry   │
│   } else {                                                  │
│     // Move to dead letter queue                            │
│     redis.rpush('queue:dead_letter', msg);                  │
│     telegram.send(`❌ Message failed after 3 attempts`);    │
│   }                                                         │
│   break;                                                    │
└─────────────────────────────────────────────────────────────┘
```

### Flow 5: שליחה מרובה (Batch)

```
[External System] ─► POST /api/v1/send/batch
{
  "messages": [
    { "to": "972501111111", "text": "הודעה 1" },
    { "to": "972502222222", "text": "הודעה 2" },
    { "to": "972503333333", "text": "הודעה 3" }
  ],
  "sessionId": "worker_1",
  "spreadMinutes": 30  // לפזר על פני 30 דקות
}
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│ BATCH PROCESSING                                            │
│ ────────────────                                            │
│                                                             │
│ const delayBetween = (spreadMinutes * 60 * 1000)            │
│                      / messages.length;                     │
│                                                             │
│ for (let i = 0; i < messages.length; i++) {                 │
│   const msg = messages[i];                                  │
│   msg.scheduledFor = Date.now() + (i * delayBetween);       │
│                                                             │
│   // Add to scheduled queue                                 │
│   redis.zadd('queue:scheduled', msg.scheduledFor, msg);     │
│ }                                                           │
│                                                             │
│ return {                                                    │
│   queued: messages.length,                                  │
│   estimatedCompletion: Date.now() + (spreadMinutes * 60000) │
│ };                                                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ SCHEDULER - Process Scheduled Messages                      │
│ ─────────────────────────────────────                       │
│                                                             │
│ // Every 10 seconds                                         │
│ setInterval(async () => {                                   │
│   const now = Date.now();                                   │
│   const ready = await redis.zrangebyscore(                  │
│     'queue:scheduled', 0, now                               │
│   );                                                        │
│                                                             │
│   for (const msg of ready) {                                │
│     // Move to session queue                                │
│     redis.rpush(`queue:session:${msg.phone}`, msg);         │
│     redis.zrem('queue:scheduled', msg);                     │
│   }                                                         │
│ }, 10000);                                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 📡 API Endpoints

| Method | Endpoint | תיאור |
|--------|----------|-------|
| POST | `/api/v1/send` | שליחת הודעה בודדת |
| POST | `/api/v1/send/batch` | שליחה מרובה |
| GET | `/api/v1/messages/:id/status` | סטטוס הודעה |
| GET | `/api/v1/queue/:sessionId` | צפייה בתור |
| DELETE | `/api/v1/queue/:sessionId/:messageId` | ביטול הודעה |
| GET | `/api/v1/stats/:sessionId` | סטטיסטיקות שליחה |

---

## 🛡️ Anti-Ban Mechanisms

### 1. Rate Limiting
```javascript
// Per Session
const RATE_LIMITS = {
  cold:  { rpm: 5,  daily: 20  },
  warm:  { rpm: 15, daily: 100 },
  hot:   { rpm: 30, daily: 500 }
};
```

### 2. Jitter (אקראיות)
```javascript
// Base delay + random jitter
const delay = 3000 + Math.random() * 2000;  // 3-5 seconds
```

### 3. Human-Like Behavior
```javascript
// Typing indicator before sending
await sock.sendPresenceUpdate('composing', to);
await sleep(1000 + Math.random() * 2000);  // 1-3 seconds "typing"
await sock.sendMessage(to, { text });
```

### 4. Time-Based Restrictions
```javascript
// No sending between 23:00-07:00
const hour = new Date().getHours();
if (hour >= 23 || hour < 7) {
  // Schedule for 07:00
  scheduleFor = getNext7AM();
}
```

### 5. Cool-Down After Errors
```javascript
// If rate limit hit, pause session
if (error.code === 'RATE_LIMIT') {
  await pauseSession(sessionId, 30 * 60 * 1000);  // 30 minutes
  telegram.send(`⚠️ Session ${sessionId} paused for rate limit`);
}
```

---

## 📊 Webhook Events (Worker → Orchestrator)

| Event | Data | תיאור |
|-------|------|-------|
| `MESSAGE_SENT` | `{messageId, to, whatsappId}` | נשלח בהצלחה |
| `MESSAGE_FAILED` | `{messageId, to, error}` | נכשל |
| `MESSAGE_DELIVERED` | `{messageId, to}` | הגיע ליעד |
| `MESSAGE_READ` | `{messageId, to}` | נקרא |

---

## 📈 סטטיסטיקות

```javascript
// Daily stats per session
{
  "sessionId": "worker_1",
  "date": "2024-01-15",
  "sent": 87,
  "failed": 3,
  "delivered": 82,
  "read": 45,
  "avgDeliveryTime": 2300,  // ms
  "queueSize": 12
}
```


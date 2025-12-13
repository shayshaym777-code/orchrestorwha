# 🛡️ Anti‑Ban Server (Dispatcher) — Full Specification

מסמך זה הוא **האיפיון המלא** של שרת האנטי‑באן במערכת: **Dispatcher**.  
ה‑Dispatcher הוא ה”מוח” שמבצע **Anti‑Ban pacing**, **ניהול תורים פר‑סשן**, **Sticky routing** והזרקת משימות ל‑Orchestrator בצורה מבוקרת.

---

## 🎯 מטרות

- **עבודה 24/7**: תהליך שרץ תמיד, מתאושש, עם retry/backoff.
- **בידוד סשנים**: כל סשן WhatsApp מקבל תור משלו כדי לא לחסום את כולם.
- **Anti‑Ban pacing**: שליטה בקצב (RPM), jitter, burst protection.
- **SmartGuard**: כוונון אוטומטי של RPM לפי תקלות/מדדים (Best‑effort).
- **תצפית**: API למטריקות/סטטוס לדשבורדים.
- **שילוב AI (Session Brain)**: שליחת אירועים ל־Session Brain (אופציונלי) לניתוח/למידה.

---

## ✅ גבולות אחריות (Separation of Concerns)

- **Dispatcher (Anti‑Ban Server)** אחראי על:
  - צריכת Jobs מה‑Gateway (`gateway:jobs`)
  - פירוק job לתתי‑משימות (task per contact)
  - בחירת סשן יעד (Sticky routing ברירת מחדל)
  - כתיבה לתור פר‑סשן: `queue:session:<phone>`
  - צריכת תורים פר‑סשן + pacing (RPM/jitter/burst)
  - “Handoff” ל‑Orchestrator (enqueue outbox / או Redis outbox)
  - Logging של incidents ל‑`antiban:incidents` + SmartGuard
  - API פנימי לסטטוס/שליטה (rpm override, smartguard, metrics)

- **Orchestrator (Docker Server)** אחראי על:
  - ניהול סשנים, Workers, Proxy pool, Sticky IP phone→proxy
  - Webhook ingestion מה‑Workers (QR/CONNECTED/DISCONNECTED)
  - Outbox queues (`session:outbox:<sessionId>`) + claim/ack/nack

- **Gateway** אחראי על:
  - API ציבורי קפדני לפי `GATEWAY_SPEC.md`
  - אימות/Rate limiting/Idempotency
  - יצירת `job:<jobId>` + דחיפת `jobId` ל‑`gateway:jobs`
  - אירוע `JOB_ACCEPTED` ל‑`jobs:events`

---

## 🧱 ארכיטקטורה (High‑Level Flow)

### 1) Job Intake (Gateway → Redis)
- הלקוח שולח `POST /v1/jobs` ל‑Gateway.
- ה‑Gateway שומר:
  - `SET job:<jobId> = {...payload...}`
  - `LPUSH gateway:jobs <jobId>`
  - `LPUSH jobs:events {"type":"JOB_ACCEPTED",...}`

### 2) Routing (Dispatcher)
- Dispatcher לוקח jobId מ‑`gateway:jobs` (או `queue:priority`).
- קורא `job:<jobId>` ומוודא מינימום שדות.
- מפצל לכל Contact משימה `task` (עם `taskId = <jobId>:<i>`).
- בוחר סשן ל־Contact בעזרת Router (sticky).
- דוחף לתור היעד של אותו phone:
  - `LPUSH queue:session:<sessionPhone> <taskJson>`
  - `EXPIRE queue:session:<...> 86400`
- שומר `job:stats:*` (total/sent/failed) כדי לאפשר JOB_DONE.

### 3) Per‑Session Consumer + Pacing (Dispatcher)
לכל סשן CONNECTED (מ‑Orchestrator) Dispatcher מריץ consumer:
- `BRPOP queue:session:<phone>` (Redis blocking connection)
- לפני שליחה: `SessionPacer.waitForSlot()`  
  (RPM/Delay windows + jitter + burst cooldown)
- handoff: `sendViaOrchestrator(sessionId, payload)`
  - `SEND_MODE=api`: `POST /api/sessions/:id/outbox/enqueue`
  - `SEND_MODE=redis`: `LPUSH session:outbox:<sessionId>`
- success:
  - `INCR metrics:session:<id>:sent60s` (TTL 60s)
  - עדכון job counters `job:stats:<jobId>:sent`
- fail:
  - retry עד `MAX_RETRIES`, אחרת mark failed
  - `LPUSH antiban:incidents {type:SEND_FAILED,...}`
  - `INCR metrics:session:<id>:failed60s` (TTL 60s)
  - best‑effort: שליחת event ל‑Session Brain

### 4) Job Finalization (Dispatcher)
ברגע ש‑`sent + failed == total`:
- “ננעל” עם `SET job:stats:<jobId>:doneEmitted NX`
- מעדכן `job:<jobId>.status` ל‑`DONE` / `DONE_WITH_ERRORS`
- `LPUSH jobs:events {"type":"JOB_DONE",...}`

---

## 🔌 קונפיגורציה (ENV)

מקור: `messaging-plane/dispatcher/src/server.js` + `env.example`.

### בסיס
- **PORT**: ברירת מחדל `4001`
- **REDIS_URL**: לדוגמה `redis://127.0.0.1:6380`

### חיבור ל‑Orchestrator
- **ORCHESTRATOR_URL**: ברירת מחדל `http://localhost:3000`
- **ORCHESTRATOR_API_KEY**: חובה אם Orchestrator דורש API key
- **SEND_MODE**:
  - `api` (מומלץ): enqueue דרך HTTP
  - `redis`: כתיבה ישירה ל‑Redis outbox (רק אם Redis משותף)

### תורים
- **GATEWAY_QUEUE_KEY**: ברירת מחדל `gateway:jobs`
- **PRIORITY_QUEUE_KEY**: ברירת מחדל `queue:priority`
- **SESSION_QUEUE_PREFIX**: ברירת מחדל `queue:session:`

### pacing / anti‑ban
- **DEFAULT_MIN_DELAY_MS**: ברירת מחדל `2000`
- **DEFAULT_MAX_DELAY_MS**: ברירת מחדל `5000`
- **BURST_LIMIT**: ברירת מחדל `5`
- **BURST_COOLDOWN_MS**: ברירת מחדל `30000`

### processing
- **POLL_INTERVAL_MS**: ברירת מחדל `1000`
- **MAX_CONCURRENT_JOBS**: ברירת מחדל `10` (נכון להיום הלולאה היא single‑poll, לא pool אמיתי)

### retry
- **MAX_RETRIES**: ברירת מחדל `3`
- **RETRY_DELAY_MS**: ברירת מחדל `60000` (מוגבל בקוד ל־1s..10m)

### SmartGuard
- **SMART_GUARD_ENABLED**: ברירת מחדל `true`
- **SMART_GUARD_TICK_MS**: ברירת מחדל `10000`

### Session Brain (אופציונלי)
- **SESSION_BRAIN_URL**: אם מוגדר, Dispatcher שולח `POST <url>/event`

### TTL
- **JOB_STATS_TTL_SECONDS**: ברירת מחדל `86400` (24h)

---

## 🗄️ Redis Data Model (Keys)

### תורים
- **`gateway:jobs`** (LIST): jobIds מה‑Gateway
- **`queue:priority`** (LIST): אופציונלי
- **`queue:retry`** (ZSET): jobIds שנדחו בגלל “NO_SESSIONS”
- **`queue:session:<phone>`** (LIST): משימות פר‑סשן (היעד נקבע לפי session.phone מה‑Orchestrator)
- **`queue:retry:session`** (ZSET): retry של משימות פר‑סשן (כ־JSON של `{sessionId, phone, task}`)

### סטטוס Job (נכתב ע״י Gateway + Dispatcher)
- **`job:<jobId>`** (STRING/JSON): payload + סטטוס (`QUEUED/ROUTING/ROUTED/DONE/...`)
- **`job:stats:<jobId>:total`** (STRING)
- **`job:stats:<jobId>:sent`** (STRING)
- **`job:stats:<jobId>:failed`** (STRING)
- **`job:stats:<jobId>:doneEmitted`** (STRING, NX guard)
- **`job:taskStatus:<taskId>`** (STRING): `SENT` / `FAILED` (NX guard)

### מטריקות פר סשן (rolling 60s)
- **`metrics:session:<sessionId>:sent60s`** (STRING, TTL 60)
- **`metrics:session:<sessionId>:routed60s`** (STRING, TTL 60)
- **`metrics:session:<sessionId>:failed60s`** (STRING, TTL 60)

### קונפיג runtime
- **`config:session:<sessionId>:rpm`** (STRING): override RPM (manual או SmartGuard)
- **`config:smartguard:enabled`** (STRING `"true"/"false"`)
- **`smartguard:lastTick`**, **`smartguard:lastActionAt`** (STRING timestamps)

### אירועים/למידה
- **`antiban:incidents`** (LIST of JSON): last 200, TTL 7 days
- **`jobs:events`** (LIST of JSON): last 2000 (Gateway + Dispatcher)

---

## 🧭 Routing / Sticky Logic

מקור: `messaging-plane/dispatcher/src/router.js`

### default
- strategy ברירת מחדל הוא `HEALTH_BASED` בקוד, אבל בפועל `routeGatewayJob` קורא:
  - `selectSession(sessions, routingJob, { strategy: "sticky" })`

### Sticky behavior
- מפתח sticky הוא **recipient (היעד `to`)**.
- TTL: **24h** (`STICKY_TTL_MS`).
- אם session שנבחר כבר לא זמין/בריא → נבחר חדש (least_loaded) ונוצר mapping חדש.

> חשוב: sticky כאן הוא “שיחה/יעד → סשן שולח”. זה **לא** Sticky IP (phone→proxy) שנמצא ב‑Orchestrator.

---

## ⏱️ Pacing (RPM / Jitter / Burst)

מקור: `messaging-plane/dispatcher/src/pacer.js`

### מצבים
- **Delay‑mode**: משתמש ב־`minDelayMs..maxDelayMs` + jitter.
- **RPM‑mode**: אם מוגדר `rpm`, נגזר חלון:
  - \(baseInterval = 60000 / rpm\)
  - `minDelay = 0.8 * baseInterval`
  - `maxDelay = 1.2 * baseInterval`
  - ואז jitter ±20% על ההשהיה.

### Burst protection
- אחרי `BURST_LIMIT` הודעות, נכנסים ל־cooldown של `BURST_COOLDOWN_MS` + random 1–3s.

### Trust policy (ברירת מחדל בקוד Dispatcher)
מבוסס `createdAt` של session מה‑Orchestrator:
- `<3 ימים`: rpm=3, delay 20–40s
- `<7 ימים`: rpm=5, delay 10–15s
- `<14 ימים`: rpm=10, delay 5–8s
- `>=14 ימים`: rpm=20, delay 2–4s

### Override RPM
אם קיים `config:session:<sessionId>:rpm`:
- ה‑consumer עושה `pacer.setRpm(override)`
- ברגע שמסירים override (rpm=null), חוזרים לחלון delay לפי trust policy.

---

## 🧠 SmartGuard (Auto‑Tuning)

מקור: `messaging-plane/dispatcher/src/server.js`

### מטרות
- אם יש spike של failures → **להוריד RPM**
- אם אין failures, backlog נמוך ויש activity → **להעלות RPM** (עד תקרת trust base)

### לוגיקה (כל `SMART_GUARD_TICK_MS`)
עבור כל session CONNECTED:
- קורא:
  - `LLEN queue:session:<phone>` (backlog)
  - `sent60s`, `routed60s`, `failed60s`
  - override RPM אם קיים
  - base RPM לפי trust policy
- החלטות:
  - `failed60s >= 3` → `lowerRpm(current)` (לדרג 20→15→10→5)
  - `failed60s == 0 && qlen <= 2 && sent60s > 0` → `higherRpm(current)` (5→10→15→20)
  - לעולם לא עוברים מעל base trust rpm.
- פעולה:
  - `SET config:session:<id>:rpm next`
  - `LPUSH antiban:incidents {type:"SMART_GUARD_RPM_CHANGE",...}`

### הפעלה/כיבוי
`config:smartguard:enabled` נשמר ב‑Redis, וניתן לשלוט דרך API (ראה בהמשך).

---

## 🤝 אינטגרציה עם Session Brain (AI)

אם `SESSION_BRAIN_URL` מוגדר:
- Dispatcher שולח best‑effort `POST <SESSION_BRAIN_URL>/event`
- בעיקר על:
  - `SEND_FAILED`
  - `SESSION_CONSUMER_ERROR`

**ה‑Dispatcher לא “מבצע חסימות” בעצמו**. החלטות enforcer (למשל burn proxy / migrate session) הן תפקיד Orchestrator.

---

## 🌐 API של Dispatcher (HTTP)

Base URL: `http://<dispatcher-host>:4001`

> הערה: כרגע אין API‑KEY על Dispatcher עצמו; ההגנה נעשית בדרך כלל ע״י רשת פנימית/VPN/Firewall.

### GET `/health`
מחזיר סטטוס בסיסי ומונים:
- `running`, `processed`, `routed`, `failed`, `activePacers`

### POST `/start`
מפעיל:
- main process loop (routing jobs)
- consumers פר‑סשן + session retry loop
- smartguard timer

### POST `/stop`
עוצר:
- processing loop
- consumers + smartguard

### GET `/queue/status`
מחזיר lengths:
- gateway, priority, retry, sessionRetry, total

### GET `/pacers`
רשימת pacers + stats (`avgDelayMs`, `burstCount`, וכו׳)

### POST `/pacers/:sessionId`
עדכון pacer config (debug/admin):
Body: `{ minDelayMs?, maxDelayMs?, burstLimit?, burstCooldownMs?, rpm? }`

### POST `/sessions/:sessionId/rpm`
Override RPM פר‑סשן:
- Body: `{ rpm: 2|3|5|10|15|20|null }`
- `rpm=null` מנקה override.
- כותב `config:session:<id>:rpm`

### GET `/sessions/metrics`
רשימת sessions CONNECTED +:
- `queueLen`, `sentLast60s`, `routedLast60s`, `failedLast60s`, `trustLevel`, `rpmDefault`, `rpmOverride`

### GET `/smartguard/status`
מחזיר:
- enabled, tickMs, lastTick, lastActionAt

### POST `/smartguard/enable`
Body: `{ enabled: true|false }`
- `SET config:smartguard:enabled`
- `LPUSH antiban:incidents {type:"SMART_GUARD_TOGGLE"}`

---

## ✅ “RPM per minute” (הדרישה שלך)

ה‑Dispatcher יכול:
- לקבל jobs, להפוך אותם למשימות ולפזר לתורים,
- ולהחיל **RPM פר סשן** דרך:
  - Trust policy (אוטומטי)
  - Override ידני: `/sessions/:id/rpm`
  - SmartGuard (אוטומטי‑לפי‑תקלות)

> הערכים הנתמכים כרגע ל‑override ב‑API: **2, 3, 5, 10, 15, 20** (וב‑SmartGuard הוא מתכנס ל‑5/10/15/20).

---

## 🧪 התנהגות במקרה כשל

### אין סשנים זמינים
- job נשאר `QUEUED` עם `lastError=NO_SESSIONS_AVAILABLE`
- `ZADD queue:retry <nextRetryAt> <jobId>`
- `processRetryQueue` מחזיר אותו ל‑`gateway:jobs` כשמגיע הזמן.

### כשל enqueue ל‑Orchestrator (sendViaOrchestrator)
- retry ברמת task:
  - `ZADD queue:retry:session <nextRetryAt> <json>`
  - עד `MAX_RETRIES`, ואז FAILED
- incident: `SEND_FAILED`

---

## 🔐 אבטחה והקשחה (מומלץ בייצור)

- **לא לחשוף את Dispatcher לאינטרנט**. לשים אותו ברשת פרטית.
- להגביל גישה ל־HTTP endpoints (firewall / security group).
- להשתמש ב‑TLS/VPN אם cross‑VPS.
- לוגים/Redis: להגן בסיסמא/ACLs.

---

## 🧩 נקודות הרחבה (Roadmap מוכוון “Robust”)

- **Auth ל‑Dispatcher API** (X‑API‑KEY / mTLS)
- **Global limiter** אמיתי (קיים class אבל לא משולב)
- **Concurrency**: worker pool ל‑routing jobs (כיום polling single loop)
- **Persisted sticky** ב‑Redis במקום Map בזיכרון (כדי לשרוד restart)
- **SLO metrics**: latency per stage, per session error ratios

---

## 🔗 קבצי מקור רלוונטיים

- `messaging-plane/dispatcher/src/server.js` — הליבה: routing, consumers, retries, API, smartguard, incidents
- `messaging-plane/dispatcher/src/pacer.js` — pacing/jitter/burst/rpm
- `messaging-plane/dispatcher/src/router.js` — sticky/health-based selection
- `messaging-plane/dispatcher/env.example` — תצורת ENV
- `GATEWAY_SPEC.md` — איפיון intake ציבורי
- `docs/ARCHITECTURE.md` — ארכיטקטורת מערכת כללית






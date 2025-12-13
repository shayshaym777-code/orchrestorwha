# 📚 אפיון מלא - WhatsApp Orchestrator System

---

## 🎯 מטרת המערכת
מערכת לניהול עשרות/מאות חשבונות WhatsApp בו-זמנית, עם בידוד מלא, אנטי-באן, וניהול מרכזי.

---

## 🏗️ דיאגרמת ארכיטקטורה מלאה

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              WHATSAPP ORCHESTRATOR                               │
│                                   (VPS/Cloud)                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                         DOCKER COMPOSE STACK                             │   │
│   │                     Network: 172.28.0.0/16                               │   │
│   ├─────────────────────────────────────────────────────────────────────────┤   │
│   │                                                                          │   │
│   │  ┌─────────────┐     ┌─────────────────────────────────────────────┐    │   │
│   │  │             │     │           ORCHESTRATOR (172.28.0.3)          │    │   │
│   │  │    REDIS    │     │  ┌─────────────────────────────────────┐    │    │   │
│   │  │ (172.28.0.2)│     │  │            Express Server            │    │    │   │
│   │  │             │◄────┤  │              Port 3000               │    │    │   │
│   │  │  ┌───────┐  │     │  └─────────────────────────────────────┘    │    │   │
│   │  │  │Sessions│  │     │                    │                        │    │   │
│   │  │  │Queues │  │     │  ┌─────────────────┼─────────────────┐      │    │   │
│   │  │  │Locks  │  │     │  │                 │                 │      │    │   │
│   │  │  │Stats  │  │     │  ▼                 ▼                 ▼      │    │   │
│   │  │  └───────┘  │     │ ┌────────┐  ┌──────────┐  ┌──────────┐     │    │   │
│   │  │             │     │ │Session │  │Dispatcher│  │ Watchdog │     │    │   │
│   │  │   Port 6379 │     │ │Service │  │(Anti-Ban)│  │ Service  │     │    │   │
│   │  └─────────────┘     │ └────────┘  └──────────┘  └──────────┘     │    │   │
│   │                       │      │            │             │          │    │   │
│   │                       │      │            │             │          │    │   │
│   │                       │      └────────────┼─────────────┘          │    │   │
│   │                       │                   │                        │    │   │
│   │                       │                   ▼                        │    │   │
│   │                       │         ┌─────────────────┐                │    │   │
│   │                       │         │  Runner Service │                │    │   │
│   │                       │         │ (Docker Control)│                │    │   │
│   │                       │         └────────┬────────┘                │    │   │
│   │                       └──────────────────┼─────────────────────────┘    │   │
│   │                                          │                              │   │
│   │                                          │ docker run / stop            │   │
│   │                                          ▼                              │   │
│   │  ┌──────────────────────────────────────────────────────────────────┐  │   │
│   │  │                         WORKERS (Dynamic)                         │  │   │
│   │  │                                                                   │  │   │
│   │  │   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐            │  │   │
│   │  │   │  Worker 1   │   │  Worker 2   │   │  Worker 3   │   ...      │  │   │
│   │  │   │ 172.28.0.10 │   │ 172.28.0.11 │   │ 172.28.0.12 │            │  │   │
│   │  │   │             │   │             │   │             │            │  │   │
│   │  │   │ ┌─────────┐ │   │ ┌─────────┐ │   │ ┌─────────┐ │            │  │   │
│   │  │   │ │ Baileys │ │   │ │ Baileys │ │   │ │ Baileys │ │            │  │   │
│   │  │   │ └────┬────┘ │   │ └────┬────┘ │   │ └────┬────┘ │            │  │   │
│   │  │   │      │      │   │      │      │   │      │      │            │  │   │
│   │  │   │      ▼      │   │      ▼      │   │      ▼      │            │  │   │
│   │  │   │  ┌──────┐   │   │  ┌──────┐   │   │  ┌──────┐   │            │  │   │
│   │  │   │  │Proxy │   │   │  │Proxy │   │   │  │Proxy │   │            │  │   │
│   │  │   │  │  A   │   │   │  │  B   │   │   │  │  A   │   │            │  │   │
│   │  │   │  └──┬───┘   │   │  └──┬───┘   │   │  └──┬───┘   │            │  │   │
│   │  │   └─────┼───────┘   └─────┼───────┘   └─────┼───────┘            │  │   │
│   │  │         │                 │                 │                    │  │   │
│   │  └─────────┼─────────────────┼─────────────────┼────────────────────┘  │   │
│   │            │                 │                 │                       │   │
│   └────────────┼─────────────────┼─────────────────┼───────────────────────┘   │
│                │                 │                 │                           │
│                └────────────┬────┴────────────────┘                           │
│                             │                                                  │
│                             ▼                                                  │
│                    ┌─────────────────┐                                        │
│                    │  PROXY POOL     │                                        │
│                    │  ┌───────────┐  │                                        │
│                    │  │ Proxy A   │◄─┼── Phone 1, Phone 3 (Sticky)            │
│                    │  │ Proxy B   │◄─┼── Phone 2 (Sticky)                     │
│                    │  │ Proxy C   │◄─┼── (Available)                          │
│                    │  │ Proxy D   │◄─┼── Phone 4, Phone 5, Phone 6 (Sticky)   │
│                    │  └───────────┘  │                                        │
│                    │  Max 4 per proxy│                                        │
│                    └────────┬────────┘                                        │
│                             │                                                  │
└─────────────────────────────┼──────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │    WhatsApp     │
                    │    Servers      │
                    │    (Meta)       │
                    └─────────────────┘
```

---

## 📊 תרשים זרימה - יצירת סשן חדש

```
                                    START
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │ POST /api/sessions/   │
                          │     provision         │
                          │ {phone?, proxy?}      │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   Proxy Provided?     │
                          └───────────┬───────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    │ YES             │                 │ NO
                    ▼                 │                 ▼
          ┌─────────────────┐         │       ┌─────────────────┐
          │ Validate Proxy  │         │       │ Check Sticky    │
          │ Format (socks5h)│         │       │ phone→proxy     │
          └────────┬────────┘         │       └────────┬────────┘
                   │                  │                │
                   │                  │          ┌─────┴─────┐
                   │                  │          │           │
                   │                  │    EXISTS│           │NOT EXISTS
                   │                  │          ▼           ▼
                   │                  │  ┌────────────┐ ┌────────────┐
                   │                  │  │Use Existing│ │Select From │
                   │                  │  │  Proxy     │ │   Pool     │
                   │                  │  └─────┬──────┘ │(capacity<4)│
                   │                  │        │        └─────┬──────┘
                   │                  │        │              │
                   └──────────────────┴────────┴──────────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  Generate sessionId   │
                          │  "worker_" + nextId() │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   Save to Redis:      │
                          │ • session:X:status    │
                          │ • session:X:proxy     │
                          │ • session:X:created   │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   docker run          │
                          │   --name wa_session_X │
                          │   -e SESSION_ID=X     │
                          │   -e PROXY_URL=...    │
                          │   -e WEBHOOK_URL=...  │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   Worker Starts       │
                          │   Connects to WA      │
                          │   via Proxy           │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   QR Generated        │
                          │   Webhook → Orch      │
                          │   {type: QR_CODE}     │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   User Scans QR       │
                          │   on Phone            │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   CONNECTED!          │
                          │   Webhook → Orch      │
                          │   {type: CONNECTED,   │
                          │    phoneNumber: ...}  │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   Create Sticky:      │
                          │   phone → proxy       │
                          │   phone → session     │
                          └───────────┬───────────┘
                                      │
                                      ▼
                                    END ✅
```

---

## 📊 תרשים זרימה - שליחת הודעה

```
                                    START
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  POST /api/v1/send    │
                          │  {to, message,        │
                          │   sessionId}          │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │   Validate Request    │
                          │   • API Key           │
                          │   • Phone format      │
                          │   • Message length    │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  Get Trust Level      │
                          │  Cold/Warm/Hot        │
                          └───────────┬───────────┘
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  Check Daily Limit    │
                          │  sent < limit?        │
                          └───────────┬───────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │ YES                               │ NO
                    ▼                                   ▼
          ┌─────────────────┐                 ┌─────────────────┐
          │ Add to Queue    │                 │ Return Error:   │
          │ queue:session:X │                 │ DAILY_LIMIT     │
          └────────┬────────┘                 └─────────────────┘
                   │
                   ▼
          ┌─────────────────┐
          │ Return:         │
          │ {queued: true,  │
          │  messageId: X}  │
          └────────┬────────┘
                   │
                   │ (Async - Dispatcher)
                   ▼
          ┌─────────────────┐
          │ Dispatcher Loop │
          │ Wait for msg    │
          │ from queue      │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │ Session         │
          │ Connected?      │
          └────────┬────────┘
                   │
         ┌─────────┴─────────┐
         │ NO                │ YES
         ▼                   ▼
  ┌─────────────┐   ┌─────────────────┐
  │Return to    │   │ Calculate Delay │
  │Queue + Wait │   │ 3-5 sec (jitter)│
  └─────────────┘   └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Send to Worker  │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Worker:         │
                    │ 1. Typing...    │
                    │ 2. sendMessage  │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Webhook:        │
                    │ MESSAGE_SENT or │
                    │ MESSAGE_FAILED  │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Update Stats    │
                    │ sent++ / failed++│
                    └────────┬────────┘
                             │
                             ▼
                           END ✅
```

---

## 📊 תרשים - Proxy Sticky IP

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PROXY STICKY IP SYSTEM                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   PHONE NUMBERS              STICKY BINDING              PROXY POOL      │
│   ─────────────              ──────────────              ──────────      │
│                                                                          │
│   ┌─────────────┐                                    ┌─────────────┐    │
│   │ 972501111111│─────────────────────────────────►  │  PROXY A    │    │
│   └─────────────┘            phone:972501111111      │  Sessions:  │    │
│                              :proxy = A              │  ┌───┬───┐  │    │
│   ┌─────────────┐                                    │  │ 1 │ 3 │  │    │
│   │ 972503333333│─────────────────────────────────►  │  └───┴───┘  │    │
│   └─────────────┘            phone:972503333333      │  Count: 2   │    │
│                              :proxy = A              └─────────────┘    │
│                                                                          │
│   ┌─────────────┐                                    ┌─────────────┐    │
│   │ 972502222222│─────────────────────────────────►  │  PROXY B    │    │
│   └─────────────┘            phone:972502222222      │  Sessions:  │    │
│                              :proxy = B              │  ┌───┐      │    │
│                                                      │  │ 2 │      │    │
│                                                      │  └───┘      │    │
│                                                      │  Count: 1   │    │
│                                                      └─────────────┘    │
│                                                                          │
│   ┌─────────────┐                                    ┌─────────────┐    │
│   │ 972504444444│─────────────────────────────────►  │  PROXY C    │    │
│   └─────────────┘            phone:972504444444      │  Sessions:  │    │
│   ┌─────────────┐            :proxy = C              │  ┌───┬───┐  │    │
│   │ 972505555555│─────────────────────────────────►  │  │ 4 │ 5 │  │    │
│   └─────────────┘            phone:972505555555      │  ├───┼───┤  │    │
│   ┌─────────────┐            :proxy = C              │  │ 6 │ 7 │  │    │
│   │ 972506666666│─────────────────────────────────►  │  └───┴───┘  │    │
│   └─────────────┘            phone:972506666666      │  Count: 4   │    │
│   ┌─────────────┐            :proxy = C              │  ⚠️ FULL!   │    │
│   │ 972507777777│─────────────────────────────────►  └─────────────┘    │
│   └─────────────┘            phone:972507777777                          │
│                              :proxy = C                                  │
│                                                                          │
│   ┌─────────────┐                                    ┌─────────────┐    │
│   │ 972508888888│───────────── NEW ─────────────────►│  PROXY D    │    │
│   └─────────────┘         (C is full,                │  Sessions:  │    │
│                            select D)                 │  ┌───┐      │    │
│                                                      │  │ 8 │      │    │
│                                                      │  └───┘      │    │
│                                                      │  Count: 1   │    │
│                                                      └─────────────┘    │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                           RULES                                  │   │
│   │  • Same phone → Always same proxy (Sticky IP)                   │   │
│   │  • Max 4 sessions per proxy (Anti-Ban)                          │   │
│   │  • New phone → Select available proxy (count < 4)               │   │
│   │  • Proxy error → Mark BAD, switch to new proxy                  │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 תרשים - Trust Levels & Rate Limiting

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        TRUST LEVELS & RATE LIMITING                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   SESSION AGE               TRUST LEVEL              LIMITS              │
│   ───────────               ───────────              ──────              │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                                                                  │   │
│   │    Day 0-3              🥶 COLD                                  │   │
│   │    ─────────            ────────                                 │   │
│   │                         │                                        │   │
│   │    "New session,        │  ┌────────────────────────────────┐   │   │
│   │     high risk"          │  │  Daily Limit:  20 messages     │   │   │
│   │                         │  │  Per Minute:   5 messages      │   │   │
│   │                         │  │  Delay:        5-8 seconds     │   │   │
│   │                         │  │  Hours:        09:00-21:00     │   │   │
│   │                         │  └────────────────────────────────┘   │   │
│   │                         │                                        │   │
│   ├─────────────────────────┼────────────────────────────────────────┤   │
│   │                         │                                        │   │
│   │    Day 3-14             🌡️ WARM                                  │   │
│   │    ──────────           ─────────                                │   │
│   │                         │                                        │   │
│   │    "Building trust,     │  ┌────────────────────────────────┐   │   │
│   │     medium risk"        │  │  Daily Limit:  100 messages    │   │   │
│   │                         │  │  Per Minute:   15 messages     │   │   │
│   │                         │  │  Delay:        3-5 seconds     │   │   │
│   │                         │  │  Hours:        08:00-22:00     │   │   │
│   │                         │  └────────────────────────────────┘   │   │
│   │                         │                                        │   │
│   ├─────────────────────────┼────────────────────────────────────────┤   │
│   │                         │                                        │   │
│   │    Day 14+              🔥 HOT                                   │   │
│   │    ────────             ───────                                  │   │
│   │                         │                                        │   │
│   │    "Trusted session,    │  ┌────────────────────────────────┐   │   │
│   │     lower risk"         │  │  Daily Limit:  500 messages    │   │   │
│   │                         │  │  Per Minute:   30 messages     │   │   │
│   │                         │  │  Delay:        2-4 seconds     │   │   │
│   │                         │  │  Hours:        07:00-23:00     │   │   │
│   │                         │  └────────────────────────────────┘   │   │
│   │                         │                                        │   │
│   └─────────────────────────┴────────────────────────────────────────┘   │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                     JITTER FORMULA                               │   │
│   │                                                                  │   │
│   │   actualDelay = baseDelay + (Math.random() * jitterRange)       │   │
│   │                                                                  │   │
│   │   Example (Warm):                                                │   │
│   │   baseDelay = 3000ms                                             │   │
│   │   jitterRange = 2000ms                                           │   │
│   │   actualDelay = 3000 + (0.73 * 2000) = 4460ms                   │   │
│   │                                                                  │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 תרשים - Webhook Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            WEBHOOK FLOW                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   WORKER                          ORCHESTRATOR                           │
│   ──────                          ────────────                           │
│                                                                          │
│   ┌─────────────┐                                                       │
│   │  Event      │     POST /webhook                                     │
│   │  Occurs     │─────────────────────────────►┌─────────────┐         │
│   └─────────────┘     {                        │  Webhook    │         │
│                         sessionId: "worker_1", │  Handler    │         │
│   Events:               type: "QR_CODE",       └──────┬──────┘         │
│                         data: {...},                  │                 │
│   • QR_CODE             timestamp: 123456            │                 │
│   • CONNECTED         }                              │                 │
│   • DISCONNECTED                                     ▼                 │
│   • MESSAGE_SENT                            ┌─────────────────┐        │
│   • MESSAGE_FAILED                          │  Switch by Type │        │
│   • MESSAGE_RECEIVED                        └────────┬────────┘        │
│   • PING                                             │                 │
│   • PROXY_ERROR                    ┌─────────────────┼─────────────┐   │
│   • AUTH_FAILURE                   │                 │             │   │
│                                    ▼                 ▼             ▼   │
│                           ┌─────────────┐  ┌─────────────┐ ┌─────────┐│
│                           │  QR_CODE    │  │  CONNECTED  │ │  PING   ││
│                           │             │  │             │ │         ││
│                           │ Save QR     │  │ Create      │ │ Update  ││
│                           │ to Redis    │  │ Sticky IP   │ │ lastPing││
│                           │             │  │             │ │         ││
│                           │ Broadcast   │  │ Update      │ │         ││
│                           │ to Dashboard│  │ Status      │ │         ││
│                           │             │  │             │ │         ││
│                           │ Set status  │  │ Telegram    │ │         ││
│                           │ = qr_ready  │  │ Alert ✅    │ │         ││
│                           └─────────────┘  └─────────────┘ └─────────┘│
│                                                                          │
│                           ┌─────────────┐  ┌─────────────┐              │
│                           │ PROXY_ERROR │  │ DISCONNECT  │              │
│                           │             │  │             │              │
│                           │ Mark proxy  │  │ Check       │              │
│                           │ as BAD      │  │ reason      │              │
│                           │             │  │             │              │
│                           │ Select new  │  │ If logged   │              │
│                           │ proxy       │  │ out → delete│              │
│                           │             │  │ auth        │              │
│                           │ Restart     │  │             │              │
│                           │ worker      │  │ Telegram    │              │
│                           │             │  │ Alert ⚠️    │              │
│                           │ Telegram    │  │             │              │
│                           │ Alert 🔄    │  │             │              │
│                           └─────────────┘  └─────────────┘              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 מבנה קבצים

```
/opt/whatsapp-orchestrator/
├── docker-compose.yml          # Docker stack definition
├── Dockerfile                  # Orchestrator image
├── .env                        # Environment variables
├── package.json
│
├── src/
│   ├── server.js               # Express entry point
│   │
│   ├── controllers/
│   │   ├── orchestratorController.js   # Session provisioning
│   │   ├── webhookController.js        # Handle worker webhooks
│   │   └── dashboardController.js      # Dashboard API
│   │
│   ├── services/
│   │   ├── sessionService.js           # Session CRUD
│   │   ├── runnerService.js            # Docker container control
│   │   ├── proxyPoolService.js         # Proxy management
│   │   ├── dispatcherService.js        # Message queues (Anti-Ban)
│   │   ├── outboxService.js            # Process outbox
│   │   ├── watchdogService.js          # Health monitoring
│   │   ├── telegramService.js          # Alerts
│   │   ├── backupService.js            # Backup/Restore
│   │   └── cronService.js              # Scheduled tasks
│   │
│   ├── routes/
│   │   ├── sessionRoutes.js
│   │   ├── messageRoutes.js
│   │   ├── dashboardRoutes.js
│   │   └── backupRoutes.js
│   │
│   ├── infra/
│   │   └── redis.js                    # Redis client
│   │
│   └── public/
│       ├── index.html                  # Dashboard UI
│       ├── scan.html                   # QR scanning page
│       └── live-log.html               # Real-time logs
│
├── docker-wa-worker/
│   ├── Dockerfile                      # Worker image
│   ├── package.json
│   └── index.ts                        # Baileys + Keep-Alive
│
├── sessions/                           # Auth data (volume)
│   ├── worker_1/
│   ├── worker_2/
│   └── ...
│
├── backups/                            # Backup files
│
├── docs/
│   ├── SPEC_SESSION_MANAGEMENT.md
│   ├── SPEC_MESSAGE_DISTRIBUTION.md
│   └── SPEC_FULL_SYSTEM.md (this file)
│
└── scripts/
    ├── setup.sh
    └── deploy.sh
```

---

## ⚙️ Environment Variables

```bash
# === Core ===
NODE_ENV=production
API_KEY=<random-32-chars>
WEBHOOK_SECRET=<random-32-chars>
REDIS_URL=redis://redis:6379

# === Ports ===
ORCH_PORT=3001

# === Session Limits ===
MAX_SESSIONS_PER_PROXY=4
MAX_SESSIONS_PER_PHONE=4

# === Timing ===
PROVISIONING_INTERVAL_MS=2000
MONITOR_INTERVAL_MS=30000
WATCHDOG_INTERVAL_MS=60000
PING_TIMEOUT_MS=180000

# === Proxies (socks5h חובה!) ===
PROXY_URL_1=socks5h://user:pass@host:port
PROXY_URL_2=socks5h://user:pass@host:port
PROXY_URL_3=socks5h://user:pass@host:port

# === Telegram Alerts ===
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_CHAT_ID=<chat-id>

# === Backups ===
SESSIONS_DIR=./sessions
BACKUPS_DIR=./backups
MAX_BACKUPS=7
```

---

## 🚀 פקודות פריסה

```bash
# 1. Clone
git clone <repo> /opt/whatsapp-orchestrator
cd /opt/whatsapp-orchestrator

# 2. Configure
cp env.example .env
nano .env

# 3. Deploy
docker compose build
docker compose up -d

# 4. Verify
docker ps
curl http://localhost:3001/health
```


# 📱 Scan Flow Specification - הוראות למתכנת

## 🎯 מטרה
לבנות "זרימת סריקה" שמייצרת סשן WhatsApp (Baileys) כך ש:
- הפרוקסי נקבע **לפני הסריקה** (ידני אם המשתמש בחר, אחרת אוטומטי מהבריכה)
- אחרי חיבור (`CONNECTED`) נועלים **Sticky IP**: `phoneNumber → proxy`
- החלפת פרוקסי מתבצעת **רק במקרה תקלה** (proxy bad/timeout) ועל ידי השרת, לא ע״י ה‑Worker.

---

## 1️⃣ חוקים

| חוק | הסבר |
|-----|------|
| **Proxy לא מגיע מהטלפון** | Proxy נקבע בשרת (Orchestrator) ומוזרק ל‑Worker ב‑ENV (`PROXY_URL`) |
| **Sticky IP חובה** | אם ל‑phone יש proxy קודם → תמיד להשתמש בו. רק אם נשרף → להחליף |
| **מגבלה: 4 סשנים/פרוקסי** | מקסימום 4 סשנים לפרוקסי בו־זמנית |
| **Worker לא מחליף פרוקסי** | הוא רק מדווח ב־Webhook על מצב/שגיאות |

---

## 2️⃣ Create Session (לפני QR)

### קלט
```json
{
  "sessionId": "string (מזהה פנימי)",
  "proxyOverride": "string? (אופציונלי - פרוקסי ידני)"
}
```

### אלגוריתם

```
┌─────────────────────────────────────────────────────────────┐
│                    CREATE SESSION FLOW                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. proxyOverride קיים?                                     │
│     │                                                       │
│     ├─ YES → validate פורמט                                 │
│     │        → reserve/lock ל־sessionId                     │
│     │                                                       │
│     └─ NO → יש binding קיים ל־sessionId/phone?              │
│             │                                               │
│             ├─ YES → להשתמש בפרוקסי הקיים                   │
│             │                                               │
│             └─ NO → לבחור מ-Pool (capacity < 4)             │
│                                                             │
│  2. לשמור binding זמני:                                     │
│     session:temp:<sessionId> → proxyUrl                     │
│                                                             │
│  3. להריץ Worker עם ENV:                                    │
│     - SESSION_ID=sessionId                                  │
│     - PROXY_URL=proxyUrl                                    │
│     - WEBHOOK_URL=http://<ORCHESTRATOR>:3000/api/webhook    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Pseudo-code
```javascript
async function createSession(sessionId, proxyOverride = null) {
  let proxyUrl;
  
  // 1. Determine proxy
  if (proxyOverride) {
    // Validate format
    if (!isValidProxyUrl(proxyOverride)) {
      throw new Error("Invalid proxy format");
    }
    proxyUrl = proxyOverride;
  } else {
    // Check existing binding
    const existingProxy = await redis.get(`session:proxy:${sessionId}`);
    if (existingProxy) {
      proxyUrl = existingProxy;
    } else {
      // Pick from pool (least loaded, capacity < 4)
      proxyUrl = await pickAvailableProxy();
    }
  }
  
  // 2. Save temporary binding
  await redis.set(`session:temp:${sessionId}`, proxyUrl);
  
  // 3. Reserve proxy slot
  await redis.incr(`counter:proxy:${proxyUrl}`);
  
  // 4. Start worker
  await startWorkerContainer(sessionId, proxyUrl);
  
  return { sessionId, proxyUrl, status: "WAITING_QR" };
}
```

---

## 3️⃣ פקודת Docker Run

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

### ENV Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_ID` | ✅ | מזהה ייחודי לסשן |
| `PROXY_URL` | ✅ | כתובת הפרוקסי (**חובה `socks5h://`**) |
| `WEBHOOK_URL` | ✅ | כתובת ה-Orchestrator לדיווחים |
| `WEBHOOK_SECRET` | ✅ | סוד לאימות webhook |
| `ENABLE_KEEP_ALIVE` | ❌ | הפעלת Keep-Alive Engine (ברירת מחדל: true) |

### Proxy Format (חובה!)
```
socks5h://<USERNAME>:<PASSWORD>@<HOST>:<PORT>
```
> ⚠️ **חובה להשתמש ב-`socks5h`** - ה-`h` מבטיח DNS resolution דרך הפרוקסי (מונע דליפות DNS)

---

## 4️⃣ Webhook CONNECTED (אחרי הסריקה)

כשה‑Worker מתחבר בהצלחה הוא שולח:

```json
{
  "sessionId": "session_123",
  "type": "CONNECTED",
  "timestamp": 1702406400000,
  "data": {
    "phoneNumber": "972501234567",
    "jid": "972501234567@s.whatsapp.net",
    "fingerprint": "Windows/Chrome/120.0"
  }
}
```

### השרת חייב לבצע:

```
┌─────────────────────────────────────────────────────────────┐
│                  CONNECTED WEBHOOK HANDLER                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. לקרוא proxy מ-binding זמני:                             │
│     proxyUrl = GET session:temp:<sessionId>                 │
│                                                             │
│  2. ליצור Sticky binding קבוע:                              │
│     SET phone:proxy:<phoneNumber> → proxyUrl                │
│     HSET session:<sessionId> phone → phoneNumber            │
│     HSET session:<sessionId> proxy → proxyUrl               │
│     HSET session:<sessionId> status → CONNECTED             │
│                                                             │
│  3. לנקות binding זמני:                                     │
│     DEL session:temp:<sessionId>                            │
│                                                             │
│  4. לעדכן counters:                                         │
│     SADD sessions:active <sessionId>                        │
│     (proxy counter already incremented in create)           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Pseudo-code
```javascript
async function handleConnectedWebhook(sessionId, phoneNumber) {
  // 1. Get temp proxy binding
  const proxyUrl = await redis.get(`session:temp:${sessionId}`);
  
  // 2. Create permanent Sticky binding
  await redis.set(`phone:proxy:${phoneNumber}`, proxyUrl);
  
  await redis.hset(`session:${sessionId}`, {
    phone: phoneNumber,
    proxy: proxyUrl,
    status: "CONNECTED",
    connectedAt: Date.now()
  });
  
  // 3. Clean temp binding
  await redis.del(`session:temp:${sessionId}`);
  
  // 4. Add to active sessions
  await redis.sadd("sessions:active", sessionId);
  
  console.log(`[Sticky] ${phoneNumber} → ${proxyUrl}`);
}
```

---

## 5️⃣ תקלה בפרוקסי (Failover)

### כשה‑Worker מדווח disconnect/proxy error:

```
┌─────────────────────────────────────────────────────────────┐
│                    PROXY FAILOVER FLOW                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Worker שולח webhook:                                    │
│     { type: "STATUS_CHANGE",                                │
│       data: { status: "DISCONNECTED", error: "proxy..." }}  │
│                                                             │
│  2. Orchestrator מזהה proxy error:                          │
│     → SET proxy:status:<oldProxy> → "BAD"                   │
│     → SET proxy:bad_at:<oldProxy> → timestamp               │
│     → DECR counter:proxy:<oldProxy>                         │
│                                                             │
│  3. בחירת proxy חדש:                                        │
│     → newProxy = pickAvailableProxy() (capacity < 4)        │
│     → INCR counter:proxy:<newProxy>                         │
│                                                             │
│  4. עדכון Sticky binding:                                   │
│     → SET phone:proxy:<phoneNumber> → newProxy              │
│     → HSET session:<sessionId> proxy → newProxy             │
│                                                             │
│  5. הרמת Worker מחדש:                                       │
│     → docker stop wa_session_<sessionId>                    │
│     → docker rm wa_session_<sessionId>                      │
│     → docker run ... -e PROXY_URL=<newProxy> ...            │
│                                                             │
│  ⚠️ Auth volume נשמר - לא צריך סריקה מחדש!                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Pseudo-code
```javascript
async function handleProxyFailure(sessionId, phoneNumber, oldProxy) {
  // 1. Mark proxy as BAD
  await redis.set(`proxy:status:${oldProxy}`, "BAD");
  await redis.set(`proxy:bad_at:${oldProxy}`, Date.now());
  await redis.decr(`counter:proxy:${oldProxy}`);
  
  // 2. Pick new proxy
  const newProxy = await pickAvailableProxy();
  await redis.incr(`counter:proxy:${newProxy}`);
  
  // 3. Update Sticky binding
  await redis.set(`phone:proxy:${phoneNumber}`, newProxy);
  await redis.hset(`session:${sessionId}`, "proxy", newProxy);
  
  // 4. Restart worker with new proxy
  await docker.stop(`wa_session_${sessionId}`);
  await docker.rm(`wa_session_${sessionId}`);
  await startWorkerContainer(sessionId, newProxy);
  
  console.log(`[Failover] ${phoneNumber}: ${oldProxy} → ${newProxy}`);
}
```

---

## 6️⃣ Anti‑Ban (לא בתוך ה‑Worker)

האנטי‑באן מתבצע בצד **Dispatcher/Orchestrator**:

```
┌─────────────────────────────────────────────────────────────┐
│                      ANTI-BAN LAYER                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  תורים פר‑סשן:                                              │
│    queue:session:<phone>                                    │
│                                                             │
│  קצב/דיליי/שונות:                                           │
│    - RPM per session (based on Trust Level)                 │
│    - Cold: 10 msg/day, Warm: 50, Hot: 200                   │
│    - Jitter: ±30% delay                                     │
│    - Burst detection                                        │
│                                                             │
│  Override:                                                  │
│    - Dashboard /anti-ban                                    │
│    - API /api/anti-ban/sessions/:id/limits                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 📊 Redis Keys Summary

```
# Temporary (during scan)
session:temp:<sessionId>        → proxyUrl (deleted after CONNECTED)

# Permanent Sticky Bindings
phone:proxy:<phoneNumber>       → proxyUrl (THE Sticky binding)
session:<sessionId>             → HASH { phone, proxy, status, ... }

# Proxy Pool
proxies:available               → SET of healthy proxy URLs
counter:proxy:<proxyUrl>        → number of sessions (max 4)
proxy:status:<proxyUrl>         → "OK" | "BAD"
proxy:bad_at:<proxyUrl>         → timestamp when marked bad

# Active Sessions
sessions:active                 → SET of active session IDs
```

---

## ✅ Checklist למתכנת

- [ ] Worker מקבל `PROXY_URL` ב-ENV ולא מחליף לבד
- [ ] Orchestrator יוצר binding זמני לפני QR
- [ ] Orchestrator יוצר Sticky binding אחרי CONNECTED
- [ ] Proxy counter לא עובר 4
- [ ] Failover רק ע"י Orchestrator
- [ ] Auth volume נשמר ב-restart

---

## 🔧 פורמט PROXY_URL (חובה `socks5h`)

### תבנית
```text
socks5h://<USERNAME>:<PASSWORD>@<HOST>:<PORT>
```

### דוגמה אמיתית
```text
socks5h://user-sp5bsj3g21-ip-36.255.214.15:qBhmWZl9gppk4aG7_5@isp.decodo.com:10001
```

### למה `socks5h` (ולא `socks5`/`http`)
| פרוטוקול | DNS Resolution | Anti-Ban |
|----------|----------------|----------|
| `socks5h://` | ✅ דרך הפרוקסי | ✅ מומלץ! |
| `socks5://` | ❌ מקומי | ⚠️ דליפת DNS |
| `http://` | ❌ מקומי | ⚠️ פחות מאובטח |

> **ה־`h` אומר ש־DNS נעשה דרך הפרוקסי** - זה עדיף לאנטי‑באן ומונע "דליפות DNS".

### פקודת docker run (מוכן להדבקה)
```bash
docker run -d --restart unless-stopped \
  --name wa_session_<SESSION_ID> \
  -v /host/data/sessions/<SESSION_ID>:/app/sessions/<SESSION_ID> \
  -e SESSION_ID="<SESSION_ID>" \
  -e PROXY_URL="socks5h://user-sp5bsj3g21-ip-36.255.214.15:qBhmWZl9gppk4aG7_5@isp.decodo.com:10001" \
  -e WEBHOOK_URL="http://<ORCHESTRATOR_HOST>:3000/api/webhook" \
  -e WEBHOOK_SECRET="<SECRET>" \
  whatsapp-worker-image:1.0.0
```

### הכלל למתכנת
> **אם אין override מהמשתמש – Orchestrator בוחר PROXY_URL מהבריכה. אם יש override – משתמשים בו ונועלים אותו ל־phone אחרי CONNECTED.**


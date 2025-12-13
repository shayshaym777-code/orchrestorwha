# 🧪 WhatsApp Worker - Testing Guide

## Quick Start (One Command)

```cmd
cd docker-wa-worker\test-scripts
quick-start.bat
```

This will:
1. Build the worker image
2. Build and start the test webhook server
3. Start a worker session
4. Open the QR code page in your browser

---

## Preconditions

Before running tests:

- ✅ Docker Desktop is running
- ✅ You have a WhatsApp phone ready to scan QR
- ✅ Port 3000 is available

---

## Test Environment Setup

### 1. Build Worker Image

```cmd
cd docker-wa-worker
docker build --no-cache -t whatsapp-worker-image:local .
```

### 2. Start Local Webhook Server

```cmd
cd test-server
docker build -t wa-test-webhook .
docker run -d --name wa_test_webhook -p 3000:3000 wa-test-webhook
```

Access points:
- **Dashboard**: http://localhost:3000/
- **QR Viewer**: http://localhost:3000/qr/{sessionId}
- **Events API**: http://localhost:3000/events

---

## Test Cases

### Test 1: Build ✅

```cmd
docker build --no-cache -t whatsapp-worker-image:local .
docker image ls whatsapp-worker-image:local
```

**PASS**: Image exists and shows in list.

---

### Test 2: Smoke Test (No Proxy)

```cmd
docker rm -f wa_session_123
mkdir C:\wa-sessions\123

docker run -d ^
  --name wa_session_123 ^
  -v C:\wa-sessions\123:/app/sessions/123 ^
  -e SESSION_ID="123" ^
  -e WEBHOOK_URL="http://host.docker.internal:3000/webhook" ^
  whatsapp-worker-image:local
```

```cmd
docker logs -f wa_session_123
```

**PASS if**:
- Container stays running
- "QR Code Updated" appears in logs within ~30 seconds
- `QR_UPDATE` event appears in webhook server

---

### Test 3: QR Scan & Connect

1. Open http://localhost:3000/qr/123
2. Scan QR with WhatsApp
3. Check webhook server logs

**PASS if**:
- `CONNECTED` event received
- `data.phoneNumber` exists
- `data.jid` exists

---

### Test 4: Ping Test

Wait 2-3 minutes after connection.

**PASS if**:
- `PING` events appear every 60 seconds
- At least 2 pings received

---

### Test 5: Persistence Test

```cmd
docker restart wa_session_123
docker logs -f wa_session_123
```

**PASS if**:
- No new QR required (or minimal QR events)
- `CONNECTED` event received quickly
- Files still exist in `C:\wa-sessions\123\`

---

### Test 6: Isolation Test (Multiple Sessions)

```cmd
mkdir C:\wa-sessions\124

docker run -d ^
  --name wa_session_124 ^
  -v C:\wa-sessions\124:/app/sessions/124 ^
  -e SESSION_ID="124" ^
  -e WEBHOOK_URL="http://host.docker.internal:3000/webhook" ^
  whatsapp-worker-image:local
```

**PASS if**:
- `QR_UPDATE` received for session 124
- Files saved in separate directory
- No cross-contamination between sessions

---

### Test 7: Proxy Test

```cmd
docker run -d ^
  --name wa_session_125 ^
  -v C:\wa-sessions\125:/app/sessions/125 ^
  -e SESSION_ID="125" ^
  -e PROXY_URL="http://user:pass@ip:port" ^
  -e WEBHOOK_URL="http://host.docker.internal:3000/webhook" ^
  whatsapp-worker-image:local
```

**PASS if**:
- Container stays running
- QR_UPDATE / CONNECTED events work
- No reconnect loops

**FAIL if**:
- Container crashes
- Endless reconnection loop

---

### Test 8: Logout Behavior

1. Log out from WhatsApp on phone
2. Or delete auth files: `rmdir /s /q C:\wa-sessions\123`

**PASS if**:
- `STATUS_CHANGE` with `LOGGED_OUT` sent
- Auth directory emptied
- Container exits with code 1

Check exit code:
```cmd
docker inspect wa_session_123 --format="{{.State.ExitCode}}"
```

---

### Test 9: Resource Check

```cmd
docker stats --no-stream wa_session_123
```

**PASS if**:
- CPU usage is reasonable (<50% sustained)
- Memory usage is reasonable (<200MB typical)

---

## Webhook Events Reference

### QR_UPDATE
```json
{
  "sessionId": "123",
  "type": "QR_UPDATE",
  "timestamp": 1730000000000,
  "data": {
    "qrCode": "2@ABC123..."
  }
}
```

### CONNECTED
```json
{
  "sessionId": "123",
  "type": "CONNECTED",
  "timestamp": 1730000000000,
  "data": {
    "phoneNumber": "972501234567",
    "jid": "972501234567:42@s.whatsapp.net"
  }
}
```

### STATUS_CHANGE
```json
{
  "sessionId": "123",
  "type": "STATUS_CHANGE",
  "timestamp": 1730000000000,
  "data": {
    "status": "RECONNECTING | LOGGED_OUT | SHUTTING_DOWN"
  }
}
```

### PING
```json
{
  "sessionId": "123",
  "type": "PING",
  "timestamp": 1730000000000,
  "data": {
    "status": "ALIVE"
  }
}
```

---

## Cleanup

```cmd
docker rm -f wa_session_123 wa_session_124 wa_session_125 wa_test_webhook
rmdir /s /q C:\wa-sessions
```

Or use:
```cmd
cd test-scripts
cleanup.bat
```

---

## Checklist for Delivery

Before submitting, confirm:

| Test | Status |
|------|--------|
| Build passes | ⬜ |
| Container runs without crash | ⬜ |
| QR_UPDATE within 30s | ⬜ |
| CONNECTED after scan | ⬜ |
| PING every 60s | ⬜ |
| Persistence (restart) | ⬜ |
| Multiple sessions | ⬜ |
| Proxy (if applicable) | ⬜ |
| Logout behavior | ⬜ |
| Resources OK | ⬜ |

**Required Deliverables**:
1. Build command that worked
2. Run commands (with/without proxy, multiple sessions)
3. Sample webhook payloads
4. Screenshot/logs showing: QR_UPDATE → CONNECTED → PING


## Technical Spec – Distributed WhatsApp Bots Orchestrator (Docker Cluster)

This repo now contains:
- **Message intake API** (`POST /api/messages`) – receives contacts + either message OR image, returns immediately.
- **Orchestrator API** – internal management endpoints for profiles/proxies/status/restart.
- **Orchestrator Runner** – background loop skeleton for provisioning + monitoring.

> The orchestrator does not implement WhatsApp sending itself. It is the control-plane that allocates resources and starts/stops containers.

---

## Architecture Components

### A) Orchestrator (control-plane)
- Tech: Node.js + Express
- State:
  - **Redis**: real-time counters, pools, sticky bindings
  - **SQLite**: history/bindings table (audit trail)
- Container control: **Docker** via `dockerode` (placeholder in skeleton)

### B) Resources Pool
- **Profiles queue**: loaded from uploaded text file; each line is treated as a profile payload (you can store JSON per line).
- **Proxy pool**: loaded from uploaded text file; each line is treated as a proxy descriptor.

### C) Worker Nodes (containers)
- Each bot runs in its own Docker container with isolated network.
- The container runs Baileys with injected env vars (proxy/fingerprint/etc.)

---

## Business Rules (enforced by Orchestrator services)

- **Proxy/IP rule**: max \(4\) concurrent sessions per proxy.
- **Phone rule**: max \(4\) active sessions per phone in the entire system.
- **Sticky IP**: prefer reusing the same proxy for a phone when possible.
- **Inventory management**:
  - Profiles/proxies are loaded via API upload endpoints.
  - If no profiles or no proxies available → trigger alert (stub).

---

## Redis Keys

From `src/services/inventoryService.js`:
- `profiles:available` (SET)
- `profiles:used` (SET)
- `proxies:all` (SET)
- `proxies:available` (SET)
- `proxies:bad` (SET)

From `src/services/allocationService.js`:
- `phone:sticky_proxy` (HASH phone -> proxy)
- `proxy:active_count` (HASH proxy -> int)
- `phone:active_count` (HASH phone -> int)

From `src/services/outboxService.js` (Dispatcher -> Orchestrator -> Worker send queue):
- `session:outbox:<sessionId>` (LIST) pending tasks for a worker session
- `session:outbox:processing:<sessionId>` (LIST) claimed tasks awaiting ack/nack

---

## SQLite Tables

From `src/infra/db.js`:
- `session_bindings`
  - `bot_id`, `phone`, `proxy_ip`, `profile_id`, `status`, timestamps

---

## Orchestrator API (internal)

All endpoints require header `X-API-KEY`.

### `POST /upload/profiles`
- multipart/form-data
  - field `file`: text file
- Response: `{ "status": "ok", "added": <number> }`

### `POST /upload/proxies`
- multipart/form-data
  - field `file`: text file
- Response: `{ "status": "ok", "added": <number> }`

### `GET /status`
- Response:
```json
{
  "status": "ok",
  "inventory": {
    "profiles": { "available": 10, "used": 3 },
    "proxies": { "available": 5, "total": 8, "bad": 1 }
  },
  "rules": { "maxSessionsPerProxy": 4, "maxSessionsPerPhone": 4 }
}
```

### `POST /session/restart/:id`
- Placeholder: returns `{ "status": "ok", "restarted": "<id>" }`

---

## Worker Outbox Queue (server A has queues)

This is the **send-command queue** used by the Dispatcher (separate service) and consumed by Workers.

### Dispatcher -> Orchestrator (enqueue task)

Requires `X-API-KEY`.

#### `POST /api/sessions/:id/outbox/enqueue`
Body (example):
```json
{ "mode":"message", "to":"972501234567", "text":"שלום", "jobId":"...", "taskId":"..." }
```
or for image:
```json
{ "mode":"image", "to":"972501234567", "mediaRef":"<filename>", "mediaPath":"<tmp path>", "jobId":"...", "taskId":"..." }
```

### Worker -> Orchestrator (claim/ack/nack)

These endpoints are secured by `WEBHOOK_SECRET` (header `X-Webhook-Secret`).

#### `POST /api/worker/sessions/:id/outbox/claim?timeout=20`
Long-polls and returns:
```json
{ "status":"ok", "task": { /* task */ }, "raw": "<exact json string>" }
```
If nothing available within timeout:
```json
{ "status":"ok", "task": null }
```

#### `POST /api/worker/sessions/:id/outbox/ack`
Body: `{ "raw": "<exact json string from claim>" }`

#### `POST /api/worker/sessions/:id/outbox/nack`
Body: `{ "raw": "<exact json string from claim>" }`
Requeues the task back to the session outbox.

---

## Runner Loop

`src/orchestrator/runner.js` starts two intervals:
- **Provisioning tick**: checks inventory and would allocate/start new bot containers.
- **Monitor tick**: would ping containers and trigger recovery actions.

Both are currently skeleton placeholders (safe to extend).

---

## Env Vars

Use `env.example` as a base.
- `API_KEY`
- `PORT`
- `REDIS_URL` (default: `redis://127.0.0.1:6379`)
- `DB_PATH` (default: `./data/orchestrator.sqlite`)
- `MAX_SESSIONS_PER_PROXY` (default: 4)
- `MAX_SESSIONS_PER_PHONE` (default: 4)
- `PROVISIONING_INTERVAL_MS` (default: 2000)
- `MONITOR_INTERVAL_MS` (default: 30000)



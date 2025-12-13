# WhatsApp Messaging Gateway

**GATEWAY_SPEC.md Compliant** - Public API for message intake and queueing.

## Overview

Gateway is a standalone HTTP API that:
- ✅ Accepts message/image requests with strict validation
- ✅ Authenticates via API key
- ✅ Enqueues jobs to Redis with idempotency support
- ✅ Returns immediate ACK (200) with `jobId`
- ✅ Handles Redis failures gracefully (503)

**Single Endpoint**: `POST /v1/jobs`

## Quick Start

### 1. Prerequisites

- Node.js 18+
- Redis running on `127.0.0.1:6379` (or configure `REDIS_URL`)

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
# Copy example config
cp env.example .env

# Edit .env and set your API_KEY
```

**Important**: Change `API_KEY` in `.env` before deploying!

### 4. Start Server

```bash
npm start
```

Server runs on **PORT 4000** (configurable via `.env`).

### 5. Run Tests

```bash
# Make sure server is running on port 4000
npm test
```

## API Usage

### JSON Message Mode

Send text message to multiple contacts:

```bash
curl -X POST http://localhost:4000/v1/jobs \
  -H "X-API-KEY: change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "idempotencyKey": "unique-key-123",
    "message": "שלום מ-Gateway!",
    "contacts": [
      {"name": "David", "phone": "972501234567"},
      {"name": "Sarah", "phone": "972509876543"}
    ]
  }'
```

**Response** (200):
```json
{
  "status": "ok",
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "received": 2,
  "hasImage": false
}
```

### Multipart Image Mode

Send image to contacts:

```bash
curl -X POST http://localhost:4000/v1/jobs \
  -H "X-API-KEY: change-me" \
  -F "idempotencyKey=image-key-456" \
  -F 'contacts=[{"name":"Test","phone":"972500000000"}]' \
  -F "image=@path/to/image.jpg"
```

**Response** (200):
```json
{
  "status": "ok",
  "jobId": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "received": 1,
  "hasImage": true
}
```

## Validation Rules (Strict)

### Contacts
- **Required**: Array with at least 1 contact
- `name`: 1-80 characters (non-empty after trim)
- `phone`: 8-15 digits only (no `+` or spaces)

### Message (JSON mode)
- **Required** in JSON mode
- 1-4096 characters (non-empty after trim)

### Image (Multipart mode)
- **Required** in multipart mode
- **Allowed types**: `image/jpeg`, `image/png`, `image/webp`
- **Max size**: 10MB

### Idempotency Key (optional)
- Format: `[A-Za-z0-9._-]{1,128}`
- Same key returns same `jobId` (24h TTL)

## Error Handling

| Status | Code | Reason |
|--------|------|--------|
| 401 | `AUTH_MISSING` | Missing `X-API-KEY` header |
| 401 | `AUTH_INVALID` | Invalid API key |
| 400 | `PAYLOAD_INVALID` | Validation error (bad JSON, missing fields, etc.) |
| 413 | `FILE_TOO_LARGE` | Image exceeds 10MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Image type not supported |
| 429 | `RATE_LIMIT` | Too many requests |
| 503 | `QUEUE_UNAVAILABLE` | Redis/Queue is down |
| 500 | `INTERNAL_ERROR` | Server error |

**Example error** (400):
```json
{
  "status": "error",
  "reason": "Phone must be 8-15 digits only (no + or spaces)",
  "code": "PAYLOAD_INVALID"
}
```

**Redis down** (503):
```json
{
  "status": "error",
  "reason": "Queue unavailable",
  "code": "QUEUE_UNAVAILABLE"
}
```

## Idempotency

Prevents duplicate message sends:

1. Client sends `idempotencyKey: "abc123"`
2. Gateway creates `jobId: "xyz"` and stores mapping for 24h
3. Client retries with same `idempotencyKey: "abc123"`
4. Gateway returns same `jobId: "xyz"` **without creating duplicate job**

## Health Endpoints

### `GET /health`

Check server status (public, no auth):

```bash
curl http://localhost:4000/health
```

Response:
```json
{
  "status": "ok",
  "service": "gateway",
  "redis": "connected",
  "timestamp": 1702400000000
}
```

### `GET /health/queue`

Check queue status (requires auth):

```bash
curl http://localhost:4000/health/queue \
  -H "X-API-KEY: change-me"
```

Response:
```json
{
  "status": "ok",
  "queue": {
    "key": "gateway:jobs",
    "length": 42
  },
  "timestamp": 1702400000000
}
```

## Configuration (.env)

```bash
# Server
PORT=4000

# Redis
REDIS_URL=redis://127.0.0.1:6379

# Authentication
API_KEY=change-me

# Queue
QUEUE_KEY=gateway:jobs

# Idempotency TTL (24 hours)
IDEMPOTENCY_TTL_SECONDS=86400

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100

# Media Storage
MEDIA_DIR=./tmp/media
```

## Project Structure

```
messaging-plane/gateway/
├── src/
│   ├── server.js       # Main Express server
│   └── validators.js   # Joi validation schemas
├── test/
│   └── run-tests.js    # Integration tests
├── tmp/
│   └── media/          # Temporary image storage
├── package.json
├── env.example
└── README.md
```

## Testing

Run integration tests (requires server + Redis running):

```bash
npm test
```

Tests verify:
1. ✅ JSON message mode → 200 + jobId
2. ✅ Multipart image mode → 200 + jobId
3. ✅ Idempotency → same jobId on repeat
4. ✅ Redis down → 503 QUEUE_UNAVAILABLE
5. ✅ Job enqueued proof (queue inspection)

## Deployment Notes

### Production Checklist
- [ ] Change `API_KEY` to secure random string
- [ ] Configure `REDIS_URL` to production Redis
- [ ] Set appropriate `RATE_LIMIT_MAX`
- [ ] Use process manager (PM2, systemd)
- [ ] Set up Redis persistence (AOF/RDB)
- [ ] Configure reverse proxy (nginx) with HTTPS
- [ ] Monitor queue length (`/health/queue`)

### Redis Queue Format

Jobs are stored in Redis:
- **Queue**: List at `gateway:jobs` (configurable via `QUEUE_KEY`)
- **Job data**: Hash at `job:{jobId}` (24h TTL)
- **Idempotency**: Key at `idempotency:{key}` → `jobId` (24h TTL)

**Queue structure**:
```
LPUSH gateway:jobs "jobId1"
LPUSH gateway:jobs "jobId2"
...

GET job:jobId1 → JSON with { jobId, mode, message/mediaRef, contacts, createdAt, status }
GET idempotency:unique-key → "jobId1"
```

Workers should:
1. `BRPOP gateway:jobs` (blocking pop from right)
2. `GET job:{jobId}` to retrieve job data
3. Process the job
4. Delete `job:{jobId}` when done

## License

Internal use only.

## Support

For issues or questions, contact the development team.


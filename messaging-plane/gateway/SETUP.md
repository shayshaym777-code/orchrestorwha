# Gateway Setup & Testing Guide

## Prerequisites

### 1. Install Redis

**Option A: Download Redis for Windows**

Download and install Redis from: https://github.com/tporadowski/redis/releases
Or use chocolatey:
```powershell
choco install redis-64
```

**Option B: Use Docker**

```powershell
docker run -d -p 6379:6379 --name redis redis:7-alpine
```

**Option C: Use WSL2**

```bash
# In WSL Ubuntu
sudo apt update
sudo apt install redis-server
sudo service redis-server start
```

### 2. Verify Redis is Running

```powershell
# Test connection to Redis
Test-NetConnection -ComputerName 127.0.0.1 -Port 6379

# Should return: TcpTestSucceeded : True
```

## Installation

### 1. Navigate to Gateway Directory

```powershell
cd messaging-plane/gateway
```

### 2. Install Dependencies

```powershell
npm install
```

### 3. Configure Environment

```powershell
# Copy example config
copy env.example .env

# IMPORTANT: Edit .env and change API_KEY
# Default is "change-me" - use for testing only!
```

## Running the Server

### Start Server

```powershell
npm start
```

Expected output:
```
╔═══════════════════════════════════════════════════════════╗
║           WhatsApp Messaging Gateway                      ║
║           (GATEWAY_SPEC.md compliant)                     ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoint: POST /v1/jobs                                  ║
║  Port: 4000                                               ║
║  Redis: redis://127.0.0.1:6379                            ║
║  Queue: gateway:jobs                                      ║
║  Rate Limit: 100 req/60s                                  ║
╚═══════════════════════════════════════════════════════════╝

[Gateway] Redis connected and ready
```

### Check Health

```powershell
curl http://localhost:4000/health
```

Expected (Redis UP):
```json
{
  "status": "ok",
  "service": "gateway",
  "redis": "connected",
  "timestamp": 1702400000000
}
```

If Redis is DOWN:
```json
{
  "status": "ok",
  "service": "gateway",
  "redis": "disconnected",
  "timestamp": 1702400000000
}
```

## Running Tests

### Prerequisites
- Server must be running (`npm start` in another terminal)
- Redis must be running

### Run All Tests

```powershell
npm test
```

This runs 5 critical tests:

1. ✅ JSON message mode → 200 + jobId
2. ✅ Multipart image mode → 200 + jobId  
3. ✅ Idempotency → same jobId on repeat
4. ✅ Redis down → 503 QUEUE_UNAVAILABLE (skip if Redis is up)
5. ✅ Job enqueued proof (queue inspection)

## Manual Testing (curl)

### Test 1: JSON Message Mode

```powershell
$body = @{
    idempotencyKey = "test-001"
    message = "שלום, זו הודעת בדיקה"
    contacts = @(
        @{ name = "David"; phone = "972501234567" }
        @{ name = "Sarah"; phone = "972509876543" }
    )
} | ConvertTo-Json

curl -X POST http://localhost:4000/v1/jobs `
  -H "Content-Type: application/json" `
  -H "X-API-KEY: change-me" `
  -Body $body
```

Expected:
```json
{
  "status": "ok",
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "received": 2,
  "hasImage": false
}
```

### Test 2: Multipart Image Mode

Create a test image first:
```powershell
# Create 1x1 pixel test image
$bytes = [byte[]](0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46)
[System.IO.File]::WriteAllBytes("test.jpg", $bytes)
```

Then upload:
```powershell
curl -X POST http://localhost:4000/v1/jobs `
  -H "X-API-KEY: change-me" `
  -F "idempotencyKey=test-img-001" `
  -F 'contacts=[{"name":"Test","phone":"972500000000"}]' `
  -F "image=@test.jpg"
```

### Test 3: Idempotency

Send the same request twice:
```powershell
# First request
$body = @{
    idempotencyKey = "unique-key-123"
    message = "Test"
    contacts = @(@{ name = "Test"; phone = "972500000000" })
} | ConvertTo-Json

$response1 = curl -X POST http://localhost:4000/v1/jobs `
  -H "Content-Type: application/json" `
  -H "X-API-KEY: change-me" `
  -Body $body

# Second request (same idempotencyKey)
$response2 = curl -X POST http://localhost:4000/v1/jobs `
  -H "Content-Type: application/json" `
  -H "X-API-KEY: change-me" `
  -Body $body

# Both should return the SAME jobId
```

### Test 4: Redis Down → 503

1. Stop Redis:
```powershell
# If using Docker:
docker stop redis

# If using Windows service:
net stop Redis

# If using WSL:
wsl sudo service redis-server stop
```

2. Try to send a job:
```powershell
$body = @{
    message = "This should fail"
    contacts = @(@{ name = "Test"; phone = "972500000000" })
} | ConvertTo-Json

curl -X POST http://localhost:4000/v1/jobs `
  -H "Content-Type: application/json" `
  -H "X-API-KEY: change-me" `
  -Body $body
```

Expected (503):
```json
{
  "status": "error",
  "reason": "Queue unavailable",
  "code": "QUEUE_UNAVAILABLE"
}
```

3. Restart Redis:
```powershell
# Docker:
docker start redis

# Windows service:
net start Redis

# WSL:
wsl sudo service redis-server start
```

### Test 5: Queue Inspection

Check queue status:
```powershell
curl http://localhost:4000/health/queue `
  -H "X-API-KEY: change-me"
```

Expected:
```json
{
  "status": "ok",
  "queue": {
    "key": "gateway:jobs",
    "length": 5
  },
  "timestamp": 1702400000000
}
```

## Troubleshooting

### Server won't start
- Check if another process is using port 4000:
  ```powershell
  Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue
  ```
- Kill the process if found:
  ```powershell
  Stop-Process -Id <PID> -Force
  ```

### Redis connection errors
- Verify Redis is running:
  ```powershell
  Test-NetConnection 127.0.0.1 -Port 6379
  ```
- Check REDIS_URL in `.env` is correct
- Try telnet to Redis:
  ```powershell
  telnet 127.0.0.1 6379
  ```

### Tests fail with 401
- Make sure API_KEY in `.env` matches the one in test
- Default is `change-me`

### Image upload fails with 413/415
- Check image size (max 10MB)
- Check image type (only jpeg, png, webp)

## Production Deployment

See [README.md](README.md) for production checklist.


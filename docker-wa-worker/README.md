## docker-wa-worker (Baileys Worker)

A single WhatsApp session worker designed to run as an isolated Docker container.
All configuration is provided via environment variables. Only auth state is persisted via a mounted volume.

### Build
```bash
docker build -t whatsapp-worker-image .
```

### Run (example)
Windows example:
```bash
docker run -d ^
  --name wa_session_123 ^
  -v C:\host\data\sessions\123:/app/sessions/123 ^
  -e SESSION_ID="123" ^
  -e PROXY_URL="http://user:pass@ip:port" ^
  -e BROWSER_OS="Windows" ^
  -e BROWSER_NAME="Chrome" ^
  -e BROWSER_VERSION="119.0" ^
  -e WEBHOOK_URL="http://manager-ip:3000/webhook" ^
  whatsapp-worker-image
```

### Environment Variables
- SESSION_ID (default: default_session)
- PROXY_URL (optional)
- BROWSER_OS (default: Windows)
- BROWSER_NAME (default: Chrome)
- BROWSER_VERSION (default: 120.0)
- WEBHOOK_URL (optional but required for manager integration)
- RECONNECT_DELAY_MS (default: 3000)
- WEBHOOK_TIMEOUT_MS (default: 10000)

### Webhook payload contract
Worker sends POST to WEBHOOK_URL with:
```json
{
  "sessionId": "123",
  "type": "QR_UPDATE | CONNECTED | STATUS_CHANGE | PING",
  "timestamp": 1730000000000,
  "data": {}
}
```

Events:
- QR_UPDATE: data.qrCode
- CONNECTED: data.phoneNumber, data.jid
- STATUS_CHANGE: data.status = RECONNECTING | LOGGED_OUT | SHUTTING_DOWN
- PING: data.status = ALIVE

### Notes
- qrTimeout is set to 0 (QR never expires; it refreshes).
- On LOGGED_OUT the worker wipes auth dir and exits with code 1.

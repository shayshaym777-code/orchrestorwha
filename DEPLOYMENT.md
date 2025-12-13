# 🚀 Deployment Guide - WhatsApp Orchestrator

## 📋 Prerequisites

### Server Requirements
- **OS**: Ubuntu 20.04+ / Debian 11+ (Linux recommended)
- **RAM**: 4GB minimum, 8GB recommended
- **CPU**: 2 cores minimum
- **Disk**: 20GB+ SSD
- **Docker**: 20.10+
- **Docker Compose**: 2.0+
- **Node.js**: 18+ (for local development only)

### Network
- Port **3000** open (Orchestrator API)
- Port **6379/6380** for Redis (internal only)
- Outbound HTTPS (443) for WhatsApp servers

---

## 🔧 Quick Start (5 minutes)

### 1. Clone Repository
```bash
git clone <YOUR_REPO_URL> whatsapp-orchestrator
cd whatsapp-orchestrator
```

### 2. Configure Environment
```bash
cp env.example .env
nano .env  # Edit with your values
```

**Required variables:**
```env
# Security (CHANGE THESE!)
API_KEY=your-secure-api-key-here
WEBHOOK_SECRET=your-webhook-secret-here

# Redis
REDIS_URL=redis://172.28.0.2:6379

# Telegram Alerts (optional but recommended)
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id
TELEGRAM_INCIDENT_ALERTS_ENABLED=false
TELEGRAM_INCIDENT_POLL_INTERVAL_MS=5000
TELEGRAM_JOB_ALERTS_ENABLED=false
TELEGRAM_JOB_POLL_INTERVAL_MS=5000

# Proxies (socks5h required!)
PROXY_URL_1=socks5h://user:pass@proxy1:port
PROXY_URL_2=socks5h://user:pass@proxy2:port
PROXY_URL_3=socks5h://user:pass@proxy3:port
```

### 3. Start Services
```bash
docker-compose up -d
```

### 4. Verify
```bash
# Check health
curl http://localhost:3000/health

# Check logs
docker-compose logs -f orchestrator
```

---

## 📁 Project Structure

```
whatsapp-orchestrator/
├── src/                      # Orchestrator source code
│   ├── server.js             # Main Express server
│   ├── config/               # Configuration
│   ├── controllers/          # API handlers
│   ├── routes/               # API routes
│   ├── services/             # Business logic
│   │   ├── sessionRegistry.js    # Session management (Lua)
│   │   ├── watchdogService.js    # Health monitoring
│   │   ├── backupService.js      # Daily backups
│   │   ├── telegramAlertService.js # Alerts
│   │   └── ...
│   ├── infra/                # Redis connection
│   └── public/               # Dashboard UI
│
├── docker-wa-worker/         # Worker source code
│   ├── index.ts              # Baileys worker
│   ├── Dockerfile
│   └── package.json
│
├── docs/                     # Documentation
│   ├── ARCHITECTURE.md
│   ├── PROXY_ARCHITECTURE.md
│   └── SCAN_FLOW_SPEC.md
│
├── docker-compose.yml        # Production setup
├── env.example               # Environment template
├── package.json
└── DEPLOYMENT.md             # This file
```

---

## 🐳 Docker Compose Services

| Service | IP | Port | Description |
|---------|-----|------|-------------|
| `redis` | 172.28.0.2 | 6379 | Data store |
| `orchestrator` | 172.28.0.3 | 3000 | Main API server |
| `worker-1` | 172.28.0.10 | - | WhatsApp session 1 |
| `worker-2` | 172.28.0.11 | - | WhatsApp session 2 |
| `worker-3` | 172.28.0.12 | - | WhatsApp session 3 |

---

## 🔐 Security Checklist

- [ ] Changed `API_KEY` from default
- [ ] Changed `WEBHOOK_SECRET` from default
- [ ] Firewall: Only port 3000 exposed (if needed)
- [ ] Redis not exposed to internet
- [ ] Using `socks5h://` for proxies (DNS through proxy)
- [ ] `.env` file not committed to git

---

## 📱 Adding WhatsApp Sessions

### Option 1: Via Dashboard
1. Open `http://YOUR_SERVER:3000/scan`
2. Click "הוסף סשן חדש"
3. Scan QR with WhatsApp
4. Session auto-connects

### Option 2: Via API
```bash
curl -X POST http://localhost:3000/api/sessions/allocate \
  -H "X-API-KEY: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "my_session_1"}'
```

### Option 3: Via Docker (Manual)
```bash
docker run -d --restart unless-stopped \
  --name wa_session_manual \
  --network whatsapp-network \
  -v $(pwd)/sessions/manual:/app/sessions/manual \
  -e SESSION_ID="manual" \
  -e PROXY_URL="socks5h://user:pass@proxy:port" \
  -e WEBHOOK_URL="http://172.28.0.3:3000/api/webhook" \
  -e WEBHOOK_SECRET="your-webhook-secret" \
  whatsapp-worker-image:1.0.0
```

---

## 🔄 Daily Operations

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f orchestrator
docker-compose logs -f worker-1
```

### Restart Services
```bash
# All
docker-compose restart

# Specific
docker-compose restart orchestrator
```

### Update Code
```bash
git pull
docker-compose down
docker-compose build
docker-compose up -d
```

### Manual Backup
```bash
curl -X POST http://localhost:3000/api/v1/backups/create \
  -H "X-API-KEY: your-api-key"
```

---

## 📊 Monitoring

### Health Endpoints
```bash
# Server health
curl http://localhost:3000/health

# Dashboard stats
curl http://localhost:3000/api/v1/dashboard/stats \
  -H "X-API-KEY: your-api-key"

# Session list
curl http://localhost:3000/api/v1/dashboard/sessions \
  -H "X-API-KEY: your-api-key"
```

### Dashboard URLs
- Main: `http://YOUR_SERVER:3000/`
- QR Scan: `http://YOUR_SERVER:3000/scan`
- Live Logs: `http://YOUR_SERVER:3000/live-log`
- Anti-Ban: `http://YOUR_SERVER:3000/anti-ban`

---

## 🛠️ Troubleshooting

### Redis Connection Error
```bash
# Check Redis is running
docker-compose ps redis

# Test connection
docker exec -it wa_redis redis-cli ping
```

### Worker Not Connecting
```bash
# Check worker logs
docker logs wa_session_<ID>

# Verify proxy
curl --proxy socks5h://user:pass@proxy:port https://api.ipify.org
```

### Session Stuck on QR
- Check webhook URL is correct
- Verify WEBHOOK_SECRET matches
- Check orchestrator logs for webhook errors

### High Memory Usage
```bash
# Check container stats
docker stats

# Restart specific worker
docker restart wa_session_<ID>
```

---

## 📞 Telegram Alerts Setup

### 1. Create Bot
1. Message `@BotFather` on Telegram
2. Send `/newbot`
3. Copy the token

### 2. Get Chat ID
1. Message `@userinfobot`
2. It will reply with your chat ID

### 3. Configure
```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=987654321
```

### 4. Test
```bash
curl -X POST http://localhost:3000/api/v1/alerts/telegram/test \
  -H "X-API-KEY: your-api-key"
```

---

## 🔄 Backup & Restore

### Automatic Backups
- Runs daily at **3:00 AM**
- Stored in `./backups/`
- Keeps last **7 backups**

### Manual Backup
```bash
curl -X POST http://localhost:3000/api/v1/backups/create \
  -H "X-API-KEY: your-api-key"
```

### List Backups
```bash
curl http://localhost:3000/api/v1/backups \
  -H "X-API-KEY: your-api-key"
```

### Restore
```bash
curl -X POST http://localhost:3000/api/v1/backups/restore \
  -H "X-API-KEY: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"backupName": "sessions_backup_2025-01-01.zip"}'
```

---

## 📝 Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 3000 | Server port |
| `API_KEY` | **Yes** | - | API authentication |
| `WEBHOOK_SECRET` | **Yes** | - | Worker webhook auth |
| `REDIS_URL` | Yes | redis://localhost:6379 | Redis connection |
| `TELEGRAM_BOT_TOKEN` | No | - | Telegram alerts |
| `TELEGRAM_CHAT_ID` | No | - | Telegram chat |
| `TELEGRAM_INCIDENT_ALERTS_ENABLED` | No | false | Send Telegram only when important incidents happen |
| `TELEGRAM_INCIDENT_POLL_INTERVAL_MS` | No | 5000 | Polling interval for incident->Telegram bridge |
| `TELEGRAM_JOB_ALERTS_ENABLED` | No | false | Notify only on Job lifecycle events (JOB_ACCEPTED / JOB_DONE) |
| `TELEGRAM_JOB_POLL_INTERVAL_MS` | No | 5000 | Polling interval for jobs->Telegram bridge |
| `MAX_SESSIONS_PER_PROXY` | No | 4 | Anti-ban limit |
| `PING_TIMEOUT_MS` | No | 180000 | Session health check |
| `WATCHDOG_INTERVAL_MS` | No | 60000 | Health check interval |
| `SESSION_BRAIN_URL` | No | - | Session Brain base URL (e.g. http://127.0.0.1:9000) |
| `SESSION_BRAIN_ENFORCER_ENABLED` | No | false | Auto-apply Session Brain decisions (block_ip => burn proxy + migrate sessions) |
| `SESSION_BRAIN_ENFORCER_INTERVAL_MS` | No | 15000 | Enforcer polling interval |

---

## 🆘 Support

- Check `docs/` folder for detailed architecture
- Review logs: `docker-compose logs -f`
- Telegram alerts for real-time monitoring


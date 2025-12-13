# 📱 WhatsApp Orchestrator

מערכת ניהול סשנים של WhatsApp עם אנטי-באן מובנה.

## ✨ Features

- **24/7 Server** - שרת ממתין לקריאות כל הזמן
- **Session Isolation** - קונטיינר אחד = סשן אחד (בידוד מלא)
- **Learning System** - Trust Levels (Cold → Warm → Hot)
- **Sticky IP** - פרוקסי קבוע לכל מספר טלפון
- **Anti-Ban** - Rate limiting, jitter, gradual warmup
- **Keep-Alive** - Presence updates, hidden messages
- **Auto-Backup** - גיבוי יומי אוטומטי (03:00)
- **Telegram Alerts** - התראות בזמן אמת
- **Dashboard** - ממשק ניהול ויזואלי
- **Watchdog** - מעקב אוטומטי ו-restart
- **AI Ready** - API מוכן לאינטגרציה עם ChatGPT

## 🚀 Quick Start

```bash
# Clone
git clone <YOUR_REPO_URL> whatsapp-orchestrator
cd whatsapp-orchestrator

# Setup
./scripts/setup.sh   # Creates .env with secure secrets

# Configure
nano .env            # Add your proxies

# Deploy
./scripts/deploy.sh  # Builds and starts everything
```

## 📁 Project Structure

```
├── src/                    # Orchestrator source
│   ├── services/           # Business logic
│   ├── routes/             # API endpoints
│   └── public/             # Dashboard UI
├── docker-wa-worker/       # Worker (Baileys)
├── docs/                   # Documentation
├── scripts/                # Deployment scripts
├── docker-compose.yml      # Production setup
└── DEPLOYMENT.md           # Full deployment guide
```

## 🔗 URLs (after deployment)

| URL | Description |
|-----|-------------|
| `http://SERVER:3000/` | Dashboard |
| `http://SERVER:3000/scan` | QR Scanner |
| `http://SERVER:3000/live-log` | Live Logs |
| `http://SERVER:3000/anti-ban` | Anti-Ban Settings |

## 📚 Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) - Full deployment guide
- [docs/SYSTEM_OVERVIEW.md](docs/SYSTEM_OVERVIEW.md) - **System overview (24/7, isolation, learning)**
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - System architecture
- [docs/PROXY_ARCHITECTURE.md](docs/PROXY_ARCHITECTURE.md) - Proxy management
- [docs/SCAN_FLOW_SPEC.md](docs/SCAN_FLOW_SPEC.md) - Session creation flow
- [API.md](API.md) - API documentation
- [ORCHESTRATOR.md](ORCHESTRATOR.md) - Orchestrator spec

## 🔐 Security

- API Key authentication
- Webhook secret validation
- Proxy via `socks5h://` (DNS through proxy)
- Session isolation (1 container = 1 session)

## 📊 Architecture

```
Client → Gateway → Dispatcher → Orchestrator → Workers → WhatsApp
                      ↓              ↓
                   Anti-Ban     Session Registry
                   (RPM/Jitter) (Sticky IP)
```

## 🛠️ Requirements

- Docker 20.10+
- Docker Compose 2.0+
- 4GB RAM minimum

## 📝 License

Private - All rights reserved

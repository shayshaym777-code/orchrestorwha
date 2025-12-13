#!/bin/bash
# =====================================================
# WhatsApp Orchestrator - First-Time Setup Script
# =====================================================

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   WhatsApp Orchestrator - First-Time Setup${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"

# Generate random secrets
generate_secret() {
    openssl rand -hex 32 2>/dev/null || cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 64 | head -n 1
}

# Create .env if not exists
if [ ! -f ".env" ]; then
    echo -e "\n${YELLOW}📝 Creating .env file...${NC}"
    
    API_KEY=$(generate_secret)
    WEBHOOK_SECRET=$(generate_secret)
    
    cat > .env << EOF
# =====================================================
# WhatsApp Orchestrator - Environment Configuration
# Generated: $(date)
# =====================================================

# Server
PORT=3000
NODE_ENV=production

# Security (auto-generated)
API_KEY=${API_KEY}
WEBHOOK_SECRET=${WEBHOOK_SECRET}

# Redis (Docker internal)
REDIS_URL=redis://172.28.0.2:6379

# Telegram Alerts (optional - configure manually)
# TELEGRAM_BOT_TOKEN=your-bot-token
# TELEGRAM_CHAT_ID=your-chat-id

# Backup
SESSIONS_DIR=./sessions
BACKUPS_DIR=./backups
MAX_BACKUPS=7

# Anti-Ban
MAX_SESSIONS_PER_PROXY=4
PING_TIMEOUT_MS=180000
WATCHDOG_INTERVAL_MS=60000

# Proxies (configure manually)
# Format: socks5h://user:pass@host:port
# PROXY_URL_1=socks5h://...
# PROXY_URL_2=socks5h://...
# PROXY_URL_3=socks5h://...
EOF
    
    echo -e "${GREEN}✅ Created .env with secure random secrets${NC}"
    echo -e ""
    echo -e "${YELLOW}📋 Your credentials:${NC}"
    echo -e "   API_KEY: ${API_KEY:0:20}..."
    echo -e "   WEBHOOK_SECRET: ${WEBHOOK_SECRET:0:20}..."
    echo -e ""
    echo -e "${YELLOW}⚠️  Save these credentials securely!${NC}"
else
    echo -e "${GREEN}✅ .env already exists${NC}"
fi

# Create directories
echo -e "\n${YELLOW}📁 Creating directories...${NC}"
mkdir -p sessions backups logs scripts
chmod 755 scripts/*.sh 2>/dev/null || true
echo -e "${GREEN}✅ Directories created${NC}"

# Summary
echo -e "\n${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Setup complete!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e ""
echo -e "${YELLOW}Next steps:${NC}"
echo -e "   1. Edit .env and add your proxy URLs"
echo -e "   2. (Optional) Add Telegram bot credentials"
echo -e "   3. Run: ./scripts/deploy.sh"
echo -e ""


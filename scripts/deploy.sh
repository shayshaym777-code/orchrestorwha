#!/bin/bash
# =====================================================
# WhatsApp Orchestrator - Deployment Script
# =====================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   WhatsApp Orchestrator - Deployment Script${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  echo -e "${YELLOW}⚠️  Running as root. Consider using a non-root user.${NC}"
fi

# Check Docker
echo -e "\n${YELLOW}📋 Checking prerequisites...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install Docker first.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Docker found${NC}"

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ Docker Compose not found. Please install Docker Compose.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Docker Compose found${NC}"

# Check .env file
if [ ! -f ".env" ]; then
    echo -e "\n${YELLOW}📝 Creating .env from template...${NC}"
    if [ -f "env.example" ]; then
        cp env.example .env
        echo -e "${GREEN}✅ Created .env from env.example${NC}"
        echo -e "${RED}⚠️  IMPORTANT: Edit .env with your actual values!${NC}"
        echo -e "   nano .env"
        exit 1
    else
        echo -e "${RED}❌ env.example not found${NC}"
        exit 1
    fi
fi
echo -e "${GREEN}✅ .env file exists${NC}"

# Check required env vars
echo -e "\n${YELLOW}🔐 Checking environment variables...${NC}"

source .env 2>/dev/null || true

if [ -z "$API_KEY" ] || [ "$API_KEY" == "change-me-api-key" ]; then
    echo -e "${RED}❌ API_KEY not set or using default value${NC}"
    echo -e "   Edit .env and set a secure API_KEY"
    exit 1
fi
echo -e "${GREEN}✅ API_KEY configured${NC}"

if [ -z "$WEBHOOK_SECRET" ] || [ "$WEBHOOK_SECRET" == "change-me-webhook-secret" ]; then
    echo -e "${RED}❌ WEBHOOK_SECRET not set or using default value${NC}"
    echo -e "   Edit .env and set a secure WEBHOOK_SECRET"
    exit 1
fi
echo -e "${GREEN}✅ WEBHOOK_SECRET configured${NC}"

# Create directories
echo -e "\n${YELLOW}📁 Creating directories...${NC}"
mkdir -p sessions backups logs
echo -e "${GREEN}✅ Directories created${NC}"

# Pull/Build images
echo -e "\n${YELLOW}🐳 Building Docker images...${NC}"

if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    COMPOSE_CMD="docker-compose"
fi

$COMPOSE_CMD build --no-cache

echo -e "${GREEN}✅ Images built${NC}"

# Stop existing containers
echo -e "\n${YELLOW}🛑 Stopping existing containers...${NC}"
$COMPOSE_CMD down 2>/dev/null || true
echo -e "${GREEN}✅ Stopped${NC}"

# Start services
echo -e "\n${YELLOW}🚀 Starting services...${NC}"
$COMPOSE_CMD up -d

# Wait for health
echo -e "\n${YELLOW}⏳ Waiting for services to be healthy...${NC}"
sleep 10

# Check health
HEALTH=$(curl -s http://localhost:3000/health 2>/dev/null || echo "failed")

if [[ "$HEALTH" == *"ok"* ]]; then
    echo -e "${GREEN}✅ Orchestrator is healthy!${NC}"
else
    echo -e "${RED}❌ Health check failed. Check logs:${NC}"
    echo -e "   $COMPOSE_CMD logs orchestrator"
    exit 1
fi

# Summary
echo -e "\n${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🎉 Deployment Complete!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════${NC}"
echo -e ""
echo -e "📊 Dashboard:    http://localhost:3000/"
echo -e "📱 QR Scanner:   http://localhost:3000/scan"
echo -e "📜 Live Logs:    http://localhost:3000/live-log"
echo -e "🛡️  Anti-Ban:     http://localhost:3000/anti-ban"
echo -e ""
echo -e "📋 Useful commands:"
echo -e "   $COMPOSE_CMD logs -f          # View logs"
echo -e "   $COMPOSE_CMD ps               # List services"
echo -e "   $COMPOSE_CMD restart          # Restart all"
echo -e ""
echo -e "${YELLOW}⚠️  Next steps:${NC}"
echo -e "   1. Configure Telegram alerts (optional)"
echo -e "   2. Add proxies to the pool"
echo -e "   3. Create WhatsApp sessions via /scan"
echo -e ""


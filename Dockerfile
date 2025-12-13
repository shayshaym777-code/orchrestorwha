# =====================================================
# WhatsApp Orchestrator - Dockerfile
# =====================================================

FROM node:18-alpine

# Install dependencies for healthcheck and dockerode
RUN apk add --no-cache curl docker-cli

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY docs/ ./docs/

# Create directories
RUN mkdir -p sessions backups logs

# Environment
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start server
CMD ["node", "src/server.js"]


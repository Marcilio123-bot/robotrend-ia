# ============================================================
# Robotrend IA — Dockerfile production-grade (multi-stage)
# Build context: raiz do projeto (..)
# ============================================================

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ \
 && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund) \
 && npm cache clean --force \
 && apk del python3 make g++

FROM node:20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tini wget tzdata \
 && cp /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime \
 && echo "America/Sao_Paulo" > /etc/timezone

ENV NODE_ENV=production
ENV TZ=America/Sao_Paulo
ENV LOG_LEVEL=info

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN mkdir -p logs \
 && chown -R node:node /app

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3010/healthz || exit 1

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node", "backend/server.js"]

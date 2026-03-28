# ── Single stage build (simpler, uses tsx at runtime) ─────────────
FROM node:22-slim

WORKDIR /app

# Copy everything
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Install all dependencies
RUN npm ci

# Build shared types
RUN npm run build --workspace=shared

# Build client (Vite static files)
RUN npm run build --workspace=client

# Server runs via tsx (no tsc build needed — same as dev)
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/data/audioserver.db

EXPOSE 3001

VOLUME /data
VOLUME /music

CMD ["node", "--import", "tsx/esm", "server/src/index.ts"]

# ── Simple build without librespot (add later) ──────────────────
FROM node:22-slim

# Install ffmpeg for audio transcoding
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

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

ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/data/audioserver.db

EXPOSE 3001

VOLUME /data
VOLUME /music

CMD ["node", "--import", "tsx/esm", "server/src/index.ts"]

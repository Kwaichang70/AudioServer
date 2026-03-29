# ── Build librespot from source ───────────────────────────────────
FROM rust:slim-bookworm AS librespot-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Try version 0.6.0, fall back to 0.5.0, create dummy if both fail
RUN cargo install librespot@0.6.0 2>/dev/null \
    || cargo install librespot@0.5.0 2>/dev/null \
    || touch /usr/local/cargo/bin/librespot

# ── Main application ─────────────────────────────────────────────
FROM node:22-slim

# Install ffmpeg + audio libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Copy librespot binary (might be dummy if build failed)
COPY --from=librespot-build /usr/local/cargo/bin/librespot /usr/local/bin/librespot
RUN chmod +x /usr/local/bin/librespot 2>/dev/null || true

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

# ───── librespot builder ──────────────────────────────────────────
# Build the Spotify Connect receiver once, then copy only the binary into the
# runtime image. The Rust toolchain stays out of production.
FROM rust:slim-bookworm AS librespot-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates pkg-config libasound2-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# The app uses librespot as a pipe backend receiver. Keep this pinned because
# newer librespot releases can move Rust/audio dependencies underneath us.
RUN cargo install librespot@0.5.0-dev

# ───── builder ───────────────────────────────────────────────────
# Heavy stage: full toolchain for native dep builds + a full npm install.
# Discarded once the runtime stage copies what it needs.
FROM node:22-slim AS builder

# python3 + make + g++ let better-sqlite3 fall back to node-gyp source build
# when the prebuilt binary download times out (observed on NAS networks).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

RUN npm ci
RUN npm run build --workspace=shared
RUN npm run build --workspace=client

# Strip devDependencies after the build so the runtime image carries only
# what the server actually needs. tsx now lives in server's dependencies
# (we run with `node --import tsx/esm`), so it survives the prune.
RUN npm prune --omit=dev

# ───── runtime ───────────────────────────────────────────────────
# Lean stage: ffmpeg (audio passthroughs), curl (healthcheck), and the
# runtime libraries needed by the copied librespot binary.
# No python3, no make, no g++, no client toolchain.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl ca-certificates libasound2 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=librespot-builder /usr/local/cargo/bin/librespot /usr/local/bin/librespot

WORKDIR /app

# Workspace manifests + lockfile (npm uses these to resolve the workspace
# symlinks at runtime even though we don't reinstall).
COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.base.json ./

# Pruned production node_modules (workspaces hoisted at the root).
COPY --from=builder /app/node_modules ./node_modules

# Server runs straight from .ts via tsx/esm, so we need the source.
COPY --from=builder /app/server ./server

# Shared workspace: package.json + built dist (server imports from it).
COPY --from=builder /app/shared/package.json ./shared/package.json
COPY --from=builder /app/shared/dist ./shared/dist

# Client: only the built bundle (express.static serves this). Keep the
# workspace's package.json so npm's symlink resolution stays consistent.
COPY --from=builder /app/client/package.json ./client/package.json
COPY --from=builder /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/data/audioserver.db

EXPOSE 3001

VOLUME /data
VOLUME /music

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:3001/api/health || exit 1

CMD ["node", "--import", "tsx/esm", "server/src/index.ts"]

# ───── librespot builder ──────────────────────────────────────────
# Build the Spotify Connect receiver once, then copy only the binary into the
# runtime image. The Rust toolchain stays out of production.
ARG NODE_IMAGE=node:22-slim
ARG RUST_IMAGE=rust:slim-bookworm
FROM ${RUST_IMAGE} AS librespot-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates pkg-config libasound2-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# The app uses librespot as a pipe backend receiver. `--locked` is important:
# librespot 0.8.0 currently fails if Cargo re-resolves transitive build deps.
RUN cargo install --locked librespot@0.8.0

# ───── builder ───────────────────────────────────────────────────
# Heavy stage: full toolchain for native dep builds + a full npm install.
# Discarded once the runtime stage copies what it needs.
FROM ${NODE_IMAGE} AS builder

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
# Stale incremental-build caches make tsc think everything is already built
# and emit NOTHING (shared/dist then never exists and the image COPY fails).
# .dockerignore excludes them too; this is the belt-and-braces for contexts
# where an old cache was rsynced in (the NAS overlay deploy).
RUN find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
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
FROM ${NODE_IMAGE}

ARG BUILD_DATE=unknown
ARG VCS_REF=unknown
ARG VERSION=0.1.0

LABEL org.opencontainers.image.title="AudioServer" \
      org.opencontainers.image.description="Self-hosted music streamer with local library, Qobuz playback, and multi-room output" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.source="https://github.com/Kwaichang70/AudioServer"

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

# ── Build stage ────────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/

# Install all dependencies
RUN npm ci

# Copy source
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Build shared types
RUN npm run build --workspace=shared

# Build client (static files)
RUN npm run build --workspace=client

# Build server
RUN npm run build --workspace=server

# ── Production stage ──────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace=server --workspace=shared

# Copy built artifacts
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

# Serve client static files from the server
ENV NODE_ENV=production
ENV PORT=3001
ENV DATABASE_PATH=/data/audioserver.db

EXPOSE 3001

# Data volume for SQLite DB
VOLUME /data

# Music library mount point
VOLUME /music

CMD ["node", "server/dist/index.js"]

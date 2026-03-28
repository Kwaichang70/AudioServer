# ── Build stage ────────────────────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Copy all package files
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Install all dependencies
RUN npm ci

# Build shared types first (server depends on them)
RUN npm run build --workspace=shared

# Copy shared dist into node_modules so server can find @audioserver/shared
RUN cp -r shared/dist shared/package.json node_modules/@audioserver/shared/ 2>/dev/null || \
    mkdir -p node_modules/@audioserver/shared && \
    cp -r shared/dist node_modules/@audioserver/shared/ && \
    cp shared/package.json node_modules/@audioserver/shared/

# Build server
RUN npm run build --workspace=server

# Build client (static files)
RUN npm run build --workspace=client

# ── Production stage ──────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN npm ci --omit=dev --workspace=server --workspace=shared

# Copy built shared types into node_modules
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/shared/package.json shared/
RUN cp -r shared/dist shared/package.json node_modules/@audioserver/shared/ 2>/dev/null || \
    mkdir -p node_modules/@audioserver/shared && \
    cp -r shared/dist node_modules/@audioserver/shared/ && \
    cp shared/package.json node_modules/@audioserver/shared/

# Copy built server and client
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

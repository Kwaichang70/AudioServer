# AudioServer

Self-hosted music streamer for a local NAS library, Qobuz full-track playback, streaming provider metadata, and multi-room output through browser, DLNA, Sonos, Volumio, and Spotify Connect helpers.

## Current Status

- Local library playback is the primary source.
- Qobuz is the preferred external full-playback source.
- Tidal is treated as catalog/metadata/preview-only.
- Spotify support is focused on OAuth/catalog/Spotify Connect flows; full generic browser streaming is not implemented.
- Synology/DiskStation deployment is supported through Docker Compose with host networking for DLNA/SSDP discovery.

## Quick Start

Install dependencies:

```bash
npm install
```

Start backend and frontend in development:

```bash
npm run dev
```

Development ports:

- Backend API: `http://localhost:3001`
- Vite frontend: `http://localhost:5173`

The backend must run through the ESM loader because `music-metadata` pulls in pure ESM dependencies:

```bash
node --import tsx/esm server/src/index.ts
node --import tsx/esm --watch server/src/index.ts
```

The workspace scripts already use the correct loader.

## Build And Test

Build all workspaces:

```bash
npm run build
```

Run tests directly per workspace:

```bash
cd server && npx vitest run
cd client && npx vitest run
```

Run focused tests:

```bash
cd server && npx vitest run src/__tests__/scanner.test.ts
cd client && npx vitest run src/context/__tests__/AudioContext.test.tsx
```

Production client builds generate `.gz` and `.br` compressed static assets for JS, CSS, HTML, SVG, and JSON files larger than 1 KB. Express still serves the normal files directly; reverse proxies can be configured later to prefer the precompressed variants.

## Project Structure

```text
shared/  TypeScript domain types and provider/device interfaces
server/  Express API, SQLite/Drizzle, Socket.IO, scanner, providers, devices
client/  React/Vite/Tailwind single-page app
data/    Local development database/covers, ignored by deployment workflows
```

Key patterns:

- Providers implement `MusicProvider` or `AuthenticatedMusicProvider`.
- Output devices implement `DeviceController`.
- Local NAS paths use forward slashes. UNC paths should be written like `//diskstation/Music`; avoid `path.join()` for UNC construction.
- The production server serves the built client from `client/dist`.

## Environment

Copy `.env.example` to `.env` for local development.

Required production values:

```env
NODE_ENV=production
PORT=3001
DATABASE_PATH=/data/audioserver.db
MUSIC_LIBRARY_PATHS=/music
JWT_SECRET=replace-with-openssl-rand-hex-32
```

Recommended logging:

```env
LOG_FORMAT=json
LOG_LEVEL=info
```

Development defaults to `LOG_FORMAT=text` and `LOG_LEVEL=debug`; production defaults to `json/info`.

Qobuz full playback:

```env
QOBUZ_APP_ID=your-app-id
QOBUZ_APP_SECRET=your-app-secret
QOBUZ_AUDIO_FORMAT=5
```

Optional auto-login:

```env
QOBUZ_USERNAME=your-qobuz-email
QOBUZ_PASSWORD=your-qobuz-password
```

If username/password are omitted, log in through Settings. The app stores only the Qobuz user auth token and account metadata, not the password.

Qobuz formats:

```text
5  MP3 320, most compatible
6  FLAC 16/44.1
7  FLAC 24/96
27 FLAC 24/192
```

Device hints:

```env
DLNA_DEVICES=192.168.2.42:49152,192.168.2.27:1400
VOLUMIO_DEVICES=192.168.2.50:3000
WATCH_LIBRARY=true
```

## Docker

Build and run locally:

```bash
MUSIC_PATH=/path/to/music docker compose up -d --build
```

Synology-style command:

```bash
cd /volume1/docker/AudioServer
sudo /usr/local/bin/docker-compose -f docker-compose.yml up -d --build
```

Health check:

```bash
curl -s http://localhost:3001/api/health
```

Docker notes:

- `network_mode: host` is intentional for DLNA/SSDP multicast discovery.
- The runtime image includes `ffmpeg`, `curl`, and a copied `librespot` binary.
- Build metadata is attached as OCI labels using `VERSION`, `VCS_REF`, and `BUILD_DATE` build args.
- Node is major-pinned through the `NODE_IMAGE` build arg. Rust remains on `rust:slim-bookworm` because librespot source builds have been sensitive to toolchain/dependency resolution. Update base images deliberately, then rebuild and run the test/build suite before publishing.

Example labeled build:

```bash
VCS_REF=$(git rev-parse --short HEAD) BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) docker compose build
```

On Windows PowerShell:

```powershell
$env:VCS_REF = git rev-parse --short HEAD
$env:BUILD_DATE = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
docker compose build
```

## Synology Deployment

Use [DEPLOY_SYNOLOGY.md](DEPLOY_SYNOLOGY.md) as the runbook. The short version:

```powershell
git archive --format=tar --output C:\tmp\audioserver-qobuz.tar HEAD
scp C:\tmp\audioserver-qobuz.tar Danny-a@192.168.2.58:/tmp/audioserver-qobuz.tar
```

Then on the NAS:

```bash
cd /volume1/docker/AudioServer
sudo tar -xf /tmp/audioserver-qobuz.tar -C /volume1/docker/AudioServer
sudo /usr/local/bin/docker-compose -f docker-compose.yml up -d --build
curl -s http://localhost:3001/api/health
```

## Troubleshooting

White screen with asset `500` errors:

- Check CORS/allowed origins in server logs.
- Use the same host/origin for HTML and static assets, for example `http://diskstation:3001`.

Qobuz cannot stream:

- Check `/api/providers/qobuz/status`.
- Confirm `QOBUZ_APP_ID` and `QOBUZ_APP_SECRET`.
- Confirm account login in Settings or env credentials.

No devices found:

- Keep Docker host networking enabled.
- Add `DLNA_DEVICES` or `VOLUMIO_DEVICES` for direct probing if multicast is blocked.

Scanner finds no music:

- Confirm `MUSIC_LIBRARY_PATHS`.
- In Docker, confirm the host music path is mounted to `/music`.
- Check `/api/library/scan/status` or Settings scan progress.

## Sprint Status

See [SPRINT_AUDIT.md](SPRINT_AUDIT.md) for the current sprint audit and remaining work.

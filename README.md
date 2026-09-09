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

First start (no accounts yet): the server prints a one-time **setup code** to
its log and writes it to `setup-code.txt` next to the database. Open the app,
choose a username and password and enter that code to create the admin
account. Until then only the setup screen and the health probes are reachable.
Set `SETUP_CODE` in the environment to choose the code yourself. Further
accounts are created by an admin in Settings; roles are described in
[docs/permissions.md](docs/permissions.md).

The HTTP API is described by an OpenAPI 3.1 document at `GET /api/openapi.json`
(public — no auth). Paste it into [editor.swagger.io](https://editor.swagger.io)
or Postman to browse the endpoints, request bodies, and auth schemes.

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

Optional: `SETUP_CODE=...` fixes the first-run setup code instead of generating
one (only used while no account exists).

Server-driven playback on speakers (`docs/architecture.md`, "Server-driven
playback"): `PLAYBACK_UNPLAYABLE_POLICY=skip|stop` decides what the NAS does
with a track it cannot play on the speaker (default skip, max 3 in a row);
`PLAYBACK_RESUME_ON_RESTART=true` restarts the current track after a server
restart when the speaker is idle (default: restore the queue, wait for a tap).

Library changes (`docs/architecture.md`, "Library preservation"): a moved or
renamed file keeps its track, playlists, favorites and history when its
signature (size, length, tags) matches exactly one known track whose old file
is gone; a file that disappeared is marked missing, never deleted, until an
admin clicks "Clean up missing" in Settings. `WATCH_LIBRARY=true` rescans a
few seconds after files change; every scan is recorded and shown in Settings.

Search (`docs/architecture.md`, "Search"): results from every source are
merged per recording, with live, remastered and radio-edit versions kept
apart and each source's own id remembered, so "play from Qobuz" plays the
version you chose. Filters: sources, Lossless, Hi-Res. A slow or broken
streaming source is named in the results instead of hiding the local ones
(`SEARCH_PROVIDER_TIMEOUT_MS`, default 6000). `npm run bench:search
--workspace=server` measures local search on a synthetic 50 000-track library.

Listening history and scrobbling (`docs/architecture.md`, "Listening
sessions"): a listen counts once at least half the track, or four minutes,
was actually heard; pauses, seeks and skips do not count. Last.fm and
ListenBrainz get exactly one submission per listen. `SCROBBLE_SPOTIFY=true`
also submits Spotify listens (off by default, Spotify scrobbles them itself).

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
curl -s http://localhost:3001/api/health/live    # process alive (no DB access)
curl -s http://localhost:3001/api/health/ready   # 200 when the DB is open + migrated, else 503
curl -s http://localhost:3001/api/health         # full diagnostics; 503 when degraded
```

The Docker `HEALTHCHECK` uses `/api/health/ready`, so `docker ps` shows
`(healthy)` only once the database is usable.

Backup, restore, update and rollback (including the schema-version check that
makes a rollback safe) are in [docs/backup-restore.md](docs/backup-restore.md):

```bash
npm run db:backup --workspace=server -- /data/backups/before-update.db
npm run db:verify --workspace=server -- /data/backups/before-update.db
npm run db:restore --workspace=server -- /data/backups/before-update.db --yes   # server stopped
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

## Documentation

- [docs/architecture.md](docs/architecture.md) — system + request-lifecycle diagrams, module ownership, key design decisions.
- [docs/providers.md](docs/providers.md) — per-provider OAuth + scrobbling setup (Tidal, Spotify, Last.fm, ListenBrainz, Qobuz).
- [docs/backup-restore.md](docs/backup-restore.md) — database backup, restore, update and rollback runbook.
- [docs/permissions.md](docs/permissions.md) — what a regular user vs. an admin may do, and how sessions work.
- [SECURITY_AUDIT.md](SECURITY_AUDIT.md) — dependency audit with the assessment of every remaining finding.
- [CHANGELOG.md](CHANGELOG.md) — sprint-by-sprint history.

## Sprint Status

The current plan is [VERBETERPLAN_SPRINTS.md](VERBETERPLAN_SPRINTS.md) (sprints V01–V12, status per task inside the document). [SPRINT_AUDIT.md](SPRINT_AUDIT.md) is the audit of the earlier sprint series 8–20.

Every push runs the CI workflow (`.github/workflows/ci.yml`): clean install, lint, typecheck, tests and build on Node 22 and 24, then the production image is built, started, probed for readiness and stopped gracefully.

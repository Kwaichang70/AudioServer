# AudioServer

Self-hosted music streamer — a Roon alternative you run on your own NAS or VPS.
Combines a local library scanner with first-class support for Tidal, Spotify
(via Librespot), Qobuz, and Internet Radio, and pushes audio to browser, Sonos,
or any DLNA/UPnP renderer on your LAN.

> Status: under active development. Phase 1–4 (security foundation, stability,
> first Roon-feature-parity slice, performance polish) have shipped. See
> [CHANGELOG.md](./CHANGELOG.md) for the running history.

## Features

**Library**

- Recursive scanner for FLAC / MP3 / M4A / AAC / OGG / Opus / WAV / WMA / AIFF
- Per-track ReplayGain (track + album mode) with peak-aware clip protection
- Cover-art extraction from embedded tags + background fetch for missing art
- Artist images via Spotify (when configured)
- Smart playlists with rule-based filtering (genre, year, format, sample rate, bit depth, artist)
- Conventional playlists + M3U import/export
- Favorites for tracks / albums / artists

**Streaming providers**

- **Local** — your own files via SMB/NFS-mounted paths
- **Tidal** — OAuth2 + PKCE login; browse + play hi-res streams
- **Spotify** — via Librespot daemon (Spotify Connect receiver)
- **Qobuz** — present but disabled (Qobuz blocks external API access)
- **Internet Radio** — RadioBrowser API with Dutch-first curated list

**Playback**

- HTML5 audio with opt-in Web Audio chain for ReplayGain
- Crossfade between tracks (configurable seconds)
- Gapless playback for local files
- Multi-device output: browser, Sonos, generic DLNA/UPnP renderers
- Last.fm + ListenBrainz scrobbling with retry queue

**Auth & security**

- JWT-based authentication; first-run sets up the admin
- Signed stream tokens (HMAC, 1h TTL) for `<img>`/`<audio>` tags
- Strict CORS (allowlist) + Helmet headers
- Input validation via zod schemas on every mutation route
- Rate limiting (global + auth-specific)

**Frontend**

- React 19 + Vite + TailwindCSS
- Lazy-loaded route bundles, native `loading="lazy"` for cover art
- Auto-load-more via IntersectionObserver on lists
- Service worker with sensible cache invalidation
- PWA-ready (manifest + offline shell)

## Quick start (Docker — recommended)

```bash
cp .env.example .env       # edit values, see below
docker compose up -d --build
```

The container exposes port `3001`. Open `http://<host>:3001`, register the
first user (becomes admin), then add providers from Settings.

### Environment variables (`.env`)

| Variable                                      | Required   | Default                                       | Description                                                                                                                                                              |
| --------------------------------------------- | ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MUSIC_LIBRARY_PATHS`                         | Yes (prod) | `./test-music`                                | Comma-separated list of paths to scan. Use forward slashes for UNC paths: `//diskstation/Music`.                                                                         |
| `DATABASE_PATH`                               | No         | `/data/audioserver.db`                        | sqlite file. The `/data` volume persists across container restarts.                                                                                                      |
| `JWT_SECRET`                                  | Yes (prod) | dev-only auto-gen                             | 32+ char secret. `openssl rand -hex 32`.                                                                                                                                 |
| `ALLOWED_ORIGINS`                             | No         | `http://localhost:5173,http://127.0.0.1:5173` | CORS allowlist for the dev server. Same-origin always passes.                                                                                                            |
| `PORT`                                        | No         | `3001`                                        | HTTP port.                                                                                                                                                               |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | No         | —                                             | From [Spotify Developer Dashboard](https://developer.spotify.com). Note: Spotify rejects HTTP redirect URIs on LAN IPs since April 2025 — use HTTPS via a reverse proxy. |
| `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET`     | No         | —                                             | From [Tidal for Developers](https://developer.tidal.com).                                                                                                                |
| `LASTFM_API_KEY` / `LASTFM_API_SECRET`        | No         | —                                             | From [Last.fm API](https://www.last.fm/api).                                                                                                                             |
| `LISTENBRAINZ_TOKEN`                          | No         | —                                             | User-token from listenbrainz.org.                                                                                                                                        |
| `DLNA_DEVICES`                                | No         | `auto-discover`                               | Comma-separated `host:port` hints if SSDP discovery is unreliable.                                                                                                       |
| `VOLUMIO_DEVICES`                             | No         | —                                             | Same idea for Volumio endpoints.                                                                                                                                         |
| `WATCH_LIBRARY`                               | No         | `false`                                       | Filesystem watcher for incremental scans.                                                                                                                                |

## Quick start (bare metal)

```bash
npm install
npm run dev          # backend on :3001, vite dev server on :5173
```

The server requires the `tsx` ESM loader for `music-metadata` compatibility:

```bash
node --import tsx/esm --watch server/src/index.ts
```

The `npm run dev` script handles this automatically.

## Repository layout

Monorepo with npm workspaces:

```
shared/    # TypeScript types + interfaces (Track, Album, MusicProvider, …)
server/    # Express + SQLite (better-sqlite3 + Drizzle) + Socket.IO
client/    # React + Vite + TailwindCSS SPA
```

See [docs/architecture.md](./docs/architecture.md) for the data-flow diagram.

## Tests

```bash
cd server && npm test    # vitest + supertest integration tests
cd client && npm test    # vitest + React Testing Library
```

## Tooling

- **TypeScript** strict mode across all workspaces (`npm run typecheck`)
- **ESLint 9** flat config + Prettier (`npm run lint`, `npm run format`)
- **Husky + lint-staged** pre-commit hook
- **GitHub Actions** CI: lint → typecheck → tests → build

## License

Private project. Not yet released.

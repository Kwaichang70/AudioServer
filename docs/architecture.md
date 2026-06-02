# Architecture

High-level overview of how the AudioServer pieces fit together. See the
[README](../README.md) for a feature-list and quick start; this document
focuses on the data flow.

## System diagram

```mermaid
graph TB
  subgraph Client["Client (React 19 SPA)"]
    UI[Pages + Components]
    AC[AudioContext + ProgressStore]
    APIC["api/client.ts<br/>(Bearer + stream-token)"]
    SW["Service Worker<br/>(cover cache)"]
  end

  subgraph Server["Server (Express + tsx/esm)"]
    MW["Middleware chain<br/>helmet → cors(/api) → json → ratelimit → requestLogger → attachUser → requireAuth"]
    R[/Routes/]
    SVC["Services<br/>scanner / playback / scrobbler / coverart / librespot"]
    SIO[Socket.IO]
    ERR[errorHandler + notFoundHandler]
  end

  subgraph Storage
    DB[(SQLite<br/>better-sqlite3 + Drizzle)]
    FS[/Music files<br/>NAS / local FS/]
    VOL[/audioserver-data volume/]
  end

  subgraph External
    TIDAL[Tidal API]
    SPOT["Spotify (Librespot subprocess)"]
    LFM[Last.fm / ListenBrainz]
    DLNA[DLNA / Sonos renderers on LAN]
  end

  UI --> AC
  AC --> APIC
  UI --> APIC
  APIC -->|HTTP + JWT| MW
  MW --> R
  R --> SVC
  R --> DB
  SVC --> DB
  SVC --> FS
  SVC --> TIDAL
  SVC --> SPOT
  SVC --> LFM
  SIO -->|device events| AC
  SVC --> SIO
  SVC --> DLNA
  SW -.->|caches| APIC
  DB --> VOL
```

## Request lifecycle (typical /api call)

```mermaid
sequenceDiagram
  participant B as Browser
  participant SW as Service Worker
  participant E as Express
  participant H as Route handler
  participant D as SQLite
  participant S as Socket.IO

  B->>SW: GET /api/library/albums?page=1
  SW->>E: Forward (network-first)
  E->>E: helmet → cors(/api) → json → rate-limit → requestLogger
  E->>E: attachUser (parse JWT)
  E->>E: requireAuth (skip non-/api; allow public paths)
  E->>H: Route matches /library/albums
  H->>D: SELECT id, title, ... FROM albums LIMIT ? OFFSET ?
  D-->>H: rows
  H-->>B: 200 { data, meta }
  Note over S: Socket.IO is separate;<br/>device updates push state to subscribed clients
```

## Module ownership

### `server/src/`

| Folder              | Purpose                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`         | zod-validated env loading. Fails fast on missing/weak `JWT_SECRET` in prod.                                                                                                                                                                     |
| `db/`               | Drizzle schema + sqlite init. Lightweight `runMigration()` helper for column adds on existing DBs.                                                                                                                                              |
| `middleware/`       | `auth.ts` (attachUser + requireAuth + signed stream tokens), `errorHandler.ts`, `rateLimiter.ts`, `requestLogger.ts`.                                                                                                                           |
| `routes/`           | One file per `/api/<area>` namespace. Each route uses `validate({ body })` from `utils/validate.ts` for inputs.                                                                                                                                 |
| `services/`         | Long-lived singletons: `scanner` (library walker), `playback` (queue + state machine), `scrobbler` (Last.fm/ListenBrainz queue with retry), `coverart` / `coverart-fetch`, `device-monitor` (DLNA discovery), `librespot` (subprocess manager). |
| `providers/`        | `MusicProvider` implementations: `local`, `tidal`, `spotify`, `qobuz` (disabled). The registry exposes `getActiveProviders()` for merged search.                                                                                                |
| `socketio.ts`       | WebSocket init + namespacing for device + scan progress events.                                                                                                                                                                                 |
| `utils/validate.ts` | zod request validation middleware.                                                                                                                                                                                                              |

### `client/src/`

| Folder                     | Purpose                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/client.ts`            | Single `fetchApi` wrapper that attaches Bearer + handles `ApiError`. Plus stream-token cache for `<img>`/`<audio>` URLs.                                             |
| `context/AudioContext.tsx` | Playback orchestrator. Currently centralised; `currentTime/duration` was split out to `ProgressStore.ts` to avoid re-rendering the whole tree on every `timeupdate`. |
| `hooks/useAudio.ts`        | Web Audio chain + crossfade + ReplayGain. Only attaches `createMediaElementSource` for same-origin URLs (CORS would silence cross-origin streams).                   |
| `hooks/useInfiniteLoad.ts` | Paginated list state + `useAutoLoadMore` (IntersectionObserver).                                                                                                     |
| `hooks/useSocket.ts`       | Socket.IO client + device-event distribution.                                                                                                                        |
| `pages/`                   | Route-level components. Lazy-loaded via `React.lazy`.                                                                                                                |
| `components/`              | Shared UI: NowPlayingBar / NowPlayingFull, AlbumCover, ErrorBoundary, Toast, DeviceSelector, SortableList.                                                           |
| `public/sw.js`             | Service worker: network-first for shell, cache-first for covers (with `?t=` token stripped from cache keys).                                                         |

### `shared/src/`

Type-only package. `Track`, `Album`, `Artist`, `Playlist`, `NowPlaying`,
`MusicProvider`, `DeviceController`. Resolved by the client via Vite `paths`
alias to source (no dist build required at consumer time).

## Key design decisions

**Provider pattern.** Every music source implements `MusicProvider`
(`shared/src/provider.ts`). The registry's `searchAll()` fans out to all
authenticated providers in parallel and merges results with a priority order
(local > qobuz > tidal > spotify).

**Device pattern.** Every output target implements `DeviceController`
(`shared/src/device.ts`). Currently DLNA / Sonos. `playbackService` routes
play/pause/seek to the controller for the selected device, or to the browser
audio element directly.

**Auth surface.** Two hooks: `attachUser` (always-on, never fails — populates
`req.userId` if Bearer is valid) and `requireAuth` (gates `/api/*` paths
except `/api/auth/login`, `/auth/register`, `/auth/me`, `/health`). Signed
stream tokens cover the `<img>`/`<audio>` flow where the browser can't send
Authorization headers.

**SQLite + WAL.** Single-process app; better-sqlite3 in WAL mode is fast
enough for 10k+ tracks without a separate DB process. Drizzle ORM for typed
queries; raw SQL where pagination / aggregates need it.

**ESM end-to-end.** All workspaces `"type": "module"`. Server runs via
`node --import tsx/esm server/src/index.ts` — TS on-the-fly, no separate
build step in production.

**Web Audio for ReplayGain.** Opt-in: only active when the user picks a
non-`off` mode in Settings. The chain bypasses `<audio>.volume` and routes
through a `GainNode`. Cross-origin sources (Tidal/Spotify CDNs) skip the
chain because `MediaElementSource` outputs zeros without CORS headers.

## Deployment shapes

| Where                      | How                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Local dev                  | `npm run dev` (concurrently runs server + vite dev)                                |
| Production (single host)   | `docker compose up -d --build` — multi-stage build, ~300 MB image                  |
| Synology Container Manager | Same as production; bind `/volume1/music` read-only and a `data` volume for the DB |
| CI                         | GitHub Actions: lint → typecheck → tests → build. No image push (yet).             |

## Open architectural questions

These don't have a fixed answer yet and the codebase has placeholders:

- **Multi-room sync.** Currently each device plays independently. Roon-style
  zone groups (multiple devices with sub-250ms drift) would need an
  NTP-style sync model — likely a master-leader + corrections via
  Socket.IO timestamps.
- **MusicBrainz enrichment.** Per-album lookup for MBID + genre + label.
  Background queue with 1 req/s rate limit (MB policy).
- **Spotify Web API OAuth on HTTP LAN.** Blocked by Spotify's April 2025
  policy — they only accept HTTPS redirect URIs (or `localhost`). Workaround:
  reverse-proxy with TLS (Synology DSM has a Let's Encrypt integration).
- **OpenAPI spec.** Could be auto-generated from the existing zod schemas
  via `@asteasolutions/zod-to-openapi`. Would publish `/api/docs` as Swagger
  UI in non-prod.

# Changelog

A running log of the multi-sprint rework that took AudioServer from "runs on
my desk" to production-ready on the Synology. Sorted newest first. Tags are
the kind of change, not semver — there are no releases yet.

## Sprint 5 — Spotify everywhere + polish

**Spotify in the browser** ([b32592c](https://github.com/Kwaichang70/AudioServer/commit/b32592c), [d853f91](https://github.com/Kwaichang70/AudioServer/commit/d853f91))

- Web Playback SDK as a lazy in-tab Spotify Connect device ("AudioServer
  Web"). `player_state_changed` + a 1s poll drive progress / play-pause /
  auto-next. Needs Premium + HTTPS + a completed OAuth.

**OAuth, the long way** ([2eb7246](https://github.com/Kwaichang70/AudioServer/commit/2eb7246), [b0128e5](https://github.com/Kwaichang70/AudioServer/commit/b0128e5))

- Redirect URI uses the HTTPS origin verbatim (no more LAN-IP rewrite).
- Scopes trimmed to the Dev-Mode-allowed Web Playback SDK set — the
  library/playlist "browse" scopes make `/authorize` `server_error` outright
  since Spotify's March 2026 Dev-Mode changes. A legacy app stuck in a broken
  Dev-Mode state was replaced with a fresh one. See [synology-https.md](docs/synology-https.md).

**Multi-room Spotify** ([9593ab8](https://github.com/Kwaichang70/AudioServer/commit/9593ab8), [f7d9b09](https://github.com/Kwaichang70/AudioServer/commit/f7d9b09))

- Device picker lists real Spotify Connect devices (Sonos, CocktailAudio) as
  their own section; playing routes straight to them via `connectPlay` — no
  fuzzy name-matching, no librespot. Spotify's cloud streams to the speaker.
- External Connect playback polls Spotify's player state for a live transport
  UI and fail-safe auto-advance (single-track URIs would otherwise stop).

**Player fixes + bold icons** ([2482bd4](https://github.com/Kwaichang70/AudioServer/commit/2482bd4), [ce9c19a](https://github.com/Kwaichang70/AudioServer/commit/ce9c19a), [fcbfe3e](https://github.com/Kwaichang70/AudioServer/commit/fcbfe3e))

- Browser-Spotify volume set locally via the SDK (was spamming the Web API →
  429). Switching source stops the previous one (no more double audio /
  un-stoppable Spotify). Transport buttons are hand-rolled bold SVGs, not
  Unicode glyphs.

**OpenAPI** ([d71e74f](https://github.com/Kwaichang70/AudioServer/commit/d71e74f))

- Curated OpenAPI 3.1 spec at `GET /api/openapi.json` (public).

## Sprint 4 — performance polish

**Lazy + auto-load on list pages** ([e6fa0f1](https://github.com/Kwaichang70/AudioServer/commit/e6fa0f1), [6b094c5](https://github.com/Kwaichang70/AudioServer/commit/6b094c5))

- `useAutoLoadMore` hook: IntersectionObserver on a sentinel <div>; fires
  `loadMore` when within 400px of the viewport. AlbumsPage + ArtistsPage
  use it. The manual "Load More" button stays as keyboard/no-JS fallback.
- `loading="lazy"` + `decoding="async"` on every cover/track/artist `<img>`
  (HomePage, HistoryPage, SearchPage, FavoritesPage, AlbumCover, ArtistImage).
- No new dependencies; native browser API + a tiny hook.

**Multi-stage Dockerfile** ([1b9f4fa](https://github.com/Kwaichang70/AudioServer/commit/1b9f4fa))

- Builder stage: full toolchain (python3 + make + g++) + `npm ci` + workspace
  builds + `npm prune --omit=dev`.
- Runtime stage: `node:22-slim` + just `ffmpeg` and `curl`. Copies in the
  pruned `node_modules`, server source (`tsx` runs it on the fly), `shared/dist`,
  `client/dist`.
- `tsx` moved from server's devDependencies to dependencies (it's a real
  runtime dep — the CMD invokes `node --import tsx/esm`).
- Image size: ~1.5 GB → ~300 MB.

**Service worker cleanup** ([96e508d](https://github.com/Kwaichang70/AudioServer/commit/96e508d))

- Stop pre-caching `/`. The old SW cached the SPA shell on install; after
  every deploy Vite emitted new asset hashes and the cached HTML kept
  referencing the old chunk filenames → 404 → blank page.
- Cover-cache key normalised to drop `?t=<stream-token>`. The token refreshes
  hourly, so the previous key fragmented the cache infinitely.
- `CACHE_VERSION` bumped to `v2`. Activation deletes any caches that don't
  match the current name.

## Sprint 3 — Roon-feature parity slice 1

**Smart playlist editor in UI** ([510a786](https://github.com/Kwaichang70/AudioServer/commit/510a786))

- `<RuleEditor>` component reused by both the create-form (in the list page)
  and the new edit-form (in the detail page). Defensive `parseRules()` for
  malformed JSON in the DB.
- Backend already supported the rules schema and `api.updateSmartPlaylist` —
  this is purely UI work.

**ReplayGain** ([192cb46](https://github.com/Kwaichang70/AudioServer/commit/192cb46))

- Schema: `replay_gain_track`, `replay_gain_track_peak` on tracks;
  `replay_gain_album`, `replay_gain_album_peak` on albums. Idempotent
  ALTER TABLE migrations for existing DBs.
- Scanner reads `replaygain_track/album_gain/peak` from `music-metadata`.
- Player ([useAudio.ts](../client/src/hooks/useAudio.ts)): opt-in Web Audio
  chain (`createMediaElementSource → GainNode → destination`). Lazy-init
  the first time RG is requested. iOS Safari `AudioContext.resume()` on
  user gesture.
- Crossfade swapped to `linearRampToValueAtTime` when Web Audio is active.
- Same-origin only: cross-origin streams (Tidal, Spotify) bypass the chain
  ([2a52bb4](https://github.com/Kwaichang70/AudioServer/commit/2a52bb4)) — `MediaElementSource` outputs zeros without CORS-allow.
- Settings UI: mode (off/track/album) + preamp slider (-15…+15 dB), persisted
  in localStorage.

## Sprint 2 — stability

**Concrete bug fixes** ([e44d16b](https://github.com/Kwaichang70/AudioServer/commit/e44d16b))

- Crossfade trigger fix: per-track `WeakSet` guard replaces the
  shared-timer latch. The old guard could suppress the next track's
  crossfade if the timer was still running.
- Re-verified socket polling-fallback (was already correctly guarded).
- Providers API: re-verified that backend already returns
  `available`/`authenticated`/`configured` correctly.

**Progress lifted out of AudioContext** ([e44d16b](https://github.com/Kwaichang70/AudioServer/commit/e44d16b))

- `ProgressStore` + `useSyncExternalStore`. `timeupdate` fires ~4×/sec;
  previously every AudioContext consumer (album lists, cover art, queue)
  re-rendered at that rate. Now only `useProgress()` subscribers do.
- NowPlayingBar / NowPlayingFull / LyricsDisplay migrated.

**Error pipeline** ([e44d16b](https://github.com/Kwaichang70/AudioServer/commit/e44d16b))

- Server: global error middleware + 404 handler. `HttpError` class for
  structured throws; `asyncHandler` for promise propagation.
- Client: `ApiError` class + `onApiError()` pub/sub. Toast provider
  auto-toasts errors (except 401 — App.tsx handles re-auth on those).
- React `<ErrorBoundary>` around `<Layout>` with try-again / reload-page
  fallback UI.

**Integration tests** ([e44d16b](https://github.com/Kwaichang70/AudioServer/commit/e44d16b))

- supertest + tmpdir SQLite per suite.
- `auth-flow.test.ts` (11 tests) — full regression for the phase-1
  auth-bypass.
- `playlist-crud.test.ts` (12 tests) — playlist + queue CRUD + zod
  validation behaviour.
- `initDatabase()` accepts an optional path override for tests.

**Observability** ([e44d16b](https://github.com/Kwaichang70/AudioServer/commit/e44d16b))

- `/api/health` returns `db.status`, `library.lastScanAt`, structured
  providers (`configured`/`available`/`authenticated`), and flips to
  `degraded` if the DB is unreachable.
- `/api/health/live` as a lightweight liveness probe (no DB hit).

## Sprint 1 — security & quality foundation

**Critical auth fix** ([c0eb941](https://github.com/Kwaichang70/AudioServer/commit/c0eb941))

- `authMiddleware` existed but was never mounted. Every endpoint was open
  despite the JWT infra. Split into `attachUser` (always-on; parses token
  if present) and `requireAuth` (gates non-public paths).
- Followups: scoped to `/api/*` only ([0c0667f](https://github.com/Kwaichang70/AudioServer/commit/0c0667f)) — gating static assets too
  meant the SPA bundle returned 401 JSON for `/assets/*.js` requests.

**Signed stream tokens** ([c0eb941](https://github.com/Kwaichang70/AudioServer/commit/c0eb941))

- `<img>`/`<audio>` tags can't send Authorization headers. Added a
  session-scoped HMAC token (1h TTL) appended to cover/stream URLs as
  `?t=`. Minted via `GET /api/auth/stream-token`.

**Helmet + CORS** ([c0eb941](https://github.com/Kwaichang70/AudioServer/commit/c0eb941), [a4dd833](https://github.com/Kwaichang70/AudioServer/commit/a4dd833), [4da11cd](https://github.com/Kwaichang70/AudioServer/commit/4da11cd))

- Helmet for security headers.
- CORS scoped to `/api/*` (was global — broke static-asset serving).
- CORS callback returns `{ origin: false }` instead of throwing Error
  (avoids 500 on disallowed cross-origin requests).
- Same-origin requests always allowed even if the Origin host isn't in
  `ALLOWED_ORIGINS` (browsers send Origin for non-safe methods even
  same-origin).

**Range-request hardening** ([c0eb941](https://github.com/Kwaichang70/AudioServer/commit/c0eb941))

- `/api/library/tracks/:id/stream` now returns 416 on malformed or
  out-of-bounds ranges.

**zod environment validation** ([c0eb941](https://github.com/Kwaichang70/AudioServer/commit/c0eb941))

- `server/src/config.ts` rewritten to parse `process.env` through a zod
  schema. Fails fast in production if `JWT_SECRET` is missing or shorter
  than 32 chars. `fs.access` warns on inaccessible music paths.

**Input validation middleware** ([c0eb941](https://github.com/Kwaichang70/AudioServer/commit/c0eb941))

- `validate({ body, query, params })` middleware in `server/src/utils/validate.ts`.
- Applied to auth, playback, playlists, smart-playlists, scrobble routes.
  Inline parsing on `:id` routes to preserve Express's `RouteParameters`
  inference for `req.params`.

**Lint & CI tooling** ([c0eb941](https://github.com/Kwaichang70/AudioServer/commit/c0eb941))

- ESLint 9 flat config + Prettier + Husky pre-commit + lint-staged.
- Root `tsconfig.json` with project references.
- `.github/workflows/ci.yml`: install → lint → typecheck → tests → build.

**Client raw `fetch()` cleanup** ([96ec746](https://github.com/Kwaichang70/AudioServer/commit/96ec746))

- All `/api/*` calls go through `api.*` methods so the Bearer token is
  attached. SettingsPage + OAuthCallbackPage had several raw `fetch()`
  calls that 401'd once `requireAuth` was mounted.

## Deployment hotfixes (Synology-specific)

**Husky prepare resilient to missing .git** ([acd974c](https://github.com/Kwaichang70/AudioServer/commit/acd974c))

- Docker `COPY` doesn't bring `.git`; `husky` exited non-zero during
  `npm ci`, breaking the workspace symlink setup. `"prepare": "husky || true"`.

**Workspace resolution via paths + alias** ([2abf79a](https://github.com/Kwaichang70/AudioServer/commit/2abf79a))

- TS in the docker builder couldn't resolve `@audioserver/shared` via the
  hoisted symlink. Added `paths` in `client/tsconfig.json` and a Vite
  `resolve.alias` so the consumer points at `shared/src/index.ts` directly.

**Dockerfile: native build tools** ([fe8be92](https://github.com/Kwaichang70/AudioServer/commit/fe8be92))

- `better-sqlite3`'s prebuilt binary download occasionally times out from
  NAS networks; added python3 + make + g++ for the node-gyp source-build
  fallback.

## Initial review

The session began with an [ultraplan analysis](../C:/Users/DannydeLacombe/.claude/plans/linked-inventing-torvalds.md)
(see the project's plan file) that identified the four-phase roadmap above.

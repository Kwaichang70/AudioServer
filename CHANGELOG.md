# Changelog

A running log of the multi-sprint rework that took AudioServer from "runs on
my desk" to production-ready on the Synology. Sorted newest first. Tags are
the kind of change, not semver — there are no releases yet.

## Bugfix — An album keeps playing (reported from the NAS, 9 Sept 2026)

**The queue stopped after one song on a speaker**
(`server/src/services/device-monitor.ts`, `server/src/services/playback.ts`)

- A renderer that finishes a track reports "stopped" with its counters back
  at 0:00/0:00, and the monitor's last stored sample can lag several seconds
  behind the real end (polls are 2 s apart and only kept when the position
  moves more than 3 s). The old end-detection asked for a position within
  two seconds of the duration, so it missed the end of most tracks: the
  session went to stopped and the album never advanced.
- The monitor now remembers how far a device actually got in the track it is
  playing and judges a stop by that: inside the end grace window (two poll
  intervals plus a margin) the track finished and the queue advances; earlier
  than that somebody pressed stop and the session stops, queue intact.
- That verdict travels as `setState({ ended: true })` instead of being
  re-derived from the position, so a renderer whose reported duration is a
  few seconds shorter than the library's no longer silently ends the album.
- A "stopped" from a device that has not started yet is ignored while the
  dispatch is still settling (15 s): a DLNA renderer answers STOPPED between
  "here is the url" and the first frame of audio, which used to stop the very
  track the NAS had just sent.

**Clicking a song in an album played only that song**
(`client/src/context/AudioContext.tsx`, album/playlist/favorites/smart pages)

- `playAlbum(tracks, startIndex)` queues the whole list from the clicked
  track, so the album continues after it. Clicking a track used to replace
  the queue with that single song.

**The player bar on a phone** (`client/src/components/NowPlayingBar.tsx`)

- Track info takes the free width instead of a fixed 10 rem, with elapsed /
  total time on its own line and a hairline of progress along the top edge.
- The output-device picker is no longer desktop-only — sending music to a
  speaker from a phone is possible again — and the queue counter (`3/11`) sits
  in its own block instead of being clipped at the right edge.
- Bigger play button (44 px) and lighter secondary text; shuffle, repeat, the
  volume slider and the scrub bar stay on desktop, where there is room.

## V08 — Usable on a phone, honest when the network is not (verbeterplan sprint 8)

**Service worker and updates** (`client/sw/sw.template.js`, `client/vite.config.ts`)

- Build-time generated worker with a shell cache pinned to one build: no
  more old-HTML/new-assets white page after a release.
- Updates wait: "A new version of AudioServer is ready, reload now"; the
  new worker takes over only on that reload.
- Offline navigation gets the cached shell or `offline.html`; API and
  socket traffic is never intercepted; covers capped at 400 under a
  token-free key; only `audioserver-*` caches are deleted.
- Offline banner that says what still works (speakers driven by the NAS)
  and does not promise offline music.

**Guided first experience** (`client/src/components/GettingStarted.tsx`)

- Home shows library, streaming sources and output with real status and one
  next step each, including unreadable music folders and an unreachable
  speaker. Dismissable; returns while the library is empty.

**Accessibility and touch**

- Login fields labelled, error announced; hamburger labelled with
  `aria-expanded`; 44 px targets on navigation, queue and banners; focus
  rings. A refused `play()` promise becomes "press play to start" instead
  of a false playing state.

**Background, tokens, diagnostics**

- Back to the foreground: snapshot resync or reconnect; token renewed when
  under a week is left (`POST /api/auth/refresh`, sliding 30 days).
- `GET /api/health/diagnostics` (admin): versions, schema, counts, last
  scan, playback state, provider status, last 50 warnings, all redacted.
  `/api/health` carries `version` and `buildId`; Settings → About shows
  version, server/app/cached-shell build ids and "Copy diagnostics".
- Dockerfile passes `VCS_REF` into the client build and the running server.

**Tests**: service-worker template (precache, own caches only, API
passthrough, offline fallbacks, cover cap, SKIP_WAITING), banners, getting
started, login accessibility, autoplay rejection, jwt helper, session
refresh, diagnostics redaction (288 server, 113 client).

## V07 — Find the right version, know what can play (verbeterplan sprint 7)

**Edition-aware, Unicode-safe search merge** (`server/src/providers/registry.ts`)

- The comparison key keeps letters of every script; different non-Latin
  titles no longer collapse into one empty key.
- Results merge only when artist, base title, edition label (from the
  source or parsed from "(Live)", "[2011 Remaster]", "- Radio Edit") and
  duration (±10 s) agree. Studio, live and remastered versions stay separate.
- Every merged result carries `alternatives`: one entry per source with that
  source's own id, album id, version and quality. `availableOn` is kept.
- Qobuz and Tidal `version` fields are mapped.

**Playability, filters and source choice** (`server/src/services/search.ts`,
`client/src/pages/SearchPage.tsx`)

- Each track states `playability` (browser / server / external / playable /
  reason) from the playback resolver; missing local files say `missing-file`.
- `GET /api/providers/search` and `/api/library/search` accept `sources`,
  `quality=lossless|hires`, `format`. The search page has source chips, a
  quality filter, version and missing badges, and "▶ qobuz"-style buttons
  that play the same recording from another source with that source's id.

**Ranked local search and benchmark** (`server/src/services/local-search.ts`)

- Exact, then prefix, then contains, then other fields; NOCASE indexes on
  artist and album names; LIKE wildcards escaped; missing files sort last.
- `npm run bench:search` seeds 50 000 tracks and prints p50/p95/max. Result
  on the development container: p95 < 20 ms for every query class, so no
  FTS5 (decision recorded in the plan).

**Provider timeouts and partial results**

- Every source gets the same time budget (`SEARCH_PROVIDER_TIMEOUT_MS`,
  default 6000); the response lists `sources[]` with ok / timeout / error /
  unavailable, and the UI names an unreachable source above the results.

**Tests**: search keys (accents, scripts, title versions, edition keys),
dedup by edition and duration, local ranking and filters, playability,
option parsing, timeout/error/unavailable statuses, source selection with
alternative ids (284 server, 95 client).

## V06 — Library changes without losing user data (verbeterplan sprint 6)

**Source location vs identity** (`server/src/services/scanner.ts`, migration
`0005_library_identity`, schema v6)

- Tracks store `file_size`, `file_mtime`, a `fingerprint` (size, duration,
  tags) and the `scan_version` that processed them. Unchanged size + mtime
  skips the file; a `SCAN_VERSION` bump or "Full rescan"
  (`POST /api/library/scan?force=true`) re-reads everything once.

**Moves and missing files**

- A file at a new path is recognised as an existing track when exactly one
  row has the same fingerprint and its old file is gone: the row is
  relinked, playlists, favorites and history follow. Doubtful cases (two
  candidates, same title but a different recording) are never merged.
- A file that disappeared under a readable root is marked `missing`, not
  deleted. Unreadable roots or subdirectories never make music missing. A
  missing file that returns is recovered automatically.
- `GET /api/library/missing` lists missing tracks with strong/weak
  candidates; `POST /api/library/missing/:id/relink` and
  `POST /api/library/missing/purge` (admin) are the explicit actions.
  Streaming a missing track answers 404 `TrackMissing`; album pages dim it.
- An album folder that moved keeps its favorite when the heir is unambiguous.

**Scan runs**

- `scan_runs` records every scan (roots, failed roots and directories,
  counts, trigger, forced, timestamps, outcome); `GET /api/library/scan/runs`,
  `/scan/status` with last successful run and configured roots,
  `/api/health.lastScanAt` from real runs. Interrupted runs are closed as
  failed on startup. Settings shows library health with "Clean up missing".
- `WATCH_LIBRARY` is passed through `docker-compose.yml`; watcher scans are
  recorded with trigger `watcher`.

**Tests**

- Scanner: unreachable roots and unreadable subdirectories keep items;
  missing instead of deleted; purge; move keeps id and user data; doubtful
  matches; two identical candidates; relink; recovery; skip/force/version
  re-read; scan runs; fingerprint. Migration of an early-release database
  shape (no journal, no role, no identity columns, NULL history times).

## V05 — Listening history you can trust (verbeterplan sprint 5)

**Listening sessions** (`server/src/services/listening.ts`, migration
`0004_listening_sessions`, schema v5)

- One row per track start with a metadata snapshot (title, artist, album,
  local ids when known, duration, source), a UTC start time and the time
  actually heard. Provider tracks and files that later disappear keep their
  history: no foreign key to `tracks`.
- Listened time is confirmed playing time: device monitor samples for
  speakers the NAS drives, `POST /api/playback/progress` every 10 s from a
  browser that plays itself. Intervals are capped at 45 s, pauses stop the
  clock, seeks and skips add nothing, two controllers cannot double-count.
- A listen qualifies by Last.fm's rule (track > 30 s, at least half or four
  minutes heard). Failed plays and immediate skips never count.
- The old `play_history` table is copied once and kept read-only; rows whose
  time was never recorded stay `started_at = NULL` and are shown as
  "Time unknown", never given an invented time.

**Scrobbling**

- Exactly one submission per listen and service: `scrobble_queue.session_id`
  with a unique `(session_id, service)` index; the submission carries the
  start time. Retries, reconnects and a second controller cannot duplicate.
- Radio never scrobbles; Spotify only with `SCROBBLE_SPOTIFY=true` (Spotify
  scrobbles itself). A disabled service keeps its rows pending instead of
  burning retries; sent rows are pruned after 30 days.
- Sessions left open by a previous run are closed on startup with their
  accrued time; a qualifying one still gets its single scrobble.

**Timestamps**

- Every Drizzle timestamp column has a schema default now (`$defaultFn`):
  Drizzle wrote an explicit NULL for omitted columns, so favorites,
  playlists and history rows had no time.

**History and stats**

- `/api/history/tracks|recent|top-artists` read qualified sessions
  (`played_at` ISO-8601 or `null`, plus `listened_ms` and `source`).
- New `GET /api/history/stats?days=` and an "On this server" block on the
  stats page that works without ListenBrainz.
- `POST /api/history/played` (pre-V05 clients) is accepted and ignored.
- Client no longer records a play when play is pressed.

## Fix — async route errors no longer kill the server (9 Sept 2026)

Found while creating the admin account on the Synology: the request got an
empty reply (`502` behind the reverse proxy) and the container restarted,
with a fresh setup code each time. Root cause is structural, not the
setup screen: Express 4 does not await handlers, so a bare
`async (req, res) => {...}` that throws after its first `await` becomes an
unhandled promise rejection, and Node 15+ terminates the process on those.
64 handlers across the routers were written that way.

- Every async route handler is wrapped in `asyncHandler` (typed so
  `req.params` and validated bodies keep their types). A throw now reaches
  the error middleware: a logged `500` with request id and stack, server
  stays up.
- `process.on('unhandledRejection')` logs the stack and keeps running (the
  only rejections left come from background work: scanner, polls,
  providers). `uncaughtException` logs the stack and exits so the container
  supervisor restarts it with a visible reason in `docker logs`.
- Regression test `async-routes.test.ts`: a handler that throws after an
  await answers 500, and a source scan fails the build when a new bare async
  handler appears in `server/src/routes`.
- `DEPLOY_SYNOLOGY.md` §4: how to read a crash out of `docker logs`.

The exception itself, read from the container log afterwards:
`SqliteError: table users has no column named role`. The Synology database
predates roles, its `users` table has `id, username, password_hash,
created_at` only, and the initial migration's `CREATE TABLE IF NOT EXISTS`
leaves such a table as it is.

- Startup backfill `backfillUserRoles`: adds `users.role` (default `user`)
  when missing; if accounts already exist and none has a role, the oldest
  becomes admin so the installation stays administrable. Idempotent, covered
  by `legacy-users-table.test.ts`.
- `TRUST_PROXY` (default `loopback`): the same log showed express-rate-limit's
  `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`, the Synology reverse proxy sets
  `X-Forwarded-For` and without `trust proxy` every visitor shares one
  rate-limit bucket. `loopback` trusts a proxy on the same host only;
  `false`, a hop count or an IP list are accepted too (`.env.example`,
  `docker-compose.yml`, `docs/synology-https.md`).

## V04 — The NAS plays local and Qobuz on its own (verbeterplan sprint 4)

**One resolver** (`server/src/services/playback-resolver.ts`,
`GET /api/playback/capabilities`)

- Per source: can the server hand it to a speaker, can a browser play it, is
  it an external player (Spotify Connect), does the url expire. Local →
  LAN url with a fresh `system` token and mime type; Qobuz → freshly signed
  CDN url; radio → station stream; Spotify → external player only; Tidal →
  no full playback.

**Server dispatch with status and policy**

- `dispatch()` resolves a fresh url on every attempt (an expired Qobuz url
  is replaced, not retried), sends with a 20 s timeout, at most two attempts,
  and reports `snapshot.dispatch` (`loading`/`playing`/`client`/`skipped`/
  `error`) through `playback:dispatch`; the app shows skips and errors.
- `PLAYBACK_UNPLAYABLE_POLICY=skip|stop`: skip (default) moves on, at most
  three in a row, then stops with a visible error. Spotify on a speaker is
  left to the connected controlling tab; with nobody connected it counts as
  unplayable.

**Ownership, restart, polling**

- Migration `0003_session_owner` (schema version 4): `owner_user_id`,
  `server_managed`. After a restart the server asks the speaker: still
  playing → keeps driving it; idle → session stopped with reason;
  `PLAYBACK_RESUME_ON_RESTART=true` re-sends the current item.
- Device monitor: no overlapping polls per device, 5 s status timeout; a
  pinned device that stays unreachable stops the session instead of leaving
  a fictitious "playing".

**Spotify**

- Playlist contents via `/playlists/{id}/items` (February 2026 change) with
  fallback to `/tracks`; typed `SpotifyProviderError` so routes answer 429
  (+ `Retry-After`), 403 (Premium / Development Mode) and 401 instead of 500.

## V03 — One playback session (verbeterplan sprint 3)

The queue now lives on the server for every output, including the browser;
tabs and phones mirror it. Reload the app once after this release (an old
page is told to).

**Item identity** (`docs/architecture.md`, "One playback session")

- Every queue position has a stable `itemId`; current position, remove,
  move, play-this-one, restart recovery and events use it. A → B → A → C
  plays four positions; a restart restores the second A as the second A.
  Migration `0002_queue_identity` (schema version 3) adds
  `queue_items.item_id`/`metadata` and `playback_state.queue_item_id`/
  `revision`; existing queues get ids on first load.

**Commands with revision and command id**

- `GET /api/playback/session` snapshot; `queue/set|add|remove|move|clear|play`,
  `next`, `previous` all answer with the snapshot. `expectedRevision` turns a
  stale edit into `409 StaleRevision` + fresh snapshot; `commandId` makes a
  retry apply once. Mutations require `X-Client-Id`; a page without it gets
  `426` and a "reload" message. Clear keeps the current track playing and
  drops the rest; stop stops now and keeps the queue.

**Snapshots and origin-bound events**

- `playback:snapshot` on socket connect and on `playback:sync`; queue/state/
  track-changed events carry `revision`, `origin` (tab + session or server)
  and `controllerClientId`. The client mirrors other tabs without starting
  audio, applies its own command responses, and only plays a server-side
  advance itself when it is the controlling tab and the track is a provider
  track the NAS cannot stream. Shuffle/repeat are session-wide now.
- The device monitor writes transport state only for the session's active
  device. `services/playback.ts` no longer imports Socket.IO (event sink is
  injected), so it loads in any import order.

## V02 — Setup, sessions and admin rights (verbeterplan sprint 2)

Everyone signs in again once after this release: tokens are now bound to
server-side sessions.

**Setup mode** (`docs/permissions.md`, `README.md`)

- With zero accounts the API answers 401 for everything except setup-status,
  login/logout/register, `/auth/me`, the health probes, the OpenAPI document
  and the CSP report sink. The old "first run lets everything through" bypass
  is gone, for HTTP and for Socket.IO.
- The first admin is created with a one-time setup code that the server
  prints to its log and writes to `setup-code.txt` next to the database
  (`SETUP_CODE` to choose it). `/register` does nothing else any more.

**Admin rights**

- `requireAdmin` on user management, token import, provider OAuth/login/
  logout, scrobbling connect/disconnect, library scans and bulk fetches,
  Librespot start/stop. `docs/permissions.md` lists the matrix; a test
  asserts every row. Settings hides those sections from regular users.

**Sessions**

- `sessions` table (migration `0001_sessions`, schema version 2). JWTs carry
  a session id and stop working when the session is revoked, expired or its
  user deleted. Logout, "sign out other devices", change password (admin:
  reset password, revoke sessions) are new routes; sockets of a revoked
  session are closed with `session:revoked`; stream tokens are session-bound
  (server-driven device playback uses a `system` token).
- Client: `AuthContext` decides signed-in state from `/auth/setup-status` +
  `/auth/me`; any 401 or a closed socket returns to the login screen; sign-out
  in the header; "Account & Sessions" in Settings.
- Login/register rate limits now count failed attempts only.

**Hardening**

- zod validation on provider OAuth/login, Librespot start and all auth routes.
- `Content-Security-Policy-Report-Only` with `POST /api/csp-report` logging
  violations; zero reports in the browser flow, Spotify SDK still to check.
- `GET /api/health` now needs a session; `/live` and `/ready` stay public.

## V01 — Release basis (verbeterplan sprint 1)

First sprint of [VERBETERPLAN_SPRINTS.md](VERBETERPLAN_SPRINTS.md): make every
change reproducible to test and safe to roll back before touching playback.

**Release gate**

- `.github/workflows/ci.yml`: clean `npm ci`, lint, typecheck, server + client
  tests and build on Node 22 (production) and Node 24; then the production
  image is built, started, probed on `/api/health/ready`, checked against its
  own `HEALTHCHECK` and stopped gracefully.
- `startup-smoke.test.ts` boots the real `server/src/index.ts` with a temp DB,
  no providers and no devices, and asserts a clean SIGTERM exit.

**Readiness vs. liveness**

- New `GET /api/health/ready`: 200 with the schema version when the DB is open
  and migrated, 503 otherwise. `GET /api/health` now answers 503 when
  degraded. Docker `HEALTHCHECK` uses the readiness probe.

**Backup, restore, rollback**

- `npm run db:backup|db:verify|db:restore --workspace=server`: consistent
  online SQLite snapshot (single file, no WAL side files), read-only verify
  (integrity, schema version, row counts), restore with dry run, safety copy
  and an in-use guard.
- `PRAGMA user_version` carries the schema version; an older build refuses a
  database migrated by a newer one, which is the compatibility check the
  rollback runbook relies on.
- `docs/backup-restore.md`: what to back up (DB + `.env`, because
  `JWT_SECRET` also encrypts provider tokens), scheduled backups, update and
  rollback procedure, restore on an empty installation.

**Dependencies** ([SECURITY_AUDIT.md](SECURITY_AUDIT.md))

- Production audit 19 → 2 packages: transport/parser chains via lockfile
  refresh, `qs` override, music-metadata 10 → 11 (ASF infinite loop),
  drizzle-orm 0.38 → 0.45.2, express 4.22.2, tsx 4.23. The remaining
  `node-ssdp → ip` finding is assessed as unreachable, with owner and review
  date.

## Sprint 6 — ListenBrainz, beyond scrobbling

AudioServer now _consumes_ ListenBrainz data, not just feeds it. Three slices,
each matching results back to the local library by name so owned items
deep-link and the rest open a unified search (local + Spotify + Qobuz).

**Listening stats** ([feff496](https://github.com/Kwaichang70/AudioServer/commit/feff496))

- New `/stats` page: top artists / albums / tracks per week / month / year /
  all-time from the ListenBrainz stats API (token reused from scrobble config,
  username resolved + cached via /validate-token).

**Discover** ([c039f6b](https://github.com/Kwaichang70/AudioServer/commit/c039f6b))

- New `/discover` page: the "Created for you" recommendation playlists (Weekly
  Jams / Exploration) and fresh releases from your artists. Also wired `?q=` on
  the search page so recommendation links actually run a search.

**Listeners also like** ([99174a0](https://github.com/Kwaichang70/AudioServer/commit/99174a0))

- Similar-artists pills on the artist page. ListenBrainz's own similar-artists
  API is MBID-based, so this uses Last.fm's name-based artist.getSimilar
  (LASTFM_API_KEY); hides itself when there's no key or no matches.

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

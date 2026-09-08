# Permissions matrix (admin / user)

Introduced in sprint V02.2. Two roles exist: `admin` (the account created at
setup, plus anyone an admin promotes) and `user`. The rule of thumb:

- **Everything that plays, browses or is personal is for every signed-in user.**
- **Everything that changes the server for the whole household is admin-only:**
  provider connections, scrobbling targets, library scans, Librespot, user
  accounts, token import.

`requireAdmin` (`server/src/middleware/auth.ts`) enforces the admin rows. The
suite `server/src/__tests__/sessions-permissions.test.ts` asserts every
admin-only row below with a regular user (403) and anonymously (401), so this
document and the code cannot drift apart silently.

## Public (no session)

| Route                            | Purpose                                           |
| -------------------------------- | ------------------------------------------------- |
| `GET /api/auth/setup-status`     | Does the installation still need setup?           |
| `POST /api/auth/register`        | Create the first admin, needs the setup code      |
| `POST /api/auth/login`           |                                                   |
| `POST /api/auth/logout`          | Idempotent, so a dead token can still sign out    |
| `GET /api/auth/me`               | `null` when the token is not (or no longer) valid |
| `GET /api/health/live`, `/ready` | Probes for Docker / monitoring                    |
| `GET /api/openapi.json`          | API description                                   |
| `POST /api/csp-report`           | Browser CSP violation reports                     |
| Static files (`/`, `/assets/*`)  | The SPA itself                                    |

In setup mode (zero users) this is the **entire** reachable surface. There is
no longer a "first-run lets everything through" bypass.

## Every signed-in user

| Area              | Routes                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own account       | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others`, `POST /api/auth/password`, `GET /api/auth/stream-token` |
| Library           | all `GET /api/library/*` (browse, search, stream, covers, lyrics, scan status)                                                                              |
| Playback & queue  | all `/api/playback/*`, all `/api/devices/*` (household output is shared, see V10 for zones)                                                                 |
| Playlists         | all `/api/playlists/*`, `/api/smart-playlists/*`                                                                                                            |
| History/favorites | all `/api/history/*`                                                                                                                                        |
| Providers (use)   | `GET /api/providers/status`, `/search`, album/track/playlist reads, streams, Spotify Connect controls                                                       |
| Radio             | all `/api/radio/*`                                                                                                                                          |
| Scrobbling (use)  | `GET /api/scrobble/config`, `POST /api/scrobble/scrobble`, `POST /api/scrobble/now-playing`                                                                 |
| ListenBrainz data | all `GET /api/listenbrainz/*`                                                                                                                               |
| Librespot (use)   | `GET /api/librespot/status`, `/stream`, `POST /api/librespot/play-to-device`                                                                                |
| Diagnostics       | `GET /api/health`                                                                                                                                           |

## Admin only

| Route                                                   | Why global                                               |
| ------------------------------------------------------- | -------------------------------------------------------- |
| `GET /api/auth/users`                                   | Account management                                       |
| `POST /api/auth/users/create`                           |                                                          |
| `POST /api/auth/users/:id/reset-password`               | Managed password recovery; signs the user out everywhere |
| `POST /api/auth/users/:id/revoke-sessions`              | "Sign out everywhere" for another account                |
| `DELETE /api/auth/users/:id`                            |                                                          |
| `POST /api/auth/import-token`                           | Writes the household's provider tokens                   |
| `POST /api/providers/{spotify,tidal}/auth/init`         | Starts OAuth for the shared provider account             |
| `POST /api/providers/{spotify,tidal}/auth/callback`     |                                                          |
| `POST /api/providers/{spotify,tidal,qobuz}/auth/logout` | Disconnects the shared account                           |
| `POST /api/providers/qobuz/auth/login`                  | Shared Qobuz credentials                                 |
| `GET /api/scrobble/lastfm/auth-url`                     | Shared Last.fm account                                   |
| `POST /api/scrobble/lastfm/auth`, `/disconnect`         |                                                          |
| `POST /api/scrobble/listenbrainz/auth`, `/disconnect`   | Shared ListenBrainz token                                |
| `POST /api/library/scan`                                | Rewrites the library index                               |
| `POST /api/library/covers/fetch`                        | Bulk external fetch                                      |
| `POST /api/library/artists/images/fetch`                | Bulk external fetch                                      |
| `POST /api/librespot/start`, `/stop`                    | Runs a process on the NAS with Spotify credentials       |

Open questions parked for later sprints (not enforced yet):

- Per-user favorites/history/playlists (V09 personal profiles). Today they
  are household-wide by design.
- Per-zone device control (V10). Today every user controls every output.

## Sessions

- Logging in creates a `sessions` row; the bearer token carries its id.
  Tokens are valid for 30 days, and only while the row exists, is not
  revoked and the account still exists.
- Logout, "sign out other devices", changing your own password (keeps the
  current session), an admin reset or revoke, and deleting a user all revoke
  sessions server-side. Open Socket.IO connections of a revoked session get
  `session:revoked` and are closed; stream tokens (`?t=`) bound to it stop
  working at the next request.
- The SPA decides "signed in" from `GET /auth/setup-status` + `GET /auth/me`,
  never from the mere presence of a stored token. Any later 401 or a closed
  socket sends it back to the login screen.
- Server-driven device playback uses a `system` stream token (HMAC, 6 h) that
  needs no session.

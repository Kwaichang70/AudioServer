# Provider setup

Per-provider OAuth and scrobbling configuration. Each provider is optional;
the local library works without any of them.

## Tidal

1. Sign up at [developer.tidal.com](https://developer.tidal.com) and create
   an app.
2. Set the redirect URI to:
   ```
   http(s)://<your-host>:3001/settings/callback/tidal
   ```
   For a Synology behind a reverse proxy with TLS, use the HTTPS form.
3. Copy Client ID + Client Secret into `.env`:
   ```env
   TIDAL_CLIENT_ID=...
   TIDAL_CLIENT_SECRET=...
   ```
4. Restart the container, open Settings → Streaming Providers → **Connect**.
   You'll be sent to Tidal's OAuth screen and bounced back with a
   `?code=...` that the server exchanges for tokens.

Tidal accepts HTTP redirect URIs on LAN hosts; you don't strictly need HTTPS
for Tidal alone.

## Spotify

> ⚠️ As of April 2025 Spotify rejects HTTP redirect URIs on LAN hosts. Only
> `https://` URIs or the loopback exceptions (`http://127.0.0.1`,
> `http://localhost`) are accepted. This is documented in Spotify's
> [Redirect URI guidelines](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
> Symptom if you ignore it: the authorize call returns HTTP 400.

You have two ways to use Spotify:

### Option A — Web API via OAuth (requires HTTPS)

1. Create an app in the
   [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Add an **HTTPS** redirect URI:
   ```
   https://<your-host>/settings/callback/spotify
   ```
3. Put a reverse proxy in front of AudioServer with a valid TLS cert.
   Synology DSM has a built-in Let's Encrypt integration:
   - Control Panel → Security → Certificate → Add → Get from Let's Encrypt
   - Application Portal → Reverse Proxy → New rule: `https://<sub>.<your-domain>` → `http://<lan-ip>:3001`
4. Set `.env`:
   ```env
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   ALLOWED_ORIGINS=https://<your-host>
   ```
5. Restart, then Settings → **Connect Spotify**.

Used for: browsing playlists/albums/artists, library sync, Spotify Connect
device control.

### Option B — Librespot as a Spotify Connect receiver (no HTTPS)

1. Edit `.env`:
   ```env
   SPOTIFY_USERNAME=<your spotify username/email>
   SPOTIFY_PASSWORD=<your spotify password>
   ```
   (These feed librespot's `--username` / `--password`. You can also start
   librespot on demand from Settings without env vars.)
2. Rebuild the container — librespot is baked into the image.
3. Open the Spotify app on your phone / desktop → device picker should now
   show "AudioServer" as a Spotify Connect target.

Used for: pushing playback from another Spotify client to AudioServer's audio
pipeline. Doesn't give you the Web API (no playlist browsing inside
AudioServer), but it bypasses the HTTPS requirement entirely.

You can use both together — Web API for browse, librespot for playback.

## Qobuz

Full-track playback is supported (added in a later sprint), but streaming
requires app credentials you supply yourself — Qobuz doesn't issue these
openly, so you need a working `APP_ID` / `APP_SECRET` pair.

1. Set the app credentials in `.env`:
   ```env
   QOBUZ_APP_ID=<your app id>
   QOBUZ_APP_SECRET=<your app secret>
   QOBUZ_AUDIO_FORMAT=5   # optional: 5=MP3 320, 6=FLAC 16/44, 7=FLAC ≤24/96, 27=FLAC ≤24/192
   ```
   Without `QOBUZ_APP_ID`/`QOBUZ_APP_SECRET`, streaming stays disabled and
   `/api/providers/qobuz/status` reports it.
2. Provide user auth one of two ways:
   - env: `QOBUZ_USERNAME` / `QOBUZ_PASSWORD`, **or**
   - Settings → Streaming Providers → Qobuz login at runtime.
3. Verify via `/api/providers/qobuz/status`.

## Last.fm scrobbling

1. Register an API account at
   [last.fm/api/account/create](https://www.last.fm/api/account/create).
2. Add to `.env`:
   ```env
   LASTFM_API_KEY=<api key>
   LASTFM_API_SECRET=<shared secret>
   ```
3. Restart, then Settings → Scrobbling → **Last.fm: Connect**.
   You'll get a Last.fm auth URL. Visit it, click "Allow", come back and
   click "Confirm". The server exchanges the token for a session key.

Scrobbles are queued in the `scrobble_queue` table and retried with backoff,
so a temporary Last.fm outage won't lose plays.

## ListenBrainz scrobbling

1. Generate a user token at
   [listenbrainz.org/profile](https://listenbrainz.org/profile).
2. In AudioServer: Settings → Scrobbling → **ListenBrainz** → paste the token
   into the prompt. The server validates it against the ListenBrainz API and
   stores it encrypted in `scrobble_config`.

No `.env` variables required — the token is user-supplied at runtime.

## Internet Radio

No setup required. AudioServer ships with a curated Dutch-first station list
plus search backed by the [RadioBrowser](https://www.radio-browser.info/)
public API.

## Validation

Once configured, verify in [/api/health](#) (any HTTP client):

```bash
curl -s http://<host>:3001/api/health | jq .providers
```

Each provider returns:

- `configured`: env vars present
- `available`: provider class initialised successfully
- `authenticated`: user token / session is live

A provider that's `configured` but not `authenticated` just hasn't completed
its OAuth flow yet — go back to Settings and click Connect.

# Release Notes - Qobuz Playback

Date: 2026-05-28

## Commits

- `4090ffc` - Add robust Qobuz playback support
- `bc3aaa3` - Add Synology Qobuz deploy runbook

## Highlights

- Qobuz is now the preferred external playback source after local files.
- Tidal full playback is intentionally disabled and treated as
  preview/metadata-only.
- Qobuz stream URLs are fetched server-side with signed `track/getFileUrl`
  requests.
- Browser playback requests a fresh Qobuz stream URL per track.
- Cross-origin external streams no longer enter the ReplayGain/WebAudio path.
- Qobuz status now reports whether the provider is configured,
  authenticated, and available for streaming.

Provider priority:

```text
local > qobuz > tidal > spotify
```

## Required Configuration

Set these on the NAS before enabling Qobuz playback:

```bash
QOBUZ_APP_ID=your-qobuz-app-id
QOBUZ_APP_SECRET=your-qobuz-app-secret
QOBUZ_AUDIO_FORMAT=5
```

Optional server-side login bootstrap:

```bash
QOBUZ_USERNAME=your-qobuz-username
QOBUZ_PASSWORD=your-qobuz-password
```

The server must not persist the Qobuz password. It stores only the encrypted
user auth token and account metadata.

Audio format notes:

- `5`: MP3 320, safest default
- `6`, `7`, `27`: higher quality options, account and region dependent

## Behavior Changes

- Tidal track streaming returns an unsupported/preview-only response instead
  of silently falling back to a 30-second preview.
- Qobuz playback fails explicitly when app credentials or user auth are
  missing.
- Device playback tries the direct Qobuz CDN URL first. If the target device
  rejects it, the UI should show a clear failure instead of silently using a
  preview source.

## Verification Already Performed

- `npm run typecheck`: passed
- Server Vitest suite: 94 tests passed
- Client Vitest suite: 21 tests passed
- `npm run lint`: 0 errors, warnings remain from existing code style
- `npm run build`: passed with escalated sandbox permission because the build
  reads generated/esbuild files outside the restricted sandbox path

## NAS Deployment

Deployment is intentionally deferred until NAS access is available again.

Use `DEPLOY_SYNOLOGY.md` when back on the home network. The short path is:

```bash
git archive --format=tar --output C:\tmp\audioserver-qobuz.tar HEAD
scp C:\tmp\audioserver-qobuz.tar Danny-a@192.168.2.58:/tmp/audioserver-qobuz.tar
ssh Danny-a@192.168.2.58
cd /volume1/docker/AudioServer
sudo tar -xf /tmp/audioserver-qobuz.tar -C /volume1/docker/AudioServer
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml up -d --build
```

## Manual Acceptance On NAS

- `/api/health` returns `status: ok`.
- `/api/providers/qobuz/status` returns:
  - `configured: true`
  - `authenticated: true`
  - `streamingAvailable: true`
- Qobuz search results appear.
- A Qobuz track plays beyond 60 seconds.
- The next queued Qobuz track also plays beyond 60 seconds.
- Tidal is not presented as reliable full playback.

## Known Limitations

- Real Qobuz playback still needs NAS-side credentials and a manual home-network
  acceptance test.
- Qobuz CDN URLs may be temporary, so queue playback must request a fresh stream
  URL per track.
- Some DLNA/Sonos/Volumio targets may reject direct HTTPS CDN streams. If that
  happens, a future authenticated server-side stream proxy is the likely fix.
- Spotify OAuth redirect URI still needs account-dashboard alignment when NAS
  access is available.

## Rollback

If the release fails on NAS:

1. Restore the previous working deployment archive or checkout the commit before
   `4090ffc`.
2. Rebuild with Docker Compose.
3. Keep the current database file intact unless a migration-specific issue is
   confirmed.

# Synology Deployment Runbook

Use this checklist when you are back on the home network and can reach the DiskStation.

## 1. Prepare The NAS Env

On the NAS, edit the deployment env file in `/volume1/docker/AudioServer/.env`.

Required for this Qobuz release:

```env
JWT_SECRET=generate-a-strong-secret-with-openssl-rand-hex-32
LOG_FORMAT=json
LOG_LEVEL=info
QOBUZ_APP_ID=your-qobuz-app-id
QOBUZ_APP_SECRET=your-qobuz-app-secret
QOBUZ_AUDIO_FORMAT=5
```

Optional:

```env
QOBUZ_USERNAME=your-qobuz-email
QOBUZ_PASSWORD=your-qobuz-password
```

If `QOBUZ_USERNAME` and `QOBUZ_PASSWORD` are omitted, log in from the AudioServer Settings page after deployment. The app stores only the Qobuz user token and account metadata, not the password.

Format choices:

```text
5  = MP3 320, most compatible
6  = FLAC 16/44.1
7  = FLAC 24/96
27 = FLAC 24/192
```

Start with `QOBUZ_AUDIO_FORMAT=5`. Move to FLAC only after browser and device playback are stable.

## 2. Publish From Windows

From this repo on Windows PowerShell:

```powershell
git status --short
git log -1 --oneline
git archive --format=tar --output C:\tmp\audioserver.tar HEAD
scp -O C:\tmp\audioserver.tar Danny-a@192.168.2.58:/tmp/audioserver.tar
```

Note the short commit id `git log -1 --oneline` prints (e.g. `e0ba630`): the
NAS has no git, so you pass it to the build below and the smoke check
confirms that this commit is what runs.

If hostname resolution works at home, `Danny-a@Diskstation` is also fine. The IP used previously was `192.168.2.58`.

## 3. Extract And Rebuild On The NAS

SSH into the NAS:

```bash
ssh Danny-a@192.168.2.58
cd /volume1/docker/AudioServer
```

Make sure `.env` exists and contains the Qobuz keys:

```bash
grep -E '^(QOBUZ_APP_ID|QOBUZ_APP_SECRET|QOBUZ_AUDIO_FORMAT|QOBUZ_USERNAME|QOBUZ_PASSWORD)=' .env
```

Extract the committed source archive:

```bash
sudo tar -xf /tmp/audioserver.tar -C /volume1/docker/AudioServer
```

Keep the running image as `previous`, so a rollback is one command and no
old archive is needed (section 6). Only tag a version that passed its smoke
check (after a failed deploy, the running image is not the one to keep), and
skip this on the very first install:

```bash
sudo docker tag audioserver_audioserver:latest audioserver_audioserver:previous
```

Rebuild and restart, with the commit id from section 2 (`sudo` drops exported
variables, so they go on the `sudo` line itself):

```bash
sudo VCS_REF=e0ba630 BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml up -d --build
```

Names: the Synology `docker-compose` (v1) calls the image
`audioserver_audioserver` and the container `audioserver_audioserver_1`.
Docker Compose v2 elsewhere uses dashes (`audioserver-audioserver-1`); the
commands in this runbook and in `docs/backup-restore.md` mean the same
container.

## 4. Verify

One command checks what a deploy can break, read-only and without a login:
ready, schema version, the running commit, the web app with all its files,
that the library is closed without a session, and the realtime handshake:

```bash
sh scripts/nas-smoke.sh http://localhost:3001 21 e0ba630
```

It waits up to 2 minutes for a container that is still starting and ends
with `All checks passed.` (exit code 0) or lists each `FAIL`. Leave the last
two arguments out to only print the schema version and build. The details
below are for when a check fails.

Container state:

```bash
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml ps
```

Logs:

```bash
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml logs --tail=120 audioserver
```

Crash check (an "api error 502" in the browser while the container is
`healthy` usually means the Node process died on one request and restarted;
the setup code changes on every restart, which is the tell-tale sign):

```bash
sudo docker logs --since 1h audioserver_audioserver_1 2>&1 | grep -B 40 "Node.js v" | head -80
```

The 40 lines before `Node.js v22...` are the stack trace of the exception.
Since 9 Sept 2026 route errors are answered with a logged `500` instead
(look for `"level":"error"` lines with a request id); a `Node.js v` line
after that date means an `uncaughtException` entry precedes it.

Health:

```bash
curl -s http://localhost:3001/api/health/ready
curl -s http://localhost:3001/api/health
```

Qobuz status after login/config:

```bash
curl -s http://localhost:3001/api/providers/qobuz/status
```

Expected Qobuz status when ready:

```json
{
  "data": {
    "configured": true,
    "authenticated": true,
    "streamingAvailable": true,
    "reason": "ready",
    "formatId": "5"
  }
}
```

## 5. Browser Acceptance

Open:

```text
http://diskstation:3001
```

First deployment (no accounts yet): the app shows the setup screen and asks
for the setup code. Read it from the log
(`docker-compose logs audioserver | grep "setup code"`) or from
`/data/setup-code.txt` in the data volume, or set `SETUP_CODE` in `.env`
before starting. Create the admin account with it.

Existing deployment: every account has to sign in again once after this
release (sessions are now stored server-side and revocable). Settings →
"Account & Sessions" shows signed-in devices, password change and sign-out.

Check:

- Settings shows Qobuz as configured.
- If not authenticated, log in on the Qobuz card.
- Search returns Qobuz tracks.
- A Qobuz track plays longer than 60 seconds.
- Queue next track fetches and plays a fresh Qobuz stream URL.
- Tidal playback shows the preview/full-playback unsupported message instead of pretending full playback works.

## 6. Rollback

**Quick rollback (same schema).** When the new release did not change the
schema version (the smoke check printed the same number as before), go back
to the image kept in section 3:

```bash
cd /volume1/docker/AudioServer
sudo docker tag audioserver_audioserver:previous audioserver_audioserver:latest
sudo /usr/local/bin/docker-compose -f docker-compose.yml up -d --no-build
sh scripts/nas-smoke.sh http://localhost:3001 21
```

`--no-build` matters: without it compose rebuilds from the new source that is
still on disk. Re-extract the previous archive before the next `--build`.

**Full rollback (schema changed, or no `previous` image).**

Before any update, take a backup (this is also step 1 of the update flow in
[docs/backup-restore.md](docs/backup-restore.md)):

```bash
docker exec audioserver-audioserver-1 npm run db:backup --workspace=server -- /data/backups/before-update.db
docker exec audioserver-audioserver-1 npm run db:verify --workspace=server -- /data/backups/before-update.db
```

On the NAS:

```bash
cd /volume1/docker/AudioServer
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml down
```

Then restore the previous source copy or re-extract the previous deployment archive, and run:

```bash
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml up -d --build
until curl -fsS http://localhost:3001/api/health/ready; do sleep 2; done
```

If the new release migrated the database, the old image refuses to start
("Database schema version N is newer than this build supports"). That is the
compatibility check doing its job: restore the pre-update backup with
`db:restore ... --yes` as described in
[docs/backup-restore.md](docs/backup-restore.md#rollback-procedure), then start
again. Only when `/api/health/ready` answers 200 is the rollback complete.

## 7. Forgotten Login

With no other admin to reset you in the app, use the container. List the
user names:

```bash
sudo docker exec audioserver_audioserver_1 npm run -s user:password --workspace=server
```

Set a new password (it is asked twice and not shown while typing; keep the
`-it`):

```bash
sudo docker exec -it audioserver_audioserver_1 npm run -s user:password --workspace=server -- <username>
```

It works while the server runs. Every session of that user is signed out;
API keys keep working.

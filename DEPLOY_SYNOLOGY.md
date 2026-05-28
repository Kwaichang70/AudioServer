# Synology Deployment Runbook

Use this checklist when you are back on the home network and can reach the DiskStation.

## 1. Prepare The NAS Env

On the NAS, edit the deployment env file in `/volume1/docker/AudioServer/.env`.

Required for this Qobuz release:

```env
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
git archive --format=tar --output C:\tmp\audioserver-qobuz.tar HEAD
scp C:\tmp\audioserver-qobuz.tar Danny-a@192.168.2.58:/tmp/audioserver-qobuz.tar
```

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
sudo tar -xf /tmp/audioserver-qobuz.tar -C /volume1/docker/AudioServer
```

Rebuild and restart:

```bash
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml up -d --build
```

## 4. Verify

Container state:

```bash
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml ps
```

Logs:

```bash
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml logs --tail=120 audioserver
```

Health:

```bash
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

Check:

- Settings shows Qobuz as configured.
- If not authenticated, log in on the Qobuz card.
- Search returns Qobuz tracks.
- A Qobuz track plays longer than 60 seconds.
- Queue next track fetches and plays a fresh Qobuz stream URL.
- Tidal playback shows the preview/full-playback unsupported message instead of pretending full playback works.

## 6. Rollback

On the NAS:

```bash
cd /volume1/docker/AudioServer
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml down
```

Then restore the previous source copy or re-extract the previous deployment archive, and run:

```bash
sudo /usr/local/bin/docker-compose -f /volume1/docker/AudioServer/docker-compose.yml up -d --build
```

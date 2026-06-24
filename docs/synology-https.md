# HTTPS on Synology (for Spotify OAuth + Web Playback SDK)

Spotify requires an **HTTPS** redirect URI on a real hostname (since April
2025 it rejects `http://` on LAN IPs/hostnames), and the Web Playback SDK
only runs in a **secure context** (HTTPS). So to play Spotify in the browser
you must reach AudioServer over `https://<something>` with a valid cert.

This runbook uses a free Synology DDNS hostname + Let's Encrypt + the DSM
reverse proxy. No owned domain required.

## 1. Free DDNS hostname

DSM → **Control Panel → External Access → DDNS → Add**

- Service provider: **Synology**
- Hostname: pick one, e.g. `mymusic.synology.me`
- Email: your account
- Tick "Get a certificate from Let's Encrypt and set as default" if offered —
  that does step 2 for you. Otherwise do step 2 manually.

`*.synology.me` certs are validated through Synology's own infrastructure, so
you usually don't need to port-forward 80/443 for the cert. If issuance fails,
temporarily forward TCP 80 on your router to the NAS and retry.

## 2. Let's Encrypt certificate

(Skip if step 1 already created it.)

DSM → **Control Panel → Security → Certificate → Add → Add a new certificate →
Get a certificate from Let's Encrypt**

- Domain name: `mymusic.synology.me`
- Email: your account
- Finish. Then **Settings** (the gear) → make sure this cert is assigned to the
  reverse-proxy service you create in step 3 (DSM usually auto-assigns by host).

## 3. Reverse proxy: HTTPS 443 → AudioServer 3001

DSM → **Control Panel → Login Portal → Advanced → Reverse Proxy → Create**
(older DSM: **Application Portal → Reverse Proxy**)

**General**

- Description: `AudioServer`
- Source:
  - Protocol: **HTTPS**
  - Hostname: `mymusic.synology.me`
  - Port: **443**
- Destination:
  - Protocol: **HTTP**
  - Hostname: `localhost`
  - Port: **3001**

**Custom Header** tab → **Create → WebSocket**

This is required — AudioServer uses Socket.IO (device events, scan progress),
which needs the WebSocket upgrade to pass through the proxy. Without it the
app loads but real-time updates silently fail.

Save.

## 4. Make the hostname resolve on your LAN

When you open `https://mymusic.synology.me` from a machine **inside** your LAN,
your router must send that back to the NAS (NAT hairpin / loopback). Most
routers do this automatically. If the page doesn't load from inside:

- Easiest: add a hosts entry on your PC →
  `192.168.2.58  mymusic.synology.me`
- Or set a local DNS record on your router pointing the hostname at the NAS IP.

From outside your LAN it resolves via Synology DDNS as normal (you'd also need
443 forwarded on the router if you want external access — optional).

## 5. Spotify Developer Dashboard

[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) →
your app → **Settings → Redirect URIs → Add**:

```
https://mymusic.synology.me/settings/callback/spotify
```

Save. (Keep `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` in `.env` as before.)

## 6. App config

In the NAS `.env`:

```env
ALLOWED_ORIGINS=https://mymusic.synology.me
```

Same-origin requests already pass regardless, but setting this keeps the CORS
allowlist correct for the new origin. Rebuild/restart the container so it picks
up the env change.

## 7. Connect + play

1. Open the app at **`https://mymusic.synology.me`** (not `diskstation:3001` —
   the SDK needs the secure context).
2. Settings → Streaming Providers → **Connect Spotify**. The redirect now uses
   the HTTPS origin verbatim (fixed in code), Spotify accepts it, and you're
   bounced back authenticated.
3. Play any Spotify track with the output device set to **browser**. The Web
   Playback SDK loads, registers "AudioServer Web" as a device, and plays in
   the tab. Progress / play-pause / auto-next all track the SDK.

## Troubleshooting

- **400 at accounts.spotify.com** — the redirect URI in the Spotify dashboard
  doesn't exactly match what the app sent. It must be the HTTPS hostname,
  character-for-character, including `/settings/callback/spotify`.
- **"Premium required" toast** — the SDK won't run on free accounts.
- **Real-time updates dead, playback fine** — WebSocket header missing in the
  reverse proxy (step 3).
- **Cert warning in browser** — the reverse proxy isn't using the Let's Encrypt
  cert; reassign it in Control Panel → Security → Certificate → Settings.
- **SDK silent / "secure context" error** — you opened the app over HTTP or the
  LAN IP. Use the `https://` hostname.

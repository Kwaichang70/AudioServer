import { Router } from 'express';
import { providers } from '../providers/registry.js';
import { logger } from '../logger.js';

export const providersRouter = Router();

const { tidal, spotify } = providers;

// ─── Unified search across all active providers ──────────────────

providersRouter.get('/search', async (req, res) => {
  const q = req.query.q as string;
  if (!q) {
    res.json({ data: { artists: [], albums: [], tracks: [], playlists: [] } });
    return;
  }
  try {
    const results = await providers.searchAll(q);
    res.json({ data: results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── All providers status ────────────────────────────────────────

providersRouter.get('/status', (_req, res) => {
  res.json({
    data: {
      tidal: {
        available: tidal.isAvailable,
        authenticated: tidal.auth.isAuthenticated,
        configured: !!(process.env.TIDAL_CLIENT_ID && process.env.TIDAL_CLIENT_SECRET),
      },
      spotify: {
        available: spotify.isAvailable,
        authenticated: spotify.auth.isAuthenticated,
        configured: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
      },
    },
  });
});

// ─── Tidal ───────────────────────────────────────────────────────

providersRouter.get('/tidal/status', (_req, res) => {
  res.json({
    data: {
      available: tidal.isAvailable,
      authenticated: tidal.auth.isAuthenticated,
      configured: !!(process.env.TIDAL_CLIENT_ID && process.env.TIDAL_CLIENT_SECRET),
    },
  });
});

providersRouter.post('/tidal/auth/init', (req, res) => {
  if (!tidal.isAvailable) {
    res.status(400).json({ error: 'Tidal not configured. Set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET.' });
    return;
  }
  const { redirectUri } = req.body;
  if (!redirectUri) { res.status(400).json({ error: 'redirectUri required' }); return; }
  res.json({ data: { authUrl: tidal.getAuthUrl(redirectUri) } });
});

providersRouter.post('/tidal/auth/callback', async (req, res) => {
  const { code, redirectUri } = req.body;
  if (!code || !redirectUri) { res.status(400).json({ error: 'code and redirectUri required' }); return; }
  try {
    await tidal.auth.login({ code, redirectUri });
    logger.info('Tidal: OAuth flow completed');
    res.json({ data: { authenticated: true } });
  } catch (err) {
    logger.error(`Tidal auth callback failed: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

providersRouter.post('/tidal/auth/logout', async (_req, res) => {
  await tidal.auth.logout();
  res.json({ data: { authenticated: false } });
});

providersRouter.get('/tidal/search', async (req, res) => {
  const q = req.query.q as string;
  if (!q) { res.json({ data: { artists: [], albums: [], tracks: [], playlists: [] } }); return; }
  try {
    res.json({ data: await tidal.search(q) });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─── Spotify ─────────────────────────────────────────────────────

providersRouter.get('/spotify/status', (_req, res) => {
  res.json({
    data: {
      available: spotify.isAvailable,
      authenticated: spotify.auth.isAuthenticated,
      configured: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    },
  });
});

providersRouter.post('/spotify/auth/init', (req, res) => {
  if (!spotify.isAvailable) {
    res.status(400).json({ error: 'Spotify not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.' });
    return;
  }
  const { redirectUri } = req.body;
  if (!redirectUri) { res.status(400).json({ error: 'redirectUri required' }); return; }
  res.json({ data: { authUrl: spotify.getAuthUrl(redirectUri) } });
});

providersRouter.post('/spotify/auth/callback', async (req, res) => {
  const { code, redirectUri } = req.body;
  if (!code || !redirectUri) { res.status(400).json({ error: 'code and redirectUri required' }); return; }
  try {
    await spotify.auth.login({ code, redirectUri });
    logger.info('Spotify: OAuth flow completed');
    res.json({ data: { authenticated: true } });
  } catch (err) {
    logger.error(`Spotify auth callback failed: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

providersRouter.post('/spotify/auth/logout', async (_req, res) => {
  await spotify.auth.logout();
  res.json({ data: { authenticated: false } });
});

providersRouter.get('/spotify/search', async (req, res) => {
  const q = req.query.q as string;
  if (!q) { res.json({ data: { artists: [], albums: [], tracks: [], playlists: [] } }); return; }
  try {
    res.json({ data: await spotify.search(q) });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─── Spotify Connect ─────────────────────────────────────────────

// List Spotify Connect devices (phones, speakers, etc.)
providersRouter.get('/spotify/connect/devices', async (_req, res) => {
  try {
    const devices = await spotify.getConnectDevices();
    res.json({ data: devices });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Get current Spotify playback state
providersRouter.get('/spotify/connect/state', async (_req, res) => {
  try {
    const state = await spotify.getPlaybackState();
    res.json({ data: state });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Play a track on a Spotify Connect device
providersRouter.post('/spotify/connect/play', async (req, res) => {
  const { trackUri, contextUri, deviceId, offset } = req.body;
  try {
    if (contextUri) {
      await spotify.connectPlayContext(contextUri, deviceId, offset);
    } else if (trackUri) {
      await spotify.connectPlay(trackUri, deviceId);
    }
    res.json({ data: { ok: true } });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

providersRouter.post('/spotify/connect/pause', async (req, res) => {
  try {
    await spotify.connectPause(req.body.deviceId);
    res.json({ data: { ok: true } });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

providersRouter.post('/spotify/connect/resume', async (req, res) => {
  try {
    await spotify.connectResume(req.body.deviceId);
    res.json({ data: { ok: true } });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

providersRouter.post('/spotify/connect/next', async (req, res) => {
  try {
    await spotify.connectNext(req.body.deviceId);
    res.json({ data: { ok: true } });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

providersRouter.post('/spotify/connect/previous', async (req, res) => {
  try {
    await spotify.connectPrevious(req.body.deviceId);
    res.json({ data: { ok: true } });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

providersRouter.post('/spotify/connect/volume', async (req, res) => {
  try {
    await spotify.connectSetVolume(req.body.volume, req.body.deviceId);
    res.json({ data: { ok: true } });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

providersRouter.post('/spotify/connect/transfer', async (req, res) => {
  try {
    await spotify.connectTransferPlayback(req.body.deviceId);
    res.json({ data: { ok: true } });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Spotify user albums
providersRouter.get('/spotify/albums', async (_req, res) => {
  try {
    const result = await spotify.getAlbums();
    res.json({ data: result.items, meta: { total: result.total } });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// Spotify user playlists
providersRouter.get('/spotify/playlists', async (_req, res) => {
  try {
    const playlists = await spotify.getPlaylists();
    res.json({ data: playlists });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

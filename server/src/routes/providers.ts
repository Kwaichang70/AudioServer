import { Router } from 'express';
import { TidalProvider } from '../providers/tidal.js';
import { SpotifyProvider } from '../providers/spotify.js';
import { logger } from '../logger.js';

export const providersRouter = Router();

const tidal = new TidalProvider();
const spotify = new SpotifyProvider();

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

// Step 1: Get the Tidal login URL
providersRouter.post('/tidal/auth/init', (req, res) => {
  if (!tidal.isAvailable) {
    res.status(400).json({ error: 'Tidal not configured. Set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET.' });
    return;
  }
  const { redirectUri } = req.body;
  if (!redirectUri) {
    res.status(400).json({ error: 'redirectUri required' });
    return;
  }
  const authUrl = tidal.getAuthUrl(redirectUri);
  res.json({ data: { authUrl } });
});

// Step 2: Exchange the authorization code for tokens
providersRouter.post('/tidal/auth/callback', async (req, res) => {
  const { code, redirectUri } = req.body;
  if (!code || !redirectUri) {
    res.status(400).json({ error: 'code and redirectUri required' });
    return;
  }
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

// Tidal search (requires auth)
providersRouter.get('/tidal/search', async (req, res) => {
  const q = req.query.q as string;
  if (!q) {
    res.json({ data: { artists: [], albums: [], tracks: [], playlists: [] } });
    return;
  }
  try {
    const results = await tidal.search(q);
    res.json({ data: results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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
  if (!redirectUri) {
    res.status(400).json({ error: 'redirectUri required' });
    return;
  }
  const authUrl = spotify.getAuthUrl(redirectUri);
  res.json({ data: { authUrl } });
});

providersRouter.post('/spotify/auth/callback', async (req, res) => {
  const { code, redirectUri } = req.body;
  if (!code || !redirectUri) {
    res.status(400).json({ error: 'code and redirectUri required' });
    return;
  }
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
  if (!q) {
    res.json({ data: { artists: [], albums: [], tracks: [], playlists: [] } });
    return;
  }
  try {
    const results = await spotify.search(q);
    res.json({ data: results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── All providers status ────────────────────────────────────────

providersRouter.get('/status', (_req, res) => {
  res.json({
    data: {
      tidal: { available: tidal.isAvailable, authenticated: tidal.auth.isAuthenticated },
      spotify: { available: spotify.isAvailable, authenticated: spotify.auth.isAuthenticated },
    },
  });
});

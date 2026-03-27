import { Router } from 'express';
import { TidalProvider } from '../providers/tidal.js';
import { logger } from '../logger.js';

export const providersRouter = Router();

// Singleton Tidal provider
const tidal = new TidalProvider();

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

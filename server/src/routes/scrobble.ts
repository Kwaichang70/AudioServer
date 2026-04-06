import { Router } from 'express';
import { scrobbler } from '../services/scrobbler.js';

export const scrobbleRouter = Router();

// Get scrobbling config
scrobbleRouter.get('/config', (_req, res) => {
  const config = scrobbler.getConfig();
  res.json({
    data: {
      lastfm: {
        enabled: config.lastfmEnabled,
        username: config.lastfmUsername,
        configured: !!(process.env.LASTFM_API_KEY && process.env.LASTFM_API_SECRET),
      },
      listenbrainz: {
        enabled: config.listenbrainzEnabled,
        configured: true, // Only needs user token, no env vars
      },
    },
  });
});

// Last.fm: get auth URL
scrobbleRouter.get('/lastfm/auth-url', (_req, res) => {
  if (!process.env.LASTFM_API_KEY) {
    res.status(400).json({ error: 'LASTFM_API_KEY not configured' });
    return;
  }
  res.json({ data: { url: scrobbler.getLastfmAuthUrl() } });
});

// Last.fm: complete auth with token
scrobbleRouter.post('/lastfm/auth', async (req, res) => {
  const { token } = req.body;
  if (!token) { res.status(400).json({ error: 'token required' }); return; }
  try {
    const username = await scrobbler.authenticateLastfm(token);
    res.json({ data: { username, authenticated: true } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Last.fm: disconnect
scrobbleRouter.post('/lastfm/disconnect', (_req, res) => {
  scrobbler.saveConfig({ lastfmEnabled: false, lastfmSessionKey: null, lastfmUsername: null });
  res.json({ data: { ok: true } });
});

// ListenBrainz: connect with token
scrobbleRouter.post('/listenbrainz/auth', async (req, res) => {
  const { token } = req.body;
  if (!token) { res.status(400).json({ error: 'token required' }); return; }
  try {
    const valid = await scrobbler.validateListenbrainz(token);
    if (!valid) { res.status(401).json({ error: 'Invalid ListenBrainz token' }); return; }
    res.json({ data: { authenticated: true } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ListenBrainz: disconnect
scrobbleRouter.post('/listenbrainz/disconnect', (_req, res) => {
  scrobbler.saveConfig({ listenbrainzEnabled: false, listenbrainzToken: null });
  res.json({ data: { ok: true } });
});

// Manual scrobble trigger (for testing)
scrobbleRouter.post('/scrobble', (req, res) => {
  const { title, artist, album, duration } = req.body;
  if (!title || !artist) { res.status(400).json({ error: 'title and artist required' }); return; }
  scrobbler.scrobble({ title, artist, album, duration });
  res.json({ data: { ok: true } });
});

// Now playing update
scrobbleRouter.post('/now-playing', async (req, res) => {
  const { title, artist, album, duration } = req.body;
  if (!title || !artist) { res.status(400).json({ error: 'title and artist required' }); return; }
  await scrobbler.nowPlaying({ title, artist, album, duration });
  res.json({ data: { ok: true } });
});

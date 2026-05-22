import { Router } from 'express';
import { z } from 'zod';
import { scrobbler } from '../services/scrobbler.js';
import { validate } from '../utils/validate.js';

export const scrobbleRouter = Router();

const tokenSchema = z.object({ token: z.string().min(1).max(2048) });
const scrobbleSchema = z.object({
  title: z.string().min(1).max(500),
  artist: z.string().min(1).max(500),
  album: z.string().max(500).optional(),
  duration: z.number().nonnegative().optional(),
});

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
scrobbleRouter.post('/lastfm/auth', validate({ body: tokenSchema }), async (req, res) => {
  try {
    const username = await scrobbler.authenticateLastfm(req.body.token);
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
scrobbleRouter.post('/listenbrainz/auth', validate({ body: tokenSchema }), async (req, res) => {
  try {
    const valid = await scrobbler.validateListenbrainz(req.body.token);
    if (!valid) {
      res.status(401).json({ error: 'Invalid ListenBrainz token' });
      return;
    }
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
scrobbleRouter.post('/scrobble', validate({ body: scrobbleSchema }), (req, res) => {
  scrobbler.scrobble(req.body);
  res.json({ data: { ok: true } });
});

// Now playing update
scrobbleRouter.post('/now-playing', validate({ body: scrobbleSchema }), async (req, res) => {
  await scrobbler.nowPlaying(req.body);
  res.json({ data: { ok: true } });
});

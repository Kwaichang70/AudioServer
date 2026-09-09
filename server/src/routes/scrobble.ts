import { Router } from 'express';
import { z } from 'zod';
import { scrobbler } from '../services/scrobbler.js';
import { validate } from '../utils/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireOwner } from '../utils/ownership.js';

// Scrobbling is personal (V09.3): a Last.fm session key identifies a person,
// so every account connects and disconnects its own, and a listen is
// submitted with the credentials of whoever listened. The API key/secret in
// the environment stay household-wide — they identify the app, not a person.

export const scrobbleRouter = Router();

const tokenSchema = z.object({ token: z.string().min(1).max(2048) });
const scrobbleSchema = z.object({
  title: z.string().min(1).max(500),
  artist: z.string().min(1).max(500),
  album: z.string().max(500).optional(),
  duration: z.number().nonnegative().optional(),
});

// Get scrobbling config
scrobbleRouter.get('/config', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const config = scrobbler.getConfig(owner);
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

// Last.fm: get auth URL (fetches a request token + builds api_key+token URL)
scrobbleRouter.get(
  '/lastfm/auth-url',
  asyncHandler(async (_req, res) => {
    if (!process.env.LASTFM_API_KEY) {
      res.status(400).json({ error: 'LASTFM_API_KEY not configured' });
      return;
    }
    try {
      res.json({ data: await scrobbler.getLastfmAuthUrl() });
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  }),
);

// Last.fm: complete auth with token
scrobbleRouter.post(
  '/lastfm/auth',
  validate({ body: tokenSchema }),
  asyncHandler(async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const username = await scrobbler.authenticateLastfm(owner, req.body.token);
      res.json({ data: { username, authenticated: true } });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  }),
);

// Last.fm: disconnect
scrobbleRouter.post('/lastfm/disconnect', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  scrobbler.saveConfig(owner, {
    lastfmEnabled: false,
    lastfmSessionKey: null,
    lastfmUsername: null,
  });
  res.json({ data: { ok: true } });
});

// ListenBrainz: connect with token
scrobbleRouter.post(
  '/listenbrainz/auth',
  validate({ body: tokenSchema }),
  asyncHandler(async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      const valid = await scrobbler.validateListenbrainz(owner, req.body.token);
      if (!valid) {
        res.status(401).json({ error: 'Invalid ListenBrainz token' });
        return;
      }
      res.json({ data: { authenticated: true } });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  }),
);

// ListenBrainz: disconnect
scrobbleRouter.post('/listenbrainz/disconnect', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  scrobbler.saveConfig(owner, { listenbrainzEnabled: false, listenbrainzToken: null });
  res.json({ data: { ok: true } });
});

// Manual scrobble trigger (for testing)
scrobbleRouter.post('/scrobble', validate({ body: scrobbleSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  scrobbler.scrobble(req.body, { userId: owner });
  res.json({ data: { ok: true } });
});

// Now playing update
scrobbleRouter.post(
  '/now-playing',
  validate({ body: scrobbleSchema }),
  asyncHandler(async (req, res) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    await scrobbler.nowPlaying(req.body, owner);
    res.json({ data: { ok: true } });
  }),
);

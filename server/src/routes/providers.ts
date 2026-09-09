import { Router } from 'express';
import { z } from 'zod';
import { providers } from '../providers/registry.js';
import { QobuzProviderError } from '../providers/qobuz.js';
import { SpotifyProviderError } from '../providers/spotify.js';
import { logger } from '../logger.js';
import { requireAdmin } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { parseSearchOptions, unifiedSearch } from '../services/search.js';

// Provider connections are global for the whole household (one Spotify/Tidal/
// Qobuz account per server), so connecting, completing OAuth and disconnecting
// are admin-only. Reading status, searching and streaming stay open to every
// signed-in user. See docs/permissions.md.
const oauthInitSchema = z.object({ redirectUri: z.string().url().max(2048) });
const oauthCallbackSchema = z.object({
  code: z.string().min(1).max(4096),
  redirectUri: z.string().url().max(2048),
});
const qobuzLoginSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
});

export const providersRouter = Router();

const { tidal, spotify, qobuz } = providers;

function qobuzStatus() {
  return qobuz.getStatus();
}

function sendQobuzError(res: import('express').Response, err: unknown): void {
  if (err instanceof QobuzProviderError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'qobuz_stream_unavailable', message: String(err) });
}

/**
 * Provider failures reach the browser with the status and reason the user
 * can act on (reconnect, wait for the rate limit, Premium) instead of a
 * generic 500 (V04.4).
 */
function sendProviderError(res: import('express').Response, err: unknown): void {
  if (err instanceof SpotifyProviderError) {
    if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof QobuzProviderError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }
  res.status(500).json({ error: 'ProviderError', message: String(err) });
}

// ─── Unified search across all active providers ──────────────────

// Query: q, sources=local,qobuz (default all), quality=lossless|hires,
// format=flac, limit. Response carries per-source status and, per track,
// what can play it and where else it exists (V07.2 / V07.4).
providersRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.json({ data: { artists: [], albums: [], tracks: [], playlists: [], sources: [] } });
      return;
    }
    try {
      const results = await unifiedSearch(q, parseSearchOptions(req.query));
      res.json({ data: results });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

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
      qobuz: {
        ...qobuzStatus(),
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

providersRouter.post(
  '/tidal/auth/init',
  requireAdmin,
  validate({ body: oauthInitSchema }),
  (req, res) => {
    if (!tidal.isAvailable) {
      res
        .status(400)
        .json({ error: 'Tidal not configured. Set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET.' });
      return;
    }
    const { redirectUri } = req.body;
    res.json({ data: { authUrl: tidal.getAuthUrl(redirectUri) } });
  },
);

providersRouter.post(
  '/tidal/auth/callback',
  requireAdmin,
  validate({ body: oauthCallbackSchema }),
  asyncHandler(async (req, res) => {
    const { code, redirectUri } = req.body;
    try {
      await tidal.auth.login({ code, redirectUri });
      logger.info('Tidal: OAuth flow completed');
      res.json({ data: { authenticated: true } });
    } catch (err) {
      logger.error(`Tidal auth callback failed: ${err}`);
      sendProviderError(res, err);
    }
  }),
);

providersRouter.post(
  '/tidal/auth/logout',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await tidal.auth.logout();
    res.json({ data: { authenticated: false } });
  }),
);

// Tidal album detail + tracks
providersRouter.get(
  '/tidal/albums/:id',
  asyncHandler(async (req, res) => {
    try {
      const album = await tidal.getAlbum(req.params.id);
      res.json({ data: album });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.get(
  '/tidal/albums/:id/tracks',
  asyncHandler(async (req, res) => {
    try {
      const tracks = await tidal.getAlbumTracks(req.params.id);
      res.json({ data: tracks, meta: { total: tracks.length } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// Tidal stream URL
providersRouter.get('/tidal/tracks/:id/stream', (_req, res) => {
  res.status(410).json({
    error: 'tidal_preview_only',
    message:
      'Tidal full-track playback is not supported in AudioServer. Use Qobuz or local NAS playback for full tracks.',
  });
});

// Tidal user playlists
providersRouter.get(
  '/tidal/playlists',
  asyncHandler(async (_req, res) => {
    try {
      const playlists = await tidal.getPlaylists();
      res.json({ data: playlists });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.get(
  '/tidal/playlists/:id/tracks',
  asyncHandler(async (req, res) => {
    try {
      const tracks = await tidal.getPlaylistTracks(req.params.id);
      res.json({ data: tracks, meta: { total: tracks.length } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// Tidal favorites/collection
providersRouter.get(
  '/tidal/favorites/albums',
  asyncHandler(async (_req, res) => {
    try {
      const albums = await tidal.getFavoriteAlbums();
      res.json({ data: albums });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.get(
  '/tidal/favorites/tracks',
  asyncHandler(async (_req, res) => {
    try {
      const tracks = await tidal.getFavoriteTracks();
      res.json({ data: tracks });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.get(
  '/tidal/favorites/artists',
  asyncHandler(async (_req, res) => {
    try {
      const artists = await tidal.getFavoriteArtists();
      res.json({ data: artists });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.get(
  '/tidal/search',
  asyncHandler(async (req, res) => {
    const q = req.query.q as string;
    if (!q) {
      res.json({ data: { artists: [], albums: [], tracks: [], playlists: [] } });
      return;
    }
    try {
      res.json({ data: await tidal.search(q) });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

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

providersRouter.post(
  '/spotify/auth/init',
  requireAdmin,
  validate({ body: oauthInitSchema }),
  (req, res) => {
    if (!spotify.isAvailable) {
      res.status(400).json({
        error: 'Spotify not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.',
      });
      return;
    }
    const { redirectUri } = req.body;
    res.json({ data: { authUrl: spotify.getAuthUrl(redirectUri) } });
  },
);

providersRouter.post(
  '/spotify/auth/callback',
  requireAdmin,
  validate({ body: oauthCallbackSchema }),
  asyncHandler(async (req, res) => {
    const { code, redirectUri } = req.body;
    try {
      await spotify.auth.login({ code, redirectUri });
      logger.info('Spotify: OAuth flow completed');
      res.json({ data: { authenticated: true } });
    } catch (err) {
      logger.error(`Spotify auth callback failed: ${err}`);
      sendProviderError(res, err);
    }
  }),
);

providersRouter.post(
  '/spotify/auth/logout',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await spotify.auth.logout();
    res.json({ data: { authenticated: false } });
  }),
);

providersRouter.get(
  '/spotify/search',
  asyncHandler(async (req, res) => {
    const q = req.query.q as string;
    if (!q) {
      res.json({ data: { artists: [], albums: [], tracks: [], playlists: [] } });
      return;
    }
    try {
      res.json({ data: await spotify.search(q) });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// ─── Qobuz (username/password login, no OAuth) ──────────────────

providersRouter.get('/qobuz/status', (_req, res) => {
  res.json({ data: qobuzStatus() });
});

// Login with username + password
providersRouter.post(
  '/qobuz/auth/login',
  requireAdmin,
  validate({ body: qobuzLoginSchema }),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    try {
      await qobuz.auth.login({ username, password });
      logger.info('Qobuz: Login successful');
      res.json({ data: qobuzStatus() });
    } catch (err) {
      logger.error(`Qobuz login failed: ${err}`);
      sendQobuzError(res, err);
    }
  }),
);

providersRouter.post(
  '/qobuz/auth/logout',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    await qobuz.auth.logout();
    res.json({ data: qobuzStatus() });
  }),
);

// Qobuz album detail + tracks
providersRouter.get(
  '/qobuz/albums/:id',
  asyncHandler(async (req, res) => {
    try {
      const album = await qobuz.getAlbum(req.params.id);
      res.json({ data: album });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.get(
  '/qobuz/albums/:id/tracks',
  asyncHandler(async (req, res) => {
    try {
      const tracks = await qobuz.getAlbumTracks(req.params.id);
      res.json({ data: tracks, meta: { total: tracks.length } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// Stream URL for a track (returns direct Qobuz CDN URL)
providersRouter.get(
  '/qobuz/tracks/:id/stream',
  asyncHandler(async (req, res) => {
    try {
      const stream = await qobuz.getStreamInfo(req.params.id);
      res.json({ data: stream });
    } catch (err) {
      sendQobuzError(res, err);
    }
  }),
);

providersRouter.get(
  '/qobuz/search',
  asyncHandler(async (req, res) => {
    const q = req.query.q as string;
    if (!q) {
      res.json({ data: { artists: [], albums: [], tracks: [], playlists: [] } });
      return;
    }
    try {
      res.json({ data: await qobuz.search(q) });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// ─── Spotify Connect ─────────────────────────────────────────────

// Issue a short-lived Spotify access token for the browser Web Playback SDK.
// The SDK's getOAuthToken callback fetches this; the server holds the OAuth
// tokens and refreshes them, so the browser never sees the client secret or a
// refresh token. Requires the user to have completed Spotify OAuth (Premium +
// the `streaming` scope, both already requested in the auth URL).
providersRouter.get(
  '/spotify/token',
  asyncHandler(async (_req, res) => {
    if (!spotify.auth.isAuthenticated) {
      res.status(401).json({ error: 'Spotify not connected' });
      return;
    }
    try {
      const token = await spotify.getWebPlaybackToken();
      res.json({ data: token });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// List Spotify Connect devices (phones, speakers, etc.). Best-effort UI poll:
// degrade to an empty list on any error (e.g. a transient 429 cooldown) instead
// of a 500, so a rate-limit blip doesn't spam the client console with errors.
providersRouter.get(
  '/spotify/connect/devices',
  asyncHandler(async (_req, res) => {
    try {
      const devices = await spotify.getConnectDevices();
      res.json({ data: devices });
    } catch (err) {
      // A rate limit or a Premium/Development-Mode refusal is something the
      // user can act on; only unknown failures degrade to "no devices".
      if (err instanceof SpotifyProviderError) {
        sendProviderError(res, err);
        return;
      }
      logger.warn(`spotify connect/devices unavailable: ${String(err)}`);
      res.json({ data: [] });
    }
  }),
);

// Get current Spotify playback state. Best-effort poll: return null on error
// rather than 500 (the client polls this every few seconds while a Connect
// device plays; a transient failure shouldn't surface as a console error).
providersRouter.get(
  '/spotify/connect/state',
  asyncHandler(async (_req, res) => {
    try {
      const state = await spotify.getPlaybackState();
      res.json({ data: state });
    } catch (err) {
      logger.warn(`spotify connect/state unavailable: ${String(err)}`);
      res.json({ data: null });
    }
  }),
);

// Play a track on a Spotify Connect device
providersRouter.post(
  '/spotify/connect/play',
  asyncHandler(async (req, res) => {
    const { trackUri, contextUri, deviceId, offset } = req.body;
    try {
      if (contextUri) {
        await spotify.connectPlayContext(contextUri, deviceId, offset);
      } else if (trackUri) {
        await spotify.connectPlay(trackUri, deviceId);
      }
      res.json({ data: { ok: true } });
    } catch (err) {
      const msg = String(err);
      if (msg.includes('NO_ACTIVE_DEVICE') || msg.includes('No active device')) {
        res.status(404).json({
          error: 'No active Spotify device. Open Spotify on your phone or desktop first.',
        });
      } else {
        res.status(500).json({ error: msg });
      }
    }
  }),
);

providersRouter.post(
  '/spotify/connect/pause',
  asyncHandler(async (req, res) => {
    try {
      await spotify.connectPause(req.body.deviceId);
      res.json({ data: { ok: true } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.post(
  '/spotify/connect/resume',
  asyncHandler(async (req, res) => {
    try {
      await spotify.connectResume(req.body.deviceId);
      res.json({ data: { ok: true } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.post(
  '/spotify/connect/next',
  asyncHandler(async (req, res) => {
    try {
      await spotify.connectNext(req.body.deviceId);
      res.json({ data: { ok: true } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.post(
  '/spotify/connect/previous',
  asyncHandler(async (req, res) => {
    try {
      await spotify.connectPrevious(req.body.deviceId);
      res.json({ data: { ok: true } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.post(
  '/spotify/connect/volume',
  asyncHandler(async (req, res) => {
    try {
      await spotify.connectSetVolume(req.body.volume, req.body.deviceId);
      res.json({ data: { ok: true } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.post(
  '/spotify/connect/transfer',
  asyncHandler(async (req, res) => {
    try {
      await spotify.connectTransferPlayback(req.body.deviceId);
      res.json({ data: { ok: true } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// Spotify album detail + tracks
providersRouter.get(
  '/spotify/albums/:id',
  asyncHandler(async (req, res) => {
    try {
      const album = await spotify.getAlbum(req.params.id);
      res.json({ data: album });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

providersRouter.get(
  '/spotify/albums/:id/tracks',
  asyncHandler(async (req, res) => {
    try {
      const tracks = await spotify.getAlbumTracks(req.params.id);
      res.json({ data: tracks, meta: { total: tracks.length } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// Spotify user albums
providersRouter.get(
  '/spotify/albums',
  asyncHandler(async (_req, res) => {
    try {
      const result = await spotify.getAlbums();
      res.json({ data: result.items, meta: { total: result.total } });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

// Spotify user playlists
providersRouter.get(
  '/spotify/playlists',
  asyncHandler(async (_req, res) => {
    try {
      const playlists = await spotify.getPlaylists();
      res.json({ data: playlists });
    } catch (err) {
      sendProviderError(res, err);
    }
  }),
);

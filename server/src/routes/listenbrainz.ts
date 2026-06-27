import { Router } from 'express';
import * as lb from '../services/listenbrainz.js';

export const listenbrainzRouter = Router();

// Is ListenBrainz connected? (cheap — just checks the stored token.)
listenbrainzRouter.get('/status', (_req, res) => {
  res.json({ data: { configured: lb.isConfigured() } });
});

// Top artists / releases / recordings for a range, each matched back to the
// local library so the UI can deep-link albums/artists you own.
listenbrainzRouter.get('/stats', async (req, res) => {
  if (!lb.isConfigured()) {
    res.json({
      data: {
        configured: false,
        userName: null,
        range: 'month',
        artists: [],
        releases: [],
        recordings: [],
      },
    });
    return;
  }
  const range = lb.parseRange(req.query.range);
  try {
    const [userName, artists, releases, recordings] = await Promise.all([
      lb.getUserName(),
      lb.topArtists(range),
      lb.topReleases(range),
      lb.topRecordings(range),
    ]);
    res.json({ data: { configured: true, userName, range, artists, releases, recordings } });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

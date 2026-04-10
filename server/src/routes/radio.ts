import { Router } from 'express';
import { radioProvider } from '../providers/radio.js';
import { getDb } from '../db/index.js';
import { radioStations } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const radioRouter = Router();

// ─── Featured NL stations (curated) ──────────────────────────────

radioRouter.get('/featured', (_req, res) => {
  res.json({ data: radioProvider.getFeaturedStations() });
});

// ─── Search ──────────────────────────────────────────────────────

radioRouter.get('/search', async (req, res) => {
  const q = (req.query.q as string) || '';
  const country = (req.query.country as string) ?? 'NL';
  const tag = req.query.tag as string | undefined;

  if (!q && !tag && !country) {
    res.json({ data: [] });
    return;
  }

  try {
    let results;
    if (tag) {
      results = await radioProvider.browseByTag(tag, country);
    } else if (q) {
      results = await radioProvider.searchStations(q, country);
    } else {
      results = await radioProvider.browseByCountry(country);
    }
    res.json({ data: results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Single station ──────────────────────────────────────────────

radioRouter.get('/stations/:uuid', async (req, res) => {
  try {
    // First check the cache table (favorited stations)
    const db = getDb();
    const cached = db.select().from(radioStations)
      .where(eq(radioStations.uuid, req.params.uuid))
      .get();
    if (cached) {
      res.json({
        data: {
          id: `radio:${cached.uuid}`,
          uuid: cached.uuid,
          name: cached.name,
          streamUrl: cached.streamUrl,
          genre: cached.genre ?? undefined,
          country: cached.country ?? undefined,
          language: cached.language ?? undefined,
          homepage: cached.homepage ?? undefined,
          faviconUrl: cached.faviconUrl ?? undefined,
          bitrate: cached.bitrate ?? undefined,
          codec: cached.codec ?? undefined,
        },
      });
      return;
    }

    const station = await radioProvider.getStation(req.params.uuid);
    if (!station) {
      res.status(404).json({ error: 'Station not found' });
      return;
    }
    res.json({ data: station });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Resolve stream URL for playback ─────────────────────────────

radioRouter.get('/stations/:uuid/stream', async (req, res) => {
  try {
    // Cache table first
    const db = getDb();
    const cached = db.select().from(radioStations)
      .where(eq(radioStations.uuid, req.params.uuid))
      .get();
    if (cached) {
      res.json({ data: { url: cached.streamUrl, name: cached.name, genre: cached.genre ?? undefined } });
      return;
    }

    const station = await radioProvider.getStation(req.params.uuid);
    if (!station) {
      res.status(404).json({ error: 'Station not found' });
      return;
    }
    res.json({ data: { url: station.streamUrl, name: station.name, genre: station.genre } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Favorite station: upsert cached metadata ────────────────────
// Called by the client right before toggling a favorite, so that the
// Favorites page can render without a round-trip to radio-browser.

radioRouter.post('/stations/cache', (req, res) => {
  const { uuid, name, streamUrl, genre, country, language, homepage, faviconUrl, bitrate, codec } = req.body || {};
  if (!uuid || !name || !streamUrl) {
    res.status(400).json({ error: 'uuid, name and streamUrl required' });
    return;
  }

  const db = getDb();
  const existing = db.select().from(radioStations).where(eq(radioStations.uuid, uuid)).get();
  if (existing) {
    db.update(radioStations).set({
      name, streamUrl, genre, country, language, homepage, faviconUrl, bitrate, codec,
    }).where(eq(radioStations.uuid, uuid)).run();
  } else {
    db.insert(radioStations).values({
      uuid, name, streamUrl, genre, country, language, homepage, faviconUrl, bitrate, codec,
    }).run();
  }
  res.json({ data: { ok: true } });
});

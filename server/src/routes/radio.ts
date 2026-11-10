import { Router } from 'express';
import { radioProvider } from '../providers/radio.js';
import { getDb } from '../db/index.js';
import { radioStations } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { asyncHandler } from '../utils/asyncHandler.js';
import { validate } from '../utils/validate.js';
import { logger } from '../logger.js';
import { z } from 'zod';

export const radioRouter = Router();

// ─── Featured NL stations (curated) ──────────────────────────────

radioRouter.get('/featured', (_req, res) => {
  res.json({ data: radioProvider.getFeaturedStations() });
});

// ─── Search ──────────────────────────────────────────────────────

radioRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = (req.query.q as string) || '';
    const country = (req.query.country as string) ?? 'NL';
    const tag = req.query.tag as string | undefined;

    if (!q && !tag && !country) {
      res.json({ data: [] });
      return;
    }

    let results;
    if (tag) {
      results = await radioProvider.browseByTag(tag, country);
    } else if (q) {
      results = await radioProvider.searchStations(q, country);
    } else {
      results = await radioProvider.browseByCountry(country);
    }
    res.json({ data: results });
  }),
);

// ─── Single station ──────────────────────────────────────────────

radioRouter.get(
  '/stations/:uuid',
  asyncHandler(async (req, res) => {
    try {
      // First check the cache table (favorited stations)
      const db = getDb();
      const cached = db
        .select()
        .from(radioStations)
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
      logger.warn(`Radio: station lookup failed: ${err}`);
      res.status(502).json({
        error: 'RadioUnavailable',
        message: 'The radio directory did not answer.',
      });
    }
  }),
);

// ─── Resolve stream URL for playback ─────────────────────────────

radioRouter.get(
  '/stations/:uuid/stream',
  asyncHandler(async (req, res) => {
    try {
      // Cache table first
      const db = getDb();
      const cached = db
        .select()
        .from(radioStations)
        .where(eq(radioStations.uuid, req.params.uuid))
        .get();
      if (cached) {
        res.json({
          data: { url: cached.streamUrl, name: cached.name, genre: cached.genre ?? undefined },
        });
        return;
      }

      const station = await radioProvider.getStation(req.params.uuid);
      if (!station) {
        res.status(404).json({ error: 'Station not found' });
        return;
      }
      res.json({ data: { url: station.streamUrl, name: station.name, genre: station.genre } });
    } catch (err) {
      logger.warn(`Radio: station lookup failed: ${err}`);
      res.status(502).json({
        error: 'RadioUnavailable',
        message: 'The radio directory did not answer.',
      });
    }
  }),
);

// ─── Favorite station: cache its metadata ────────────────────────
// Called by the client right before toggling a favorite, so that the
// Favorites page can render without a round-trip to radio-browser.
//
// The client says WHICH station; what is stored is what the server itself
// finds for that id (the curated list or radio-browser). The cache is read
// before both when a station plays, for everyone and for the speakers, so a
// stream URL taken from the request let any signed-in user point "Radio 538"
// at an address of their choosing for the whole household (S01).

const cacheBody = z.object({ uuid: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) });

radioRouter.post(
  '/stations/cache',
  validate({ body: cacheBody }),
  asyncHandler(async (req, res) => {
    const { uuid } = req.body as z.infer<typeof cacheBody>;
    const db = getDb();
    const existing = db.select().from(radioStations).where(eq(radioStations.uuid, uuid)).get();
    const station = await radioProvider.getStation(uuid);
    if (!station) {
      // The directory does not answer or no longer lists it: keep what the
      // server stored earlier, never take the caller's word for it.
      if (existing) {
        res.json({ data: { ok: true } });
        return;
      }
      res.status(404).json({ error: 'NotFound', message: 'That station was not found' });
      return;
    }
    const values = {
      name: station.name,
      streamUrl: station.streamUrl,
      genre: station.genre ?? null,
      country: station.country ?? null,
      language: station.language ?? null,
      homepage: station.homepage ?? null,
      faviconUrl: station.faviconUrl ?? null,
      bitrate: station.bitrate ?? null,
      codec: station.codec ?? null,
    };
    if (existing) {
      db.update(radioStations).set(values).where(eq(radioStations.uuid, uuid)).run();
    } else {
      db.insert(radioStations)
        .values({ uuid, ...values })
        .run();
    }
    res.json({ data: { ok: true } });
  }),
);

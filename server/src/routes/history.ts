import { Router } from 'express';
import { getDb } from '../db/index.js';
import { favorites, tracks, albums, artists, radioStations } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../utils/validate.js';
import { requireOwner } from '../utils/ownership.js';

export const historyRouter = Router();

// ─── Play History ────────────────────────────────────────────────
//
// V05: history, "recent" and top lists come from listening_sessions and count
// only qualified sessions (Last.fm rule: > 30 s track, at least half or four
// minutes heard). started_at is NULL for rows migrated from the old
// play_history table whose time was never recorded; they keep their place in
// counts but never claim to be "recent".

const ISO_STARTED = sql`CASE WHEN s.started_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', s.started_at, 'unixepoch') END`;

/**
 * Deprecated: pre-V05 clients reported a play the moment it started. Listens
 * are now measured server-side, so this is accepted and ignored rather than
 * writing a fictitious listen.
 */
historyRouter.post('/played', (_req, res) => {
  res.json({ data: { ok: true, deprecated: true } });
});

// Recently played albums (unique by album, most recent first)
historyRouter.get('/recent', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const db = getDb();
  const result = db.all(sql`
    SELECT s.album_id, a.title, a.artist_name, a.year, a.track_count,
      MAX(s.started_at) as last_played
    FROM listening_sessions s
    JOIN albums a ON a.id = s.album_id
    WHERE s.qualified = 1 AND s.user_id = ${owner}
      AND s.album_id IS NOT NULL AND s.started_at IS NOT NULL
    GROUP BY s.album_id
    ORDER BY last_played DESC
    LIMIT 20
  `);
  res.json({ data: result });
});

// Most played artists
historyRouter.get('/top-artists', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const db = getDb();
  const result = db.all(sql`
    SELECT s.artist_id as id, COALESCE(ar.name, s.artist_name) as name, COUNT(*) as play_count
    FROM listening_sessions s
    LEFT JOIN artists ar ON ar.id = s.artist_id
    WHERE s.qualified = 1 AND s.user_id = ${owner} AND s.artist_id IS NOT NULL
    GROUP BY s.artist_id
    ORDER BY play_count DESC
    LIMIT 10
  `);
  res.json({ data: result });
});

// Local listening statistics for a period (days back, default 30; 0 = all time)
historyRouter.get('/stats', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const daysRaw = parseInt(String(req.query.days ?? '30'), 10);
  const days = Number.isFinite(daysRaw) && daysRaw >= 0 ? Math.min(daysRaw, 3650) : 30;
  const since = days === 0 ? 0 : Math.floor(Date.now() / 1000) - days * 86400;
  const db = getDb();
  const totals = db.get(sql`
    SELECT COUNT(*) as listens, COALESCE(SUM(s.listened_ms), 0) as listened_ms,
      COUNT(DISTINCT s.track_id) as distinct_tracks
    FROM listening_sessions s
    WHERE s.qualified = 1 AND s.user_id = ${owner}
      AND (s.started_at IS NULL OR s.started_at >= ${since})
  `) as { listens: number; listened_ms: number; distinct_tracks: number };
  const topTracks = db.all(sql`
    SELECT s.track_id, s.title, s.artist_name, s.album_title, s.album_id, s.source,
      COUNT(*) as play_count, COALESCE(SUM(s.listened_ms), 0) as listened_ms
    FROM listening_sessions s
    WHERE s.qualified = 1 AND s.user_id = ${owner}
      AND (s.started_at IS NULL OR s.started_at >= ${since})
    GROUP BY s.track_id, s.title, s.artist_name
    ORDER BY play_count DESC, listened_ms DESC
    LIMIT 10
  `);
  const topArtists = db.all(sql`
    SELECT s.artist_id as id, s.artist_name as name, COUNT(*) as play_count,
      COALESCE(SUM(s.listened_ms), 0) as listened_ms
    FROM listening_sessions s
    WHERE s.qualified = 1 AND s.user_id = ${owner}
      AND (s.started_at IS NULL OR s.started_at >= ${since})
    GROUP BY COALESCE(s.artist_id, s.artist_name)
    ORDER BY play_count DESC, listened_ms DESC
    LIMIT 10
  `);
  const bySource = db.all(sql`
    SELECT s.source, COUNT(*) as play_count, COALESCE(SUM(s.listened_ms), 0) as listened_ms
    FROM listening_sessions s
    WHERE s.qualified = 1 AND s.user_id = ${owner}
      AND (s.started_at IS NULL OR s.started_at >= ${since})
    GROUP BY s.source
    ORDER BY play_count DESC
  `);
  res.json({
    data: {
      days,
      listens: totals.listens,
      listenedMs: totals.listened_ms,
      distinctTracks: totals.distinct_tracks,
      topTracks,
      topArtists,
      bySource,
    },
  });
});

// ─── Favorites ───────────────────────────────────────────────────

const favoriteSchema = z.object({
  itemType: z.enum(['track', 'album', 'artist', 'station']),
  itemId: z.string().min(1).max(256),
});

// Favourites are personal (V09.2): one row per user and item, so two people
// can like the same album without seeing each other's taste.
historyRouter.post('/favorites', validate({ body: favoriteSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { itemType, itemId } = req.body;

  const db = getDb();
  // Toggle: if exists, remove; if not, add
  const existing = db
    .select()
    .from(favorites)
    .where(
      and(
        eq(favorites.userId, owner),
        eq(favorites.itemType, itemType),
        eq(favorites.itemId, itemId),
      ),
    )
    .get();

  if (existing) {
    db.delete(favorites).where(eq(favorites.id, existing.id)).run();
    res.json({ data: { favorited: false } });
  } else {
    db.insert(favorites).values({ itemType, itemId, userId: owner }).run();
    res.json({ data: { favorited: true } });
  }
});

historyRouter.get('/favorites', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const itemType = (req.query.type as string) || 'album';
  const db = getDb();
  const favs = db
    .select()
    .from(favorites)
    .where(and(eq(favorites.userId, owner), eq(favorites.itemType, itemType)))
    .orderBy(desc(favorites.createdAt))
    .all();

  // Enrich with actual data
  if (itemType === 'album') {
    const enriched = favs
      .map((f) => {
        const album = db.select().from(albums).where(eq(albums.id, f.itemId)).get();
        return album ? { ...album, favorited: true } : null;
      })
      .filter(Boolean);
    res.json({ data: enriched });
  } else if (itemType === 'artist') {
    const enriched = favs
      .map((f) => {
        const artist = db.select().from(artists).where(eq(artists.id, f.itemId)).get();
        return artist ? { ...artist, favorited: true } : null;
      })
      .filter(Boolean);
    res.json({ data: enriched });
  } else if (itemType === 'station') {
    const enriched = favs
      .map((f) => {
        const s = db.select().from(radioStations).where(eq(radioStations.uuid, f.itemId)).get();
        if (!s) return null;
        return {
          id: `radio:${s.uuid}`,
          uuid: s.uuid,
          name: s.name,
          streamUrl: s.streamUrl,
          genre: s.genre ?? undefined,
          country: s.country ?? undefined,
          language: s.language ?? undefined,
          homepage: s.homepage ?? undefined,
          faviconUrl: s.faviconUrl ?? undefined,
          bitrate: s.bitrate ?? undefined,
          codec: s.codec ?? undefined,
          favorited: true,
        };
      })
      .filter(Boolean);
    res.json({ data: enriched });
  } else {
    res.json({ data: favs });
  }
});

// Favorites for tracks (enriched with track + album + artist data)
historyRouter.get('/favorites/tracks', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const db = getDb();
  const favs = db
    .select()
    .from(favorites)
    .where(and(eq(favorites.userId, owner), eq(favorites.itemType, 'track')))
    .orderBy(desc(favorites.createdAt))
    .all();

  const enriched = favs
    .map((f) => {
      const track = db.select().from(tracks).where(eq(tracks.id, f.itemId)).get();
      return track ? { ...track, favorited: true } : null;
    })
    .filter(Boolean);
  res.json({ data: enriched });
});

// Play history (track-level, chronological, paginated). Rows without a known
// time sort last and carry played_at: null.
historyRouter.get('/tracks', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
  const offset = (page - 1) * limit;

  const db = getDb();
  const result = db.all(sql`
    SELECT s.id, s.track_id, s.album_id, s.artist_id, s.source,
      ${ISO_STARTED} as played_at,
      s.listened_ms,
      s.title as track_title, COALESCE(s.duration, t.duration) as duration, t.track_number,
      s.album_title,
      s.artist_name
    FROM listening_sessions s
    LEFT JOIN tracks t ON t.id = s.track_id
    WHERE s.qualified = 1 AND s.user_id = ${owner}
    ORDER BY (s.started_at IS NULL) ASC, s.started_at DESC, s.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const totalResult = db.get(
    sql`SELECT COUNT(*) as count FROM listening_sessions s WHERE s.qualified = 1 AND s.user_id = ${owner}`,
  ) as { count: number } | undefined;
  const total = totalResult?.count || 0;

  res.json({ data: result, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});

// Check if item is favorited
historyRouter.get('/favorites/check', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { type, id } = req.query;
  if (!type || !id) return res.json({ data: { favorited: false } });

  const db = getDb();
  const existing = db
    .select()
    .from(favorites)
    .where(
      and(
        eq(favorites.userId, owner),
        eq(favorites.itemType, type as string),
        eq(favorites.itemId, id as string),
      ),
    )
    .get();

  res.json({ data: { favorited: !!existing } });
});

import { Router } from 'express';
import { getDb } from '../db/index.js';
import { playHistory, favorites, tracks, albums, artists } from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';

export const historyRouter = Router();

// ─── Play History ────────────────────────────────────────────────

historyRouter.post('/played', (req, res) => {
  const { trackId, albumId, artistId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const db = getDb();
  db.insert(playHistory).values({
    trackId,
    albumId: albumId || '',
    artistId: artistId || '',
  }).run();

  res.json({ data: { ok: true } });
});

// Recently played tracks (unique by album, most recent first)
historyRouter.get('/recent', (_req, res) => {
  const db = getDb();
  const result = db.all(sql`
    SELECT DISTINCT h.album_id, a.title, a.artist_name, a.year, a.track_count,
      MAX(h.played_at) as last_played
    FROM play_history h
    JOIN albums a ON a.id = h.album_id
    GROUP BY h.album_id
    ORDER BY last_played DESC
    LIMIT 20
  `);
  res.json({ data: result });
});

// Most played artists
historyRouter.get('/top-artists', (_req, res) => {
  const db = getDb();
  const result = db.all(sql`
    SELECT h.artist_id as id, ar.name, COUNT(*) as play_count
    FROM play_history h
    JOIN artists ar ON ar.id = h.artist_id
    GROUP BY h.artist_id
    ORDER BY play_count DESC
    LIMIT 10
  `);
  res.json({ data: result });
});

// ─── Favorites ───────────────────────────────────────────────────

historyRouter.post('/favorites', (req, res) => {
  const { itemType, itemId } = req.body;
  if (!itemType || !itemId) return res.status(400).json({ error: 'itemType and itemId required' });

  const db = getDb();
  // Toggle: if exists, remove; if not, add
  const existing = db.select().from(favorites)
    .where(and(eq(favorites.itemType, itemType), eq(favorites.itemId, itemId)))
    .get();

  if (existing) {
    db.delete(favorites).where(eq(favorites.id, existing.id)).run();
    res.json({ data: { favorited: false } });
  } else {
    db.insert(favorites).values({ itemType, itemId }).run();
    res.json({ data: { favorited: true } });
  }
});

historyRouter.get('/favorites', (req, res) => {
  const itemType = req.query.type as string || 'album';
  const db = getDb();
  const favs = db.select().from(favorites)
    .where(eq(favorites.itemType, itemType))
    .orderBy(desc(favorites.createdAt))
    .all();

  // Enrich with actual data
  if (itemType === 'album') {
    const enriched = favs.map((f) => {
      const album = db.select().from(albums).where(eq(albums.id, f.itemId)).get();
      return album ? { ...album, favorited: true } : null;
    }).filter(Boolean);
    res.json({ data: enriched });
  } else if (itemType === 'artist') {
    const enriched = favs.map((f) => {
      const artist = db.select().from(artists).where(eq(artists.id, f.itemId)).get();
      return artist ? { ...artist, favorited: true } : null;
    }).filter(Boolean);
    res.json({ data: enriched });
  } else {
    res.json({ data: favs });
  }
});

// Check if item is favorited
historyRouter.get('/favorites/check', (req, res) => {
  const { type, id } = req.query;
  if (!type || !id) return res.json({ data: { favorited: false } });

  const db = getDb();
  const existing = db.select().from(favorites)
    .where(and(eq(favorites.itemType, type as string), eq(favorites.itemId, id as string)))
    .get();

  res.json({ data: { favorited: !!existing } });
});

import { Router } from 'express';
import { z } from 'zod';
import { getRawDb } from '../db/index.js';
import { validate } from '../utils/validate.js';
import { requireOwner } from '../utils/ownership.js';

/**
 * Ratings (R06.4): one to five stars per person, for a track or an album.
 * Personal like favourites (V09): nobody sees another person's stars, and
 * they only feed that person's Focus filters and sorting.
 */
export const ratingsRouter = Router();

const itemType = z.enum(['track', 'album']);
const setSchema = z.object({
  itemType,
  itemId: z.string().min(1).max(256),
  /** null clears the rating. */
  rating: z.number().int().min(1).max(5).nullable(),
});

// Every rating of one type: fills the stars of a whole list at once.
ratingsRouter.get('/', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const type = itemType.safeParse(req.query.type);
  if (!type.success) return res.status(400).json({ error: 'Unknown item type' });
  const rows = getRawDb()
    .prepare('SELECT item_id, rating FROM ratings WHERE user_id = ? AND item_type = ?')
    .all(owner, type.data) as Array<{ item_id: string; rating: number }>;
  res.json({ data: Object.fromEntries(rows.map((r) => [r.item_id, r.rating])) });
});

ratingsRouter.put('/', validate({ body: setSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { itemType: type, itemId, rating } = req.body as z.infer<typeof setSchema>;
  const db = getRawDb();
  const table = type === 'track' ? 'tracks' : 'albums';
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(itemId)) {
    return res.status(404).json({ error: `Unknown ${type}` });
  }
  if (rating === null) {
    db.prepare('DELETE FROM ratings WHERE user_id = ? AND item_type = ? AND item_id = ?').run(
      owner,
      type,
      itemId,
    );
  } else {
    db.prepare(
      `INSERT INTO ratings (user_id, item_type, item_id, rating, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, item_type, item_id) DO UPDATE SET rating = excluded.rating,
                                                              updated_at = excluded.updated_at`,
    ).run(owner, type, itemId, rating, Math.floor(Date.now() / 1000));
  }
  res.json({ data: { itemType: type, itemId, rating } });
});

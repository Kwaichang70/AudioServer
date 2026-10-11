import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getRawDb } from '../db/index.js';
import { validate } from '../utils/validate.js';
import { requireOwner } from '../utils/ownership.js';
import { parseFocusQuery, serializeFocusQuery } from '../services/focus.js';
import { groupParams } from '../services/smart-playlists.js';

/**
 * Bookmarks (R05.3): a Focus question with a name — "Hi-Res jazz from the
 * seventies I never played" — one tap away in the sidebar. Personal, like
 * favourites (V09): a guessed id is a 404.
 */
export const bookmarksRouter = Router();

/** The pages that speak Focus. */
const FOCUS_PATHS = ['/albums', '/artists', '/tracks'] as const;

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  path: z.enum(FOCUS_PATHS),
  query: z.string().max(4000),
});
const updateSchema = z.object({ name: z.string().trim().min(1).max(120) });

/** Only Focus keys, in the server's own order: a bookmark is never arbitrary URL text. */
function normalizeQuery(query: string): string {
  return serializeFocusQuery(parseFocusQuery(Object.fromEntries(groupParams(query))));
}

interface BookmarkRow {
  id: string;
  name: string;
  path: string;
  query: string;
  createdAt: number | null;
}

const SELECT = 'SELECT id, name, path, query, created_at as createdAt FROM bookmarks';

bookmarksRouter.get('/', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const rows = getRawDb()
    .prepare(`${SELECT} WHERE user_id = ? ORDER BY name COLLATE NOCASE, created_at`)
    .all(owner) as BookmarkRow[];
  res.json({ data: rows });
});

bookmarksRouter.post('/', validate({ body: createSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { name, path, query } = req.body as z.infer<typeof createSchema>;
  const id = uuid();
  const db = getRawDb();
  db.prepare(
    'INSERT INTO bookmarks (id, user_id, name, path, query, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, owner, name, path, normalizeQuery(query), Math.floor(Date.now() / 1000));
  res.status(201).json({ data: db.prepare(`${SELECT} WHERE id = ?`).get(id) });
});

bookmarksRouter.patch('/:id', validate({ body: updateSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const db = getRawDb();
  const changed = db
    .prepare('UPDATE bookmarks SET name = ? WHERE id = ? AND user_id = ?')
    .run((req.body as z.infer<typeof updateSchema>).name, String(req.params.id), owner).changes;
  if (!changed) return res.status(404).json({ error: 'Bookmark not found' });
  res.json({ data: db.prepare(`${SELECT} WHERE id = ?`).get(String(req.params.id)) });
});

bookmarksRouter.delete('/:id', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const removed = getRawDb()
    .prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?')
    .run(String(req.params.id), owner).changes;
  if (!removed) return res.status(404).json({ error: 'Bookmark not found' });
  res.json({ data: { ok: true } });
});

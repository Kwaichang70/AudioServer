import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { getDb, getRawDb } from '../db/index.js';
import { smartPlaylists } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export const smartPlaylistsRouter = Router();

interface Rule {
  field: 'genre' | 'year' | 'format' | 'sampleRate' | 'bitDepth' | 'artistName';
  operator: 'equals' | 'contains' | 'greaterThan' | 'lessThan' | 'between';
  value: string;
  value2?: string; // for 'between'
}

function buildWhereClause(rules: Rule[]): { sql: string; params: any[] } {
  if (rules.length === 0) return { sql: '1=1', params: [] };

  const conditions: string[] = [];
  const params: any[] = [];

  const fieldMap: Record<string, string> = {
    genre: 'a.genre',
    year: 'a.year',
    format: 't.format',
    sampleRate: 't.sample_rate',
    bitDepth: 't.bit_depth',
    artistName: 't.artist_name',
  };

  for (const rule of rules) {
    const col = fieldMap[rule.field];
    if (!col) continue;

    switch (rule.operator) {
      case 'equals':
        conditions.push(`${col} = ?`);
        params.push(rule.value);
        break;
      case 'contains':
        conditions.push(`${col} LIKE ?`);
        params.push(`%${rule.value}%`);
        break;
      case 'greaterThan':
        conditions.push(`${col} > ?`);
        params.push(Number(rule.value));
        break;
      case 'lessThan':
        conditions.push(`${col} < ?`);
        params.push(Number(rule.value));
        break;
      case 'between':
        conditions.push(`${col} BETWEEN ? AND ?`);
        params.push(Number(rule.value), Number(rule.value2 || rule.value));
        break;
    }
  }

  return { sql: conditions.join(' AND '), params };
}

function executeSmartPlaylist(rules: Rule[], limit = 200): any[] {
  const raw = getRawDb();
  const { sql: where, params } = buildWhereClause(rules);

  return raw.prepare(`
    SELECT DISTINCT t.id, t.title, t.artist_name as artistName, t.album_title as albumTitle,
      t.album_id as albumId, t.duration, t.format, t.sample_rate as sampleRate,
      t.bit_depth as bitDepth, t.track_number as trackNumber
    FROM tracks t
    LEFT JOIN albums a ON a.id = t.album_id
    WHERE ${where}
    ORDER BY t.artist_name, t.album_title, t.disc_number, t.track_number
    LIMIT ?
  `).all(...params, limit);
}

// List all smart playlists
smartPlaylistsRouter.get('/', (_req, res) => {
  const db = getDb();
  const result = db.select().from(smartPlaylists).orderBy(smartPlaylists.name).all();
  res.json({ data: result });
});

// Create a smart playlist
smartPlaylistsRouter.post('/', (req, res) => {
  const { name, rules } = req.body;
  if (!name || !rules) return res.status(400).json({ error: 'name and rules required' });

  const db = getDb();
  const id = uuid();
  const parsedRules: Rule[] = typeof rules === 'string' ? JSON.parse(rules) : rules;
  const tracks = executeSmartPlaylist(parsedRules);

  db.insert(smartPlaylists).values({
    id,
    name,
    rules: JSON.stringify(parsedRules),
    trackCount: tracks.length,
  }).run();

  const created = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, id)).get();
  res.status(201).json({ data: created });
});

// Get smart playlist tracks (always re-evaluated)
smartPlaylistsRouter.get('/:id/tracks', (req, res) => {
  const db = getDb();
  const sp = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, req.params.id)).get();
  if (!sp) return res.status(404).json({ error: 'Smart playlist not found' });

  const rules: Rule[] = JSON.parse(sp.rules);
  const tracks = executeSmartPlaylist(rules);

  // Update track count
  db.update(smartPlaylists).set({ trackCount: tracks.length }).where(eq(smartPlaylists.id, sp.id)).run();

  res.json({ data: tracks, meta: { total: tracks.length } });
});

// Update a smart playlist
smartPlaylistsRouter.patch('/:id', (req, res) => {
  const { name, rules } = req.body;
  const db = getDb();

  const existing = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, req.params.id)).get();
  if (!existing) return res.status(404).json({ error: 'Smart playlist not found' });

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (rules !== undefined) {
    const parsedRules = typeof rules === 'string' ? JSON.parse(rules) : rules;
    updates.rules = JSON.stringify(parsedRules);
    updates.trackCount = executeSmartPlaylist(parsedRules).length;
  }

  if (Object.keys(updates).length > 0) {
    db.update(smartPlaylists).set(updates).where(eq(smartPlaylists.id, req.params.id)).run();
  }

  const updated = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, req.params.id)).get();
  res.json({ data: updated });
});

// Delete a smart playlist
smartPlaylistsRouter.delete('/:id', (req, res) => {
  const db = getDb();
  db.delete(smartPlaylists).where(eq(smartPlaylists.id, req.params.id)).run();
  res.json({ data: { ok: true } });
});

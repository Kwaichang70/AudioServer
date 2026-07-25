import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb, getRawDb } from '../db/index.js';
import { smartPlaylists } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { validate } from '../utils/validate.js';

export const smartPlaylistsRouter = Router();

const ruleFields = z.enum(['genre', 'year', 'format', 'sampleRate', 'bitDepth', 'artistName']);
const ruleOperators = z.enum(['equals', 'contains', 'greaterThan', 'lessThan', 'between']);
type RuleField = z.infer<typeof ruleFields>;
type RuleOperator = z.infer<typeof ruleOperators>;

const allowedOperators: Record<RuleField, readonly RuleOperator[]> = {
  genre: ['equals', 'contains'],
  year: ['equals', 'greaterThan', 'lessThan', 'between'],
  format: ['equals', 'contains'],
  sampleRate: ['equals', 'greaterThan', 'lessThan'],
  bitDepth: ['equals', 'greaterThan'],
  artistName: ['equals', 'contains'],
};

const numericFields = new Set<RuleField>(['year', 'sampleRate', 'bitDepth']);
const ruleSchema = z
  .object({
    field: ruleFields,
    operator: ruleOperators,
    value: z.string().trim().min(1),
    value2: z.string().trim().min(1).optional(),
  })
  .superRefine((rule, ctx) => {
    if (!allowedOperators[rule.field].includes(rule.operator)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operator'],
        message: `${rule.operator} is not supported for ${rule.field}`,
      });
    }
    if (numericFields.has(rule.field) && !Number.isFinite(Number(rule.value))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${rule.field} requires a numeric value`,
      });
    }
    if (rule.operator === 'between') {
      if (rule.value2 === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value2'],
          message: 'between requires a second value',
        });
      } else if (!Number.isFinite(Number(rule.value2))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value2'],
          message: 'between requires a numeric second value',
        });
      }
    }
  });
const rulesSchema = z.array(ruleSchema);
const rulesField = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, rulesSchema);
const createSmartSchema = z.object({
  name: z.string().min(1).max(200),
  rules: rulesField,
});
const updateSmartSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  rules: rulesField.optional(),
});

type Rule = z.infer<typeof ruleSchema>;
type SqlBindValue = string | number;

interface SmartPlaylistTrack {
  id: string;
  title: string;
  albumId: string;
  albumTitle: string;
  artistId: string;
  artistName: string;
  artistNames: string | null;
  composer: string | null;
  conductor: string | null;
  trackNumber: number | null;
  discNumber: number | null;
  duration: number | null;
  format: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  filePath: string | null;
  coverUrl: string | null;
  replayGainTrack: number | null;
  replayGainTrackPeak: number | null;
  replayGainAlbum: number | null;
  replayGainAlbumPeak: number | null;
  source: string;
  createdAt: number | null;
  updatedAt: number | null;
}

function buildWhereClause(rules: Rule[]): { sql: string; params: SqlBindValue[] } {
  if (rules.length === 0) return { sql: '1=1', params: [] };

  const conditions: string[] = [];
  const params: SqlBindValue[] = [];

  const fieldMap: Record<RuleField, string> = {
    genre: 'a.genre',
    year: 'a.year',
    format: 't.format',
    sampleRate: 't.sample_rate',
    bitDepth: 't.bit_depth',
    artistName: 't.artist_name',
  };

  for (const rule of rules) {
    const col = fieldMap[rule.field];

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

function executeSmartPlaylist(rules: Rule[], limit = 200): SmartPlaylistTrack[] {
  const raw = getRawDb();
  const { sql: where, params } = buildWhereClause(rules);

  return raw
    .prepare<SqlBindValue[], SmartPlaylistTrack>(
      `
    SELECT DISTINCT t.id, t.title,
      t.album_id as albumId, t.album_title as albumTitle,
      t.artist_id as artistId, t.artist_name as artistName, t.artist_names as artistNames,
      t.composer, t.conductor, t.track_number as trackNumber, t.disc_number as discNumber,
      t.duration, t.format, t.sample_rate as sampleRate, t.bit_depth as bitDepth,
      t.file_path as filePath, t.cover_url as coverUrl,
      t.replay_gain_track as replayGainTrack,
      t.replay_gain_track_peak as replayGainTrackPeak,
      a.replay_gain_album as replayGainAlbum,
      a.replay_gain_album_peak as replayGainAlbumPeak,
      t.source, t.created_at as createdAt, t.updated_at as updatedAt
    FROM tracks t
    LEFT JOIN albums a ON a.id = t.album_id
    WHERE ${where}
    ORDER BY t.artist_name, t.album_title, t.disc_number, t.track_number
    LIMIT ?
  `,
    )
    .all(...params, limit);
}

// List all smart playlists
smartPlaylistsRouter.get('/', (_req, res) => {
  const db = getDb();
  const result = db.select().from(smartPlaylists).orderBy(smartPlaylists.name).all();
  res.json({ data: result });
});

// Create a smart playlist
smartPlaylistsRouter.post('/', validate({ body: createSmartSchema }), (req, res) => {
  const { name, rules } = req.body;
  const db = getDb();
  const id = uuid();
  const parsedRules = rules as Rule[];
  const tracks = executeSmartPlaylist(parsedRules);

  db.insert(smartPlaylists)
    .values({
      id,
      name,
      rules: JSON.stringify(parsedRules),
      trackCount: tracks.length,
    })
    .run();

  const created = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, id)).get();
  res.status(201).json({ data: created });
});

// Get smart playlist tracks (always re-evaluated)
smartPlaylistsRouter.get('/:id/tracks', (req, res) => {
  const db = getDb();
  const sp = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, req.params.id)).get();
  if (!sp) return res.status(404).json({ error: 'Smart playlist not found' });

  const parsedRules = rulesField.safeParse(sp.rules);
  if (!parsedRules.success) {
    res.status(500).json({ error: 'Stored smart playlist rules are invalid' });
    return;
  }
  const tracks = executeSmartPlaylist(parsedRules.data);

  // Update track count
  db.update(smartPlaylists)
    .set({ trackCount: tracks.length })
    .where(eq(smartPlaylists.id, sp.id))
    .run();

  res.json({ data: tracks, meta: { total: tracks.length } });
});

// Update a smart playlist
smartPlaylistsRouter.patch('/:id', validate({ body: updateSmartSchema }), (req, res) => {
  const { name, rules } = req.body;
  const id = req.params.id;
  if (Array.isArray(id)) {
    return res.status(400).json({ error: 'Invalid smart playlist id' });
  }
  const db = getDb();

  const existing = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, id)).get();
  if (!existing) return res.status(404).json({ error: 'Smart playlist not found' });

  const updates: Partial<typeof smartPlaylists.$inferInsert> = {};
  if (name !== undefined) updates.name = name;
  if (rules !== undefined) {
    updates.rules = JSON.stringify(rules);
    updates.trackCount = executeSmartPlaylist(rules as Rule[]).length;
  }

  if (Object.keys(updates).length > 0) {
    db.update(smartPlaylists).set(updates).where(eq(smartPlaylists.id, id)).run();
  }

  const updated = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, id)).get();
  res.json({ data: updated });
});

// Delete a smart playlist
smartPlaylistsRouter.delete('/:id', (req, res) => {
  const db = getDb();
  db.delete(smartPlaylists).where(eq(smartPlaylists.id, req.params.id)).run();
  res.json({ data: { ok: true } });
});

import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
import { smartPlaylists } from '../db/schema.js';
import { eq, or } from 'drizzle-orm';
import { validate } from '../utils/validate.js';
import { requireOwner } from '../utils/ownership.js';
import {
  definitionSchema,
  rulesSchema,
  type Rule,
  type SmartDefinition,
} from '../services/focus-rules.js';
import {
  definitionFromRules,
  definitionOf,
  evaluateDefinition,
  normalizeDefinition,
} from '../services/smart-playlists.js';

export const smartPlaylistsRouter = Router();

/** Same ownership rule as playlists (V09.2): yours, or shared and read-only. */
function loadSmartPlaylist(
  req: Parameters<typeof requireOwner>[0],
  res: Parameters<typeof requireOwner>[1],
  access: 'read' | 'write',
) {
  const owner = requireOwner(req, res);
  if (!owner) return null;
  const id = String(req.params.id);
  const sp = getDb().select().from(smartPlaylists).where(eq(smartPlaylists.id, id)).get();
  const visible = sp && (sp.userId === owner || (access === 'read' && sp.shared));
  if (!visible) {
    res.status(404).json({ error: 'Smart playlist not found' });
    return null;
  }
  return { sp, owner, id };
}

const rulesField = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, rulesSchema);

/**
 * R05.3: a smart playlist is a stored Focus question. New clients send a
 * `definition` (OR groups of Focus query strings, a sort, a limit); old ones
 * still send six-field `rules`, which become one group with the same
 * conditions.
 */
const createSmartSchema = z
  .object({
    name: z.string().min(1).max(200),
    rules: rulesField.optional(),
    definition: definitionSchema.optional(),
    /** Visible to the household, editable only by the owner (V09.2). */
    shared: z.boolean().optional(),
  })
  .refine((body) => body.rules !== undefined || body.definition !== undefined, {
    message: 'rules or definition is required',
    path: ['definition'],
  });
const updateSmartSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  rules: rulesField.optional(),
  definition: definitionSchema.optional(),
  shared: z.boolean().optional(),
});

type SmartRow = typeof smartPlaylists.$inferSelect;

/** The row as the API shows it: the definition parsed, the rules kept for old clients. */
function present(row: SmartRow) {
  return { ...row, definition: definitionOf(row) };
}

function definitionFromBody(body: { rules?: Rule[]; definition?: unknown }): SmartDefinition {
  return body.definition !== undefined
    ? normalizeDefinition(body.definition)
    : definitionFromRules(body.rules ?? []);
}

// List all smart playlists
smartPlaylistsRouter.get('/', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const result = getDb()
    .select()
    .from(smartPlaylists)
    .where(or(eq(smartPlaylists.userId, owner), eq(smartPlaylists.shared, true)))
    .orderBy(smartPlaylists.name)
    .all();
  res.json({ data: result.map(present) });
});

// Create a smart playlist
smartPlaylistsRouter.post('/', validate({ body: createSmartSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { name, rules, shared } = req.body;
  const db = getDb();
  const id = uuid();
  const definition = definitionFromBody(req.body);
  const { rows } = evaluateDefinition(definition, owner);

  db.insert(smartPlaylists)
    .values({
      id,
      name,
      rules: JSON.stringify((rules as Rule[] | undefined) ?? []),
      definition: JSON.stringify(definition),
      trackCount: rows.length,
      userId: owner,
      shared: shared ?? false,
    })
    .run();

  const created = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, id)).get()!;
  res.status(201).json({ data: present(created) });
});

// Get smart playlist tracks (always re-evaluated)
smartPlaylistsRouter.get('/:id/tracks', (req, res) => {
  const found = loadSmartPlaylist(req, res, 'read');
  if (!found) return;
  const { sp } = found;
  const db = getDb();

  const definition = definitionOf(sp);
  if (!definition) {
    res.status(500).json({ error: 'Stored smart playlist rules are invalid' });
    return;
  }
  // The owner's listening data, also when a housemate opens a shared one.
  const tracks = evaluateDefinition(definition, sp.userId).rows;

  // Update track count
  db.update(smartPlaylists)
    .set({ trackCount: tracks.length })
    .where(eq(smartPlaylists.id, sp.id))
    .run();

  res.json({ data: tracks, meta: { total: tracks.length } });
});

// Update a smart playlist
smartPlaylistsRouter.patch('/:id', validate({ body: updateSmartSchema }), (req, res) => {
  const { name, rules, definition, shared } = req.body;
  if (Array.isArray(req.params.id)) {
    return res.status(400).json({ error: 'Invalid smart playlist id' });
  }
  const found = loadSmartPlaylist(req, res, 'write');
  if (!found) return;
  const { id } = found;
  const db = getDb();

  const updates: Partial<typeof smartPlaylists.$inferInsert> = {};
  if (name !== undefined) updates.name = name;
  if (shared !== undefined) updates.shared = shared;
  if (rules !== undefined || definition !== undefined) {
    const next = definitionFromBody({ rules, definition });
    if (rules !== undefined) updates.rules = JSON.stringify(rules);
    updates.definition = JSON.stringify(next);
    updates.trackCount = evaluateDefinition(next, found.sp.userId).rows.length;
  }

  if (Object.keys(updates).length > 0) {
    db.update(smartPlaylists).set(updates).where(eq(smartPlaylists.id, id)).run();
  }

  const updated = db.select().from(smartPlaylists).where(eq(smartPlaylists.id, id)).get()!;
  res.json({ data: present(updated) });
});

// Delete a smart playlist
smartPlaylistsRouter.delete('/:id', (req, res) => {
  const found = loadSmartPlaylist(req, res, 'write');
  if (!found) return;
  getDb().delete(smartPlaylists).where(eq(smartPlaylists.id, found.id)).run();
  res.json({ data: { ok: true } });
});

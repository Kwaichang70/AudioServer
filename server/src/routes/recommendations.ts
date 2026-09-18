import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { playlists } from '../db/schema.js';
import { requireOwner } from '../utils/ownership.js';
import { validate } from '../utils/validate.js';
import { getSettings, localMix, setSettings } from '../services/recommendations.js';
import { addItem, itemCount, UnknownTrackError } from '../services/playlist-items.js';

/**
 * Recommendations (V12.2). Personal, like everything else since V09: the
 * caller's own history, their own favourites, their own preference about
 * whether any of that may be used at all.
 */
export const recommendationsRouter = Router();

const settingsSchema = z
  .object({ useHistory: z.boolean().optional(), useFavorites: z.boolean().optional() })
  .refine((v) => v.useHistory !== undefined || v.useFavorites !== undefined, {
    message: 'Send useHistory and/or useFavorites',
  });

/** What the listener's recommendations are allowed to be built from. */
recommendationsRouter.get('/settings', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  res.json({ data: getSettings(owner) });
});

recommendationsRouter.patch('/settings', validate({ body: settingsSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  res.json({ data: setSettings(owner, req.body) });
});

/**
 * A mix from this server alone — no external account needed. Every item says
 * why it is there, and the response says what the mix as a whole was built
 * from, so the basis is visible before a single note plays.
 */
recommendationsRouter.get('/mix', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const limit = Number(req.query.limit);
  const mix = localMix(owner, { limit: Number.isFinite(limit) ? limit : undefined });
  res.json({
    data: mix.items,
    meta: { total: mix.items.length, basis: mix.basis, personalised: mix.personalised },
  });
});

const saveMixSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  /** The exact tracks the listener is looking at; omitted means "a fresh mix". */
  trackIds: z.array(z.string().min(1)).max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/**
 * Keep a mix (V12.4). A mix is generated per request and would otherwise be
 * gone on the next reload, so saving it turns it into an ordinary playlist:
 * owned by this listener, with a snapshot per item, playable and editable
 * like any other. The tracks the client sends are what the listener is
 * looking at; without them a fresh mix is generated and saved.
 */
recommendationsRouter.post('/mix/save', validate({ body: saveMixSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { name, trackIds, limit } = req.body as z.infer<typeof saveMixSchema>;

  const ids = trackIds?.length ? trackIds : localMix(owner, { limit }).items.map((i) => i.id);
  if (ids.length === 0) {
    return res.status(409).json({
      error: 'EmptyMix',
      message: 'There is nothing playable in the library to save as a mix.',
    });
  }

  const db = getDb();
  const id = uuid();
  const title = name?.trim() || `Mix of ${new Date().toISOString().slice(0, 10)}`;
  db.insert(playlists).values({ id, name: title, userId: owner, shared: false }).run();

  const skipped: string[] = [];
  for (const trackId of ids) {
    try {
      addItem(id, { trackId });
    } catch (err) {
      // A track that vanished between generating and saving the mix is left
      // out and counted, rather than failing the whole save.
      if (err instanceof UnknownTrackError) skipped.push(trackId);
      else throw err;
    }
  }

  const count = itemCount(id);
  db.update(playlists).set({ trackCount: count }).where(eq(playlists.id, id)).run();
  const created = db.select().from(playlists).where(eq(playlists.id, id)).get();
  res.status(201).json({ data: created, meta: { saved: count, skipped: skipped.length } });
});

import { Router } from 'express';
import { z } from 'zod';
import { requireOwner } from '../utils/ownership.js';
import { validate } from '../utils/validate.js';
import { getSettings, localMix, setSettings } from '../services/recommendations.js';

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

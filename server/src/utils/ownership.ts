import type { Request, Response } from 'express';
import { SYSTEM_USER_ID } from '../middleware/auth.js';

/**
 * Ownership of personal data (V09).
 *
 * The music library is shared by the household; playlists, favourites,
 * listening history, statistics, smart playlists and scrobble accounts
 * belong to one person. Two rules run through every route:
 *
 *   1. A read never returns another user's rows. Playlists and smart
 *      playlists can be shared explicitly; everything else is private.
 *   2. A guessed id answers 404, not 403. "Forbidden" would confirm that
 *      the id exists and who else uses this server; "not found" tells the
 *      caller exactly as much as they are entitled to know.
 */

/** Signed stream tokens carry the system identity; it owns no personal data. */
export function ownerOf(req: Request): string | null {
  const id = req.userId;
  if (!id || id === SYSTEM_USER_ID) return null;
  return id;
}

/**
 * The caller's id, or a 401 when there is none. Every personal route needs a
 * real account — `requireAuth` already rejects anonymous callers, so this
 * only catches the stream-token identity reaching a route it has no business
 * in.
 */
export function requireOwner(req: Request, res: Response): string | null {
  const owner = ownerOf(req);
  if (!owner) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'This action needs a personal account',
    });
    return null;
  }
  return owner;
}

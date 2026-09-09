import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
import { playlists, playlistTracks, tracks } from '../db/schema.js';
import { asc, eq, or } from 'drizzle-orm';
import { validate } from '../utils/validate.js';
import { requireOwner } from '../utils/ownership.js';

export const playlistsRouter = Router();

/**
 * Personal playlists (V09.2). A playlist belongs to one account; `shared`
 * makes it visible to the household, still editable only by its owner. A
 * playlist that is not yours and not shared answers 404 — the same as one
 * that does not exist, so a guessed id reveals nothing.
 */
function loadPlaylist(
  req: Parameters<typeof requireOwner>[0],
  res: Parameters<typeof requireOwner>[1],
  access: 'read' | 'write',
) {
  const owner = requireOwner(req, res);
  if (!owner) return null;
  const id = String(req.params.id);
  const playlist = getDb().select().from(playlists).where(eq(playlists.id, id)).get();
  const visible = playlist && (playlist.userId === owner || (access === 'read' && playlist.shared));
  if (!visible) {
    res.status(404).json({ error: 'Playlist not found' });
    return null;
  }
  return { playlist, owner, id };
}

const createPlaylistSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /** Visible to the whole household, still editable only by the owner (V09.2). */
  shared: z.boolean().optional(),
});
const updatePlaylistSchema = createPlaylistSchema.partial();
const addTrackSchema = z.object({ trackId: z.string().min(1) });
const reorderSchema = z.object({ trackIds: z.array(z.string().min(1)) });
const importSchema = z.object({
  name: z.string().min(1).max(200),
  content: z.string().min(1).max(5_000_000),
});

// Your own playlists plus the ones the household shares
playlistsRouter.get('/', (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const result = getDb()
    .select()
    .from(playlists)
    .where(or(eq(playlists.userId, owner), eq(playlists.shared, true)))
    .orderBy(playlists.name)
    .all();
  res.json({ data: result, meta: { total: result.length } });
});

// Get a playlist
playlistsRouter.get('/:id', (req, res) => {
  const found = loadPlaylist(req, res, 'read');
  if (!found) return;
  res.json({ data: found.playlist });
});

// Create a playlist
playlistsRouter.post('/', validate({ body: createPlaylistSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { name, description, shared } = req.body;
  const db = getDb();
  const id = uuid();
  db.insert(playlists)
    .values({ id, name, description, userId: owner, shared: shared ?? false })
    .run();
  const created = db.select().from(playlists).where(eq(playlists.id, id)).get();
  res.status(201).json({ data: created });
});

// Update a playlist
playlistsRouter.patch('/:id', (req, res) => {
  const parsed = updatePlaylistSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
  const { name, description, shared } = parsed.data;
  const found = loadPlaylist(req, res, 'write');
  if (!found) return;
  const db = getDb();

  const updates: Partial<{ name: string; description: string; shared: boolean }> = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (shared !== undefined) updates.shared = shared;

  if (Object.keys(updates).length > 0) {
    db.update(playlists).set(updates).where(eq(playlists.id, found.id)).run();
  }

  const updated = db.select().from(playlists).where(eq(playlists.id, found.id)).get();
  res.json({ data: updated });
});

// Delete a playlist
playlistsRouter.delete('/:id', (req, res) => {
  const found = loadPlaylist(req, res, 'write');
  if (!found) return;
  const db = getDb();
  db.delete(playlistTracks).where(eq(playlistTracks.playlistId, found.id)).run();
  db.delete(playlists).where(eq(playlists.id, found.id)).run();
  res.json({ data: { ok: true } });
});

// Get tracks in a playlist
playlistsRouter.get('/:id/tracks', (req, res) => {
  const found = loadPlaylist(req, res, 'read');
  if (!found) return;
  const db = getDb();
  const items = db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, found.id))
    .orderBy(asc(playlistTracks.position))
    .all();

  // Enrich with track data
  const enriched = items
    .map((item) => {
      const track = db.select().from(tracks).where(eq(tracks.id, item.trackId)).get();
      return track ? { ...track, playlistPosition: item.position } : null;
    })
    .filter(Boolean);

  res.json({ data: enriched, meta: { total: enriched.length } });
});

// Add a track to a playlist
playlistsRouter.post('/:id/tracks', (req, res) => {
  const parsed = addTrackSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
  const { trackId } = parsed.data;
  const found = loadPlaylist(req, res, 'write');
  if (!found) return;
  const db = getDb();
  // Get next position
  const existing = db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, found.id))
    .all();
  const nextPos = existing.length > 0 ? Math.max(...existing.map((e) => e.position)) + 1 : 0;

  db.insert(playlistTracks)
    .values({
      playlistId: found.id,
      trackId,
      position: nextPos,
    })
    .run();

  // Update track count
  const count = db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, found.id))
    .all().length;
  db.update(playlists).set({ trackCount: count }).where(eq(playlists.id, found.id)).run();

  res.json({ data: { ok: true, trackCount: count } });
});

// Reorder tracks in a playlist
playlistsRouter.post('/:id/reorder', (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
  const { trackIds } = parsed.data;
  const found = loadPlaylist(req, res, 'write');
  if (!found) return;
  const db = getDb();
  // Update each track's position based on the new order
  trackIds.forEach((trackId: string, index: number) => {
    const item = db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, found.id))
      .all()
      .find((i) => i.trackId === trackId);
    if (item) {
      db.update(playlistTracks)
        .set({ position: index })
        .where(eq(playlistTracks.id, item.id))
        .run();
    }
  });

  res.json({ data: { ok: true } });
});

// Export playlist as M3U
playlistsRouter.get('/:id/export', (req, res) => {
  const found = loadPlaylist(req, res, 'read');
  if (!found) return;
  const playlist = found.playlist;
  const db = getDb();

  const items = db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, found.id))
    .orderBy(asc(playlistTracks.position))
    .all();

  const enriched = items
    .map((item) => {
      return db.select().from(tracks).where(eq(tracks.id, item.trackId)).get();
    })
    .filter(Boolean);

  let m3u = '#EXTM3U\n';
  m3u += `#PLAYLIST:${playlist.name}\n`;
  for (const track of enriched) {
    if (!track) continue;
    m3u += `#EXTINF:${Math.round(track.duration || 0)},${track.artistName} - ${track.title}\n`;
    m3u += `${track.filePath || track.id}\n`;
  }

  res.setHeader('Content-Type', 'audio/mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${playlist.name}.m3u"`);
  res.send(m3u);
});

// Import M3U playlist
playlistsRouter.post('/import', validate({ body: importSchema }), (req, res) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const { name, content } = req.body;
  const db = getDb();
  const id = uuid();
  db.insert(playlists).values({ id, name, userId: owner }).run();

  // Parse M3U
  const lines = (content as string)
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l && !l.startsWith('#'));
  let position = 0;

  for (const line of lines) {
    // Try to match by file path
    let track = db.select().from(tracks).where(eq(tracks.filePath, line)).get();

    // Try fuzzy match by filename
    if (!track) {
      const filename = line.split('/').pop()?.split('\\').pop() || '';
      if (filename) {
        const allTracks = db.select().from(tracks).all();
        track = allTracks.find((t) => t.filePath?.endsWith(filename));
      }
    }

    if (track) {
      db.insert(playlistTracks).values({ playlistId: id, trackId: track.id, position }).run();
      position++;
    }
  }

  db.update(playlists).set({ trackCount: position }).where(eq(playlists.id, id)).run();
  const created = db.select().from(playlists).where(eq(playlists.id, id)).get();
  res.status(201).json({ data: created, meta: { matched: position, total: lines.length } });
});

// Remove a track from a playlist
playlistsRouter.delete('/:id/tracks/:trackId', (req, res) => {
  const found = loadPlaylist(req, res, 'write');
  if (!found) return;
  const db = getDb();
  const items = db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, found.id))
    .all();

  const toRemove = items.find((i) => i.trackId === req.params.trackId);
  if (toRemove) {
    db.delete(playlistTracks).where(eq(playlistTracks.id, toRemove.id)).run();
  }

  // Update count
  const count = db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, found.id))
    .all().length;
  db.update(playlists).set({ trackCount: count }).where(eq(playlists.id, found.id)).run();

  res.json({ data: { ok: true, trackCount: count } });
});

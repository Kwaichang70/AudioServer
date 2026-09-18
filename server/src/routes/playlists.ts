import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
import { playlists, playlistTracks, tracks } from '../db/schema.js';
import { eq, or } from 'drizzle-orm';
import { validate } from '../utils/validate.js';
import { requireOwner } from '../utils/ownership.js';
import {
  MissingSnapshotError,
  UnknownTrackError,
  addItem,
  itemCount,
  listItems,
  removeItem,
  reorderItems,
} from '../services/playlist-items.js';

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
/**
 * Adding an item (V12.1). A local id is snapshotted from the library itself;
 * an external id (`qobuz:…`, `radio:…`) has no local row, so the caller sends
 * the metadata along and the server stores that snapshot verbatim. No stream
 * URL is accepted or stored: those expire and are resolved at playback.
 */
const addTrackSchema = z.object({
  trackId: z.string().min(1),
  title: z.string().max(500).optional(),
  artistName: z.string().max(500).optional(),
  albumTitle: z.string().max(500).optional(),
  albumId: z.string().max(200).nullish(),
  duration: z.number().nonnegative().nullish(),
  coverUrl: z.string().max(2000).nullish(),
  format: z.string().max(50).nullish(),
});
/** `itemIds` is exact; `trackIds` is what older clients send. */
const reorderSchema = z
  .object({
    itemIds: z.array(z.string().min(1)).optional(),
    trackIds: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => v.itemIds !== undefined || v.trackIds !== undefined, {
    message: 'Send itemIds (preferred) or trackIds',
  });
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

/**
 * The items of a playlist (V12.1). Every item is returned, including ones
 * that cannot be played right now: a local file the scanner cannot find, a
 * track that left the library, a Qobuz track while nobody is connected. Each
 * of those carries its snapshot and a reason, because an item that silently
 * disappears from a list is the worse answer.
 */
playlistsRouter.get('/:id/tracks', (req, res) => {
  const found = loadPlaylist(req, res, 'read');
  if (!found) return;
  const items = listItems(found.id);
  res.json({
    data: items,
    meta: {
      total: items.length,
      playable: items.filter((i) => i.availability === 'available').length,
      unavailable: items.filter((i) => i.availability !== 'available').length,
    },
  });
});

// Add a track to a playlist
playlistsRouter.post('/:id/tracks', (req, res) => {
  const parsed = addTrackSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
  const found = loadPlaylist(req, res, 'write');
  if (!found) return;

  let itemId: string;
  try {
    itemId = addItem(found.id, parsed.data);
  } catch (err) {
    if (err instanceof UnknownTrackError) {
      return res.status(404).json({ error: 'Track not found' });
    }
    if (err instanceof MissingSnapshotError) {
      return res.status(400).json({ error: 'MetadataRequired', message: err.message });
    }
    throw err;
  }

  const count = itemCount(found.id);
  getDb().update(playlists).set({ trackCount: count }).where(eq(playlists.id, found.id)).run();
  res.json({ data: { ok: true, itemId, trackCount: count } });
});

// Reorder tracks in a playlist
playlistsRouter.post('/:id/reorder', (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'ValidationError', issues: parsed.error.issues });
  const found = loadPlaylist(req, res, 'write');
  if (!found) return;
  reorderItems(found.id, parsed.data.itemIds ?? parsed.data.trackIds ?? []);
  res.json({ data: { ok: true } });
});

/**
 * Export as M3U (V12.1).
 *
 * An M3U line is a file path or a fixed URL, and that is exactly what an
 * external item does not have: a Qobuz stream URL is signed per play and
 * expires, so writing one into a file would produce a playlist that breaks
 * within the hour. Local items are exported as before; every other item is
 * written as a comment naming what it is and why it could not be exported,
 * and the response says how many those were. The limitation is stated in the
 * file itself, because the file is what leaves this server.
 */
playlistsRouter.get('/:id/export', (req, res) => {
  const found = loadPlaylist(req, res, 'read');
  if (!found) return;
  const playlist = found.playlist;
  const items = listItems(found.id);
  const external = items.filter((i) => i.source !== 'local');

  let m3u = '#EXTM3U\n';
  m3u += `#PLAYLIST:${playlist.name}\n`;
  if (external.length > 0) {
    m3u +=
      `# ${external.length} item(s) in this playlist do not come from a local file and cannot be\n` +
      '# exported: an M3U can only reference a path or a fixed URL, and these resolve a fresh\n' +
      '# stream URL at playback. They are listed below as comments so nothing is lost silently.\n';
  }

  for (const item of items) {
    m3u += `#EXTINF:${Math.round(item.duration || 0)},${item.artistName} - ${item.title}\n`;
    if (item.source === 'local') {
      m3u += `${item.filePath || item.id}\n`;
    } else {
      m3u += `# not exported (${item.source}): ${item.id}\n`;
    }
  }

  res.setHeader('Content-Type', 'audio/mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${playlist.name}.m3u"`);
  // A client that wants to warn before downloading does not have to parse the file.
  res.setHeader('X-Playlist-Export-Skipped', String(external.length));
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
      // Adding through the same path as everything else, so an imported item
      // gets its snapshot too and reads the same after a rescan.
      addItem(id, { trackId: track.id });
      position++;
    }
  }

  db.update(playlists).set({ trackCount: position }).where(eq(playlists.id, id)).run();
  const created = db.select().from(playlists).where(eq(playlists.id, id)).get();
  res.status(201).json({ data: created, meta: { matched: position, total: lines.length } });
});

/**
 * Remove one item. The parameter is an item id (exact, so one of two copies
 * of the same track can be removed) or, for older clients, a track id — then
 * the first item with that track goes.
 */
playlistsRouter.delete('/:id/tracks/:trackId', (req, res) => {
  const found = loadPlaylist(req, res, 'write');
  if (!found) return;
  removeItem(found.id, String(req.params.trackId));
  const count = itemCount(found.id);
  getDb().update(playlists).set({ trackCount: count }).where(eq(playlists.id, found.id)).run();
  res.json({ data: { ok: true, trackCount: count } });
});

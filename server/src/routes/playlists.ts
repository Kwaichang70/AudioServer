import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
import { playlists, playlistTracks, tracks } from '../db/schema.js';
import { eq, asc } from 'drizzle-orm';

export const playlistsRouter = Router();

// List all playlists
playlistsRouter.get('/', (_req, res) => {
  const db = getDb();
  const result = db.select().from(playlists).orderBy(playlists.name).all();
  res.json({ data: result, meta: { total: result.length } });
});

// Get a playlist
playlistsRouter.get('/:id', (req, res) => {
  const db = getDb();
  const playlist = db.select().from(playlists).where(eq(playlists.id, req.params.id)).get();
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  res.json({ data: playlist });
});

// Create a playlist
playlistsRouter.post('/', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const db = getDb();
  const id = uuid();
  db.insert(playlists).values({ id, name, description }).run();
  const created = db.select().from(playlists).where(eq(playlists.id, id)).get();
  res.status(201).json({ data: created });
});

// Update a playlist
playlistsRouter.patch('/:id', (req, res) => {
  const { name, description } = req.body;
  const db = getDb();

  const existing = db.select().from(playlists).where(eq(playlists.id, req.params.id)).get();
  if (!existing) return res.status(404).json({ error: 'Playlist not found' });

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;

  if (Object.keys(updates).length > 0) {
    db.update(playlists).set(updates).where(eq(playlists.id, req.params.id)).run();
  }

  const updated = db.select().from(playlists).where(eq(playlists.id, req.params.id)).get();
  res.json({ data: updated });
});

// Delete a playlist
playlistsRouter.delete('/:id', (req, res) => {
  const db = getDb();
  db.delete(playlistTracks).where(eq(playlistTracks.playlistId, req.params.id)).run();
  db.delete(playlists).where(eq(playlists.id, req.params.id)).run();
  res.json({ data: { ok: true } });
});

// Get tracks in a playlist
playlistsRouter.get('/:id/tracks', (req, res) => {
  const db = getDb();
  const items = db.select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, req.params.id))
    .orderBy(asc(playlistTracks.position))
    .all();

  // Enrich with track data
  const enriched = items.map((item) => {
    const track = db.select().from(tracks).where(eq(tracks.id, item.trackId)).get();
    return track ? { ...track, playlistPosition: item.position } : null;
  }).filter(Boolean);

  res.json({ data: enriched, meta: { total: enriched.length } });
});

// Add a track to a playlist
playlistsRouter.post('/:id/tracks', (req, res) => {
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });

  const db = getDb();
  // Get next position
  const existing = db.select().from(playlistTracks)
    .where(eq(playlistTracks.playlistId, req.params.id))
    .all();
  const nextPos = existing.length > 0
    ? Math.max(...existing.map((e) => e.position)) + 1
    : 0;

  db.insert(playlistTracks).values({
    playlistId: req.params.id,
    trackId,
    position: nextPos,
  }).run();

  // Update track count
  const count = db.select().from(playlistTracks)
    .where(eq(playlistTracks.playlistId, req.params.id)).all().length;
  db.update(playlists).set({ trackCount: count }).where(eq(playlists.id, req.params.id)).run();

  res.json({ data: { ok: true, trackCount: count } });
});

// Reorder tracks in a playlist
playlistsRouter.post('/:id/reorder', (req, res) => {
  const { trackIds } = req.body;
  if (!Array.isArray(trackIds)) return res.status(400).json({ error: 'trackIds array required' });

  const db = getDb();
  // Update each track's position based on the new order
  trackIds.forEach((trackId: string, index: number) => {
    const item = db.select().from(playlistTracks)
      .where(eq(playlistTracks.playlistId, req.params.id))
      .all()
      .find((i) => i.trackId === trackId);
    if (item) {
      db.update(playlistTracks).set({ position: index }).where(eq(playlistTracks.id, item.id)).run();
    }
  });

  res.json({ data: { ok: true } });
});

// Export playlist as M3U
playlistsRouter.get('/:id/export', (req, res) => {
  const db = getDb();
  const playlist = db.select().from(playlists).where(eq(playlists.id, req.params.id)).get();
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const items = db.select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, req.params.id))
    .orderBy(asc(playlistTracks.position))
    .all();

  const enriched = items.map((item) => {
    return db.select().from(tracks).where(eq(tracks.id, item.trackId)).get();
  }).filter(Boolean);

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
playlistsRouter.post('/import', (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) return res.status(400).json({ error: 'name and content required' });

  const db = getDb();
  const id = uuid();
  db.insert(playlists).values({ id, name }).run();

  // Parse M3U
  const lines = (content as string).split('\n').map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith('#'));
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
  const db = getDb();
  const items = db.select().from(playlistTracks)
    .where(eq(playlistTracks.playlistId, req.params.id))
    .all();

  const toRemove = items.find((i) => i.trackId === req.params.trackId);
  if (toRemove) {
    db.delete(playlistTracks).where(eq(playlistTracks.id, toRemove.id)).run();
  }

  // Update count
  const count = db.select().from(playlistTracks)
    .where(eq(playlistTracks.playlistId, req.params.id)).all().length;
  db.update(playlists).set({ trackCount: count }).where(eq(playlists.id, req.params.id)).run();

  res.json({ data: { ok: true, trackCount: count } });
});

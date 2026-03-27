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

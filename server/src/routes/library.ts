import { Router } from 'express';
import { getDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { eq, like, or } from 'drizzle-orm';
import { scanLibrary } from '../services/scanner.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createReadStream, existsSync } from 'fs';
import { extname } from 'path';
import type { ApiResponse } from '@audioserver/shared';

export const libraryRouter = Router();

// ─── Artists ─────────────────────────────────────────────────────

libraryRouter.get('/artists', (_req, res) => {
  const db = getDb();
  const result = db.select().from(artists).orderBy(artists.name).all();
  const response: ApiResponse<typeof result> = {
    data: result,
    meta: { total: result.length },
  };
  res.json(response);
});

libraryRouter.get('/artists/:id', (req, res) => {
  const db = getDb();
  const artist = db.select().from(artists).where(eq(artists.id, req.params.id)).get();
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
  res.json({ data: artist });
});

libraryRouter.get('/artists/:id/albums', (req, res) => {
  const db = getDb();
  const result = db.select().from(albums).where(eq(albums.artistId, req.params.id)).all();
  res.json({ data: result, meta: { total: result.length } });
});

// ─── Albums ──────────────────────────────────────────────────────

libraryRouter.get('/albums', (_req, res) => {
  const db = getDb();
  const result = db.select().from(albums).orderBy(albums.title).all();
  res.json({ data: result, meta: { total: result.length } });
});

libraryRouter.get('/albums/:id', (req, res) => {
  const db = getDb();
  const album = db.select().from(albums).where(eq(albums.id, req.params.id)).get();
  if (!album) return res.status(404).json({ error: 'Album not found' });
  res.json({ data: album });
});

libraryRouter.get('/albums/:id/tracks', (req, res) => {
  const db = getDb();
  const result = db.select().from(tracks)
    .where(eq(tracks.albumId, req.params.id))
    .orderBy(tracks.discNumber, tracks.trackNumber)
    .all();
  res.json({ data: result, meta: { total: result.length } });
});

// ─── Tracks ──────────────────────────────────────────────────────

libraryRouter.get('/tracks/:id', (req, res) => {
  const db = getDb();
  const track = db.select().from(tracks).where(eq(tracks.id, req.params.id)).get();
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.json({ data: track });
});

// Stream a track's audio file
libraryRouter.get('/tracks/:id/stream', (req, res) => {
  const db = getDb();
  const track = db.select().from(tracks).where(eq(tracks.id, req.params.id)).get();
  if (!track || !track.filePath) return res.status(404).json({ error: 'Track not found' });
  if (!existsSync(track.filePath)) return res.status(404).json({ error: 'File not found on disk' });

  const ext = extname(track.filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.flac': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/opus',
    '.wav': 'audio/wav',
  };

  res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  createReadStream(track.filePath).pipe(res);
});

// ─── Search ──────────────────────────────────────────────────────

libraryRouter.get('/search', (req, res) => {
  const query = (req.query.q as string || '').trim();
  if (!query) return res.json({ data: { artists: [], albums: [], tracks: [] } });

  const db = getDb();
  const pattern = `%${query}%`;

  const matchedArtists = db.select().from(artists).where(like(artists.name, pattern)).limit(20).all();
  const matchedAlbums = db.select().from(albums).where(like(albums.title, pattern)).limit(20).all();
  const matchedTracks = db.select().from(tracks).where(
    or(like(tracks.title, pattern), like(tracks.artistName, pattern))
  ).limit(50).all();

  res.json({
    data: {
      artists: matchedArtists,
      albums: matchedAlbums,
      tracks: matchedTracks,
    },
  });
});

// ─── Scan ────────────────────────────────────────────────────────

libraryRouter.post('/scan', async (_req, res) => {
  try {
    logger.info('Library scan requested');
    const result = await scanLibrary(config.musicLibraryPaths);
    res.json({ data: result });
  } catch (err) {
    logger.error(`Scan failed: ${err}`);
    res.status(500).json({ error: 'Scan failed', message: String(err) });
  }
});

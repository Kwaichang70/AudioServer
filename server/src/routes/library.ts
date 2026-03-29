import { Router } from 'express';
import { getDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { eq, like, or } from 'drizzle-orm';
import { scanLibrary, getScanStatus } from '../services/scanner.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname } from 'path';
import type { ApiResponse } from '@audioserver/shared';
import { getCoverForAlbum, getCoverForTrack } from '../services/coverart.js';
import { fetchMissingCovers, getCoverFetchStatus } from '../services/coverart-fetch.js';

export const libraryRouter = Router();

// ─── Stats ───────────────────────────────────────────────────────

libraryRouter.get('/stats', (_req, res) => {
  const db = getDb();
  const artistCount = db.select().from(artists).all().length;
  const albumCount = db.select().from(albums).all().length;
  const trackCount = db.select().from(tracks).all().length;
  res.json({ data: { artists: artistCount, albums: albumCount, tracks: trackCount } });
});

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

// ─── Cover Art ───────────────────────────────────────────────────

libraryRouter.get('/albums/:id/cover', async (req, res) => {
  const cover = await getCoverForAlbum(req.params.id);
  if (!cover) return res.status(404).json({ error: 'No cover art found' });
  res.setHeader('Content-Type', cover.mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(cover.data);
});

libraryRouter.get('/tracks/:id/cover', async (req, res) => {
  const cover = await getCoverForTrack(req.params.id);
  if (!cover) return res.status(404).json({ error: 'No cover art found' });
  res.setHeader('Content-Type', cover.mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(cover.data);
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

  const fileStat = statSync(track.filePath);
  const mime = mimeTypes[ext] || 'application/octet-stream';
  const totalSize = fileStat.size;

  // Handle Range requests (required by DLNA renderers)
  const range = req.headers.range;
  if (range) {
    const parts = range.replace('bytes=', '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('transferMode.dlna.org', 'Streaming');
    createReadStream(track.filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', totalSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000');
    createReadStream(track.filePath).pipe(res);
  }
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

libraryRouter.post('/scan', (_req, res) => {
  const status = getScanStatus();
  if (status.isScanning) {
    res.json({ data: status, message: 'Scan already in progress' });
    return;
  }
  // Start scan in background, respond immediately
  logger.info('Library scan requested');
  scanLibrary(config.musicLibraryPaths);
  res.json({ data: getScanStatus(), message: 'Scan started' });
});

libraryRouter.get('/scan/status', (_req, res) => {
  res.json({ data: getScanStatus() });
});

// ─── Cover Art Fetch ─────────────────────────────────────────────

libraryRouter.post('/covers/fetch', (_req, res) => {
  const status = getCoverFetchStatus();
  if (status.isRunning) {
    res.json({ data: status, message: 'Already running' });
    return;
  }
  logger.info('Cover art fetch requested');
  fetchMissingCovers();
  res.json({ data: getCoverFetchStatus(), message: 'Cover art fetch started' });
});

libraryRouter.get('/covers/fetch/status', (_req, res) => {
  res.json({ data: getCoverFetchStatus() });
});

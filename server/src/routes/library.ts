import { Router, type Response } from 'express';
import { getDb, getRawDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { desc, eq, like, or, sql } from 'drizzle-orm';
import { scanLibrary, getScanStatus } from '../services/scanner.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname } from 'path';
// ApiResponse type removed — using inline format with buildMeta
import { getCoverForAlbum, getCoverForTrack } from '../services/coverart.js';
import {
  fetchMissingCovers,
  getCoverFetchStatus,
  readCachedArtistImage,
  fetchMissingArtistImages,
  getArtistFetchStatus,
  getLocalCoverPath,
  getLocalArtistImagePath,
} from '../services/coverart-fetch.js';
import { parsePagination, buildMeta } from '../utils/pagination.js';
import { getSimilarArtists, similarArtistsAvailable } from '../services/similar-artists.js';

export const libraryRouter = Router();

function addAlbumCoverAvailability<T extends { id: string; coverUrl: string | null }>(
  rows: T[],
): Array<T & { hasCover: boolean }> {
  return rows.map((row) => ({
    ...row,
    hasCover: !!row.coverUrl || getLocalCoverPath(row.id) !== null,
  }));
}

function pipeTrackFile(
  res: Response,
  filePath: string,
  range?: { start: number; end: number },
): void {
  const stream = createReadStream(filePath, range);
  stream.once('error', (error) => {
    logger.error(`Failed to read track file ${filePath}: ${error}`);
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Range');
    res.removeHeader('Accept-Ranges');
    res.removeHeader('transferMode.dlna.org');
    res.removeHeader('contentFeatures.dlna.org');
    res.status(500).json({ error: 'Failed to read track file' });
  });
  stream.pipe(res);
}

// ─── Stats ───────────────────────────────────────────────────────

libraryRouter.get('/stats', (_req, res) => {
  const raw = getRawDb();
  const artistCount = raw.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM artists').get()?.c;
  const albumCount = raw.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM albums').get()?.c;
  const trackCount = raw.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM tracks').get()?.c;
  res.json({ data: { artists: artistCount, albums: albumCount, tracks: trackCount } });
});

// ─── Artists ─────────────────────────────────────────────────────

libraryRouter.get('/artists', (req, res) => {
  const { page, limit, offset } = parsePagination(req, 50);
  const raw = getRawDb();
  const total =
    raw.prepare<[], { count: number }>('SELECT COUNT(*) as count FROM artists').get()?.count ?? 0;
  const rows = raw
    .prepare(
      `
    SELECT id, name, image_url as imageUrl, source, created_at as createdAt, updated_at as updatedAt
    FROM artists ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?
  `,
    )
    .all(limit, offset) as Array<{ id: string; imageUrl: string | null }>;
  // hasImage lets the client skip requesting /artists/:id/image for artists that
  // have no picture (provider URL or a fetched file on disk) — avoiding a 404 per
  // artist tile. A scan/fetch keeps the on-disk state authoritative.
  const data = rows.map((r) => ({
    ...r,
    hasImage: !!r.imageUrl || getLocalArtistImagePath(r.id) !== null,
  }));
  res.json({ data, meta: buildMeta(page, limit, total) });
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

// "Listeners also like" — similar artists (Last.fm), matched to the library.
libraryRouter.get('/artists/:id/similar', async (req, res) => {
  const db = getDb();
  const artist = db.select().from(artists).where(eq(artists.id, req.params.id)).get();
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
  try {
    const similar = await getSimilarArtists(artist.name);
    res.json({ data: { available: similarArtistsAvailable(), similar } });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ─── Albums ──────────────────────────────────────────────────────

libraryRouter.get('/albums', (req, res) => {
  const { page, limit, offset } = parsePagination(req, 50);
  const raw = getRawDb();
  const total =
    raw.prepare<[], { count: number }>('SELECT COUNT(*) as count FROM albums').get()?.count ?? 0;
  const rows = raw
    .prepare(
      `
    SELECT id, title, artist_id as artistId, artist_name as artistName, year,
      cover_url as coverUrl, genre, track_count as trackCount, source,
      format, sample_rate as sampleRate, bit_depth as bitDepth,
      replay_gain_album as replayGainAlbum, replay_gain_album_peak as replayGainAlbumPeak,
      created_at as createdAt, updated_at as updatedAt
    FROM albums ORDER BY title COLLATE NOCASE LIMIT ? OFFSET ?
  `,
    )
    .all(limit, offset) as Array<{ id: string; coverUrl: string | null }>;
  // hasCover lets the client skip requesting /albums/:id/cover when no art exists
  // — avoiding a 404 per album tile. The scanner caches embedded art to disk and
  // the cover-fetch job stores fetched art there too, so an on-disk file (or a
  // provider cover_url) is an authoritative "has art" signal after a scan/fetch.
  const data = addAlbumCoverAvailability(rows);
  res.json({ data, meta: buildMeta(page, limit, total) });
});

// Recently added albums
libraryRouter.get('/albums/recent', (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
  const db = getDb();
  const rows = db.select().from(albums).orderBy(desc(albums.createdAt)).limit(limit).all();
  const data = addAlbumCoverAvailability(rows);
  res.json({ data });
});

libraryRouter.get('/albums/:id', (req, res) => {
  const db = getDb();
  const album = db.select().from(albums).where(eq(albums.id, req.params.id)).get();
  if (!album) return res.status(404).json({ error: 'Album not found' });
  res.json({ data: album });
});

libraryRouter.get('/albums/:id/tracks', (req, res) => {
  const db = getDb();
  const result = db
    .select()
    .from(tracks)
    .where(eq(tracks.albumId, req.params.id))
    .orderBy(tracks.discNumber, tracks.trackNumber)
    .all();
  res.json({ data: result, meta: { total: result.length } });
});

// ─── Artist Images ───────────────────────────────────────────────

libraryRouter.get('/artists/:id/image', (req, res) => {
  const image = readCachedArtistImage(req.params.id);
  if (!image) return res.status(404).json({ error: 'No artist image' });
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(image.data);
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

libraryRouter.get('/tracks', (req, res) => {
  const { page, limit, offset } = parsePagination(req, 100);
  const raw = getRawDb();
  const total = (raw.prepare('SELECT COUNT(*) as count FROM tracks').get() as { count: number })
    .count;
  const data = raw
    .prepare(
      `
    SELECT id, title, album_id as albumId, album_title as albumTitle,
      artist_id as artistId, artist_name as artistName,
      track_number as trackNumber, disc_number as discNumber, duration,
      format, sample_rate as sampleRate, bit_depth as bitDepth,
      file_path as filePath, cover_url as coverUrl,
      replay_gain_track as replayGainTrack, replay_gain_track_peak as replayGainTrackPeak,
      source, created_at as createdAt, updated_at as updatedAt
    FROM tracks
    ORDER BY album_id COLLATE NOCASE, disc_number, track_number, title COLLATE NOCASE
    LIMIT ? OFFSET ?
  `,
    )
    .all(limit, offset);
  res.json({ data, meta: buildMeta(page, limit, total) });
});

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

  let fileStat;
  try {
    fileStat = statSync(track.filePath);
  } catch (error) {
    logger.error(`Failed to stat track file ${track.filePath}: ${error}`);
    res.status(500).json({ error: 'Failed to read track file' });
    return;
  }
  const mime = mimeTypes[ext] || 'application/octet-stream';
  const totalSize = fileStat.size;

  // Handle Range requests (required by DLNA renderers)
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) {
      res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
      return;
    }
    const startStr = m[1];
    const endStr = m[2];
    let start: number;
    let end: number;
    if (startStr === '' && endStr !== '') {
      // suffix range: last N bytes
      const suffix = parseInt(endStr, 10);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
        return;
      }
      start = Math.max(totalSize - suffix, 0);
      end = totalSize - 1;
    } else {
      start = parseInt(startStr, 10);
      end = endStr ? parseInt(endStr, 10) : totalSize - 1;
    }
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize
    ) {
      res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
      return;
    }
    if (end >= totalSize) end = totalSize - 1;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('transferMode.dlna.org', 'Streaming');
    pipeTrackFile(res, track.filePath, { start, end });
  } else {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', totalSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader(
      'contentFeatures.dlna.org',
      'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
    );
    pipeTrackFile(res, track.filePath);
  }
});

// ─── Genres ─────────────────────────────────────────────────────

libraryRouter.get('/genres', (_req, res) => {
  const raw = getRawDb();
  const data = raw
    .prepare(
      `
    SELECT genre, COUNT(*) as albumCount, SUM(track_count) as trackCount
    FROM albums
    WHERE genre IS NOT NULL AND genre != ''
    GROUP BY genre
    ORDER BY albumCount DESC
  `,
    )
    .all();
  res.json({ data });
});

libraryRouter.get('/genres/:genre/albums', (req, res) => {
  const { page, limit, offset } = parsePagination(req, 50);
  const genre = decodeURIComponent(req.params.genre);
  const raw = getRawDb();
  const total =
    raw
      .prepare<[string], { count: number }>('SELECT COUNT(*) as count FROM albums WHERE genre = ?')
      .get(genre)?.count ?? 0;
  const db = getDb();
  const rows = db
    .select()
    .from(albums)
    .where(eq(albums.genre, genre))
    .orderBy(sql`${albums.title} COLLATE NOCASE`)
    .limit(limit)
    .offset(offset)
    .all();
  const data = addAlbumCoverAvailability(rows);
  res.json({ data, meta: buildMeta(page, limit, total) });
});

// ─── Lyrics ─────────────────────────────────────────────────────

libraryRouter.get('/tracks/:id/lyrics', async (req, res) => {
  try {
    const { getLyrics, parseLrc } = await import('../services/lyrics.js');
    const result = await getLyrics(req.params.id);
    if (!result) return res.status(404).json({ error: 'No lyrics found' });

    res.json({
      data: {
        plain: result.plain || null,
        synced: result.synced ? parseLrc(result.synced) : null,
        source: result.source,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Search ──────────────────────────────────────────────────────

libraryRouter.get('/search', (req, res) => {
  const query = ((req.query.q as string) || '').trim();
  const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
  if (!query) return res.json({ data: { artists: [], albums: [], tracks: [] } });

  const db = getDb();
  const pattern = `%${query}%`;

  const matchedArtists = db
    .select()
    .from(artists)
    .where(like(artists.name, pattern))
    .limit(limit)
    .all();
  const matchedAlbums = db
    .select()
    .from(albums)
    .where(like(albums.title, pattern))
    .limit(limit)
    .all();
  const matchedTracks = db
    .select()
    .from(tracks)
    .where(or(like(tracks.title, pattern), like(tracks.artistName, pattern)))
    .limit(limit)
    .all();

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
  // Start scan in background, respond immediately. Catch rejections — an
  // unhandled one would crash the whole process.
  logger.info('Library scan requested');
  scanLibrary(config.musicLibraryPaths).catch((err) =>
    logger.error(`Library scan crashed: ${err}`),
  );
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
  // Fire-and-forget: an unhandled rejection would crash the whole process
  fetchMissingCovers().catch((err) => logger.error(`Cover art fetch crashed: ${err}`));
  res.json({ data: getCoverFetchStatus(), message: 'Cover art fetch started' });
});

libraryRouter.get('/covers/fetch/status', (_req, res) => {
  res.json({ data: getCoverFetchStatus() });
});

// ─── Artist Image Fetch ──────────────────────────────────────────

libraryRouter.post('/artists/images/fetch', (_req, res) => {
  const status = getArtistFetchStatus();
  if (status.isRunning) {
    res.json({ data: status, message: 'Already running' });
    return;
  }
  logger.info('Artist image fetch requested');
  // Fire-and-forget: an unhandled rejection would crash the whole process
  fetchMissingArtistImages().catch((err) => logger.error(`Artist image fetch crashed: ${err}`));
  res.json({ data: getArtistFetchStatus(), message: 'Artist image fetch started' });
});

libraryRouter.get('/artists/images/fetch/status', (_req, res) => {
  res.json({ data: getArtistFetchStatus() });
});

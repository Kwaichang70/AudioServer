import { readdir, stat } from 'node:fs/promises';
import { extname, basename } from 'path';
// @ts-expect-error - music-metadata types don't export parseFile in ESM mode
import { parseFile } from 'music-metadata';
import { v4 as uuid } from 'uuid';
import { getDb, getRawDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { logger } from '../logger.js';
import { eq } from 'drizzle-orm';

const SUPPORTED_EXTENSIONS = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.aiff',
]);

const artistCache = new Map<string, string>();
const albumCache = new Map<string, string>();

export interface ScanStatus {
  isScanning: boolean;
  phase: 'idle' | 'discovering' | 'scanning' | 'cleaning' | 'done';
  processedFiles: number;
  totalFiles: number;
  newTracks: number;
  updatedTracks: number;
  removedTracks: number;
  artists: number;
  albums: number;
  tracks: number;
  errors: number;
  currentDir?: string;
  currentFile?: string;
}

let scanStatus: ScanStatus = {
  isScanning: false, phase: 'idle',
  processedFiles: 0, totalFiles: 0,
  newTracks: 0, updatedTracks: 0, removedTracks: 0,
  artists: 0, albums: 0, tracks: 0, errors: 0,
};

export function getScanStatus(): ScanStatus {
  return { ...scanStatus };
}

function emitProgress(): void {
  try {
    // Dynamic import to avoid circular dependency
    import('../socketio.js').then(({ getIO }) => {
      getIO().emit('library:scan-progress' as any, scanStatus);
    }).catch(() => {});
  } catch {}
}

export async function scanLibrary(libraryPaths: string[]): Promise<ScanStatus> {
  if (scanStatus.isScanning) return scanStatus;

  scanStatus = {
    isScanning: true, phase: 'scanning',
    processedFiles: 0, totalFiles: 0,
    newTracks: 0, updatedTracks: 0, removedTracks: 0,
    artists: 0, albums: 0, tracks: 0, errors: 0,
  };
  artistCache.clear();
  albumCache.clear();

  const seenFilePaths = new Set<string>();

  try {
    for (const libPath of libraryPaths) {
      logger.info(`Scanning: ${libPath}`);
      await scanDirectory(libPath, seenFilePaths);
    }

    // Orphan cleanup: remove tracks whose files no longer exist
    scanStatus.phase = 'cleaning';
    emitProgress();
    await cleanOrphans(seenFilePaths);

    scanStatus.phase = 'done';
    scanStatus.isScanning = false;
    emitProgress();
    logger.info(`Scan complete: ${scanStatus.newTracks} new, ${scanStatus.updatedTracks} updated, ${scanStatus.removedTracks} removed, ${scanStatus.errors} errors`);
  } catch (err) {
    logger.error(`Scan failed: ${err}`);
    scanStatus.isScanning = false;
    scanStatus.phase = 'idle';
  }

  artistCache.clear();
  albumCache.clear();
  return scanStatus;
}

async function scanDirectory(dir: string, seenFiles: Set<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  scanStatus.currentDir = dir.split('/').pop() || dir;

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    const filePath = dir + '/' + entry.name;
    seenFiles.add(filePath);
    scanStatus.currentFile = entry.name;

    try {
      // Check if file is already in DB and unchanged
      const existing = getDb().select().from(tracks).where(eq(tracks.filePath, filePath)).get();
      if (existing) {
        // Check modification time
        try {
          const fileStat = await stat(filePath);
          const fileModTime = Math.floor(fileStat.mtimeMs / 1000);
          const dbTime = existing.updatedAt ? Math.floor(new Date(existing.updatedAt as any).getTime() / 1000) : 0;

          if (fileModTime <= dbTime) {
            // File unchanged, skip
            scanStatus.tracks++;
            scanStatus.processedFiles++;
            continue;
          }
          scanStatus.updatedTracks++;
        } catch {
          // Can't stat, process anyway
        }
      } else {
        scanStatus.newTracks++;
      }

      await processFile(filePath);
      scanStatus.tracks++;
    } catch (err) {
      scanStatus.errors++;
      if (scanStatus.errors <= 3) {
        logger.error(`SCAN ERROR [${filePath}]: ${err instanceof Error ? err.stack : String(err)}`);
      }
    }

    scanStatus.processedFiles++;

    if (scanStatus.processedFiles % 100 === 0) {
      logger.info(`Progress: ${scanStatus.processedFiles} files | ${scanStatus.newTracks} new | ${scanStatus.updatedTracks} updated | ${scanStatus.errors} errors`);
      emitProgress();
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await scanDirectory(dir + '/' + entry.name, seenFiles);
    }
  }
}

async function cleanOrphans(seenFiles: Set<string>): Promise<void> {
  const db = getRawDb();
  const allTracks = db.prepare('SELECT id, file_path, album_id, artist_id FROM tracks WHERE source = ?').all('local') as any[];

  const orphanTrackIds: string[] = [];
  const affectedAlbumIds = new Set<string>();
  const affectedArtistIds = new Set<string>();

  for (const track of allTracks) {
    if (track.file_path && !seenFiles.has(track.file_path)) {
      orphanTrackIds.push(track.id);
      affectedAlbumIds.add(track.album_id);
      affectedArtistIds.add(track.artist_id);
    }
  }

  if (orphanTrackIds.length === 0) return;

  logger.info(`Cleaning ${orphanTrackIds.length} orphan tracks`);

  // Delete orphan tracks
  const deleteTracks = db.prepare('DELETE FROM tracks WHERE id = ?');
  const deleteAll = db.transaction(() => {
    for (const id of orphanTrackIds) deleteTracks.run(id);
  });
  deleteAll();
  scanStatus.removedTracks = orphanTrackIds.length;

  // Clean empty albums
  for (const albumId of affectedAlbumIds) {
    const count = (db.prepare('SELECT COUNT(*) as c FROM tracks WHERE album_id = ?').get(albumId) as any)?.c ?? 0;
    if (count === 0) {
      db.prepare('DELETE FROM albums WHERE id = ?').run(albumId);
    } else {
      db.prepare('UPDATE albums SET track_count = ? WHERE id = ?').run(count, albumId);
    }
  }

  // Clean empty artists
  for (const artistId of affectedArtistIds) {
    const count = (db.prepare('SELECT COUNT(*) as c FROM albums WHERE artist_id = ?').get(artistId) as any)?.c ?? 0;
    if (count === 0) {
      db.prepare('DELETE FROM artists WHERE id = ?').run(artistId);
    }
  }
}

async function processFile(filePath: string): Promise<void> {
  const metadata = await parseFile(filePath);
  const { common, format } = metadata;

  const artistName = common.artist || common.albumartist || 'Unknown Artist';
  const albumTitle = common.album || 'Unknown Album';
  const trackTitle = common.title || basename(filePath, extname(filePath));

  // Upsert artist
  const artistKey = artistName.toLowerCase();
  let artistId = artistCache.get(artistKey);
  if (!artistId) {
    artistId = uuid();
    artistCache.set(artistKey, artistId);
    const db = getDb();
    const existing = db.select().from(artists).where(eq(artists.name, artistName)).get();
    if (existing) {
      artistId = existing.id;
      artistCache.set(artistKey, artistId);
    } else {
      db.insert(artists).values({ id: artistId, name: artistName, source: 'local' }).run();
      scanStatus.artists++;
    }
  }

  // Upsert album
  const albumKey = `${artistId}:${albumTitle.toLowerCase()}`;
  let albumId = albumCache.get(albumKey);
  if (!albumId) {
    albumId = uuid();
    albumCache.set(albumKey, albumId);
    const db = getDb();
    const existing = db.select().from(albums)
      .where(eq(albums.title, albumTitle))
      .all()
      .find((a) => a.artistId === artistId);
    if (existing) {
      albumId = existing.id;
      albumCache.set(albumKey, albumId);
    } else {
      db.insert(albums).values({
        id: albumId, title: albumTitle, artistId, artistName,
        year: common.year, genre: common.genre?.[0], source: 'local',
      }).run();
      scanStatus.albums++;
    }
  }

  // Upsert track (insert or update)
  const db = getDb();
  const existingTrack = db.select().from(tracks).where(eq(tracks.filePath, filePath)).get();
  const trackData = {
    title: trackTitle, albumId, albumTitle, artistId, artistName,
    trackNumber: common.track?.no ?? undefined,
    discNumber: common.disk?.no ?? 1,
    duration: format.duration,
    format: extname(filePath).slice(1).toLowerCase(),
    sampleRate: format.sampleRate,
    bitDepth: format.bitsPerSample,
    filePath, source: 'local' as const,
  };

  if (existingTrack) {
    db.update(tracks).set(trackData).where(eq(tracks.id, existingTrack.id)).run();
  } else {
    db.insert(tracks).values({ id: uuid(), ...trackData }).run();
  }

  // Update album track count
  const trackCountResult = db.select().from(tracks).where(eq(tracks.albumId, albumId)).all();
  db.update(albums).set({ trackCount: trackCountResult.length }).where(eq(albums.id, albumId)).run();
}

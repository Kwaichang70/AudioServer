import { readdir, stat } from 'node:fs/promises';
import { extname, basename, dirname } from 'path';
// @ts-expect-error - music-metadata types don't export parseFile in ESM mode
import { parseFile, selectCover } from 'music-metadata';
import { v4 as uuid } from 'uuid';
import { getDb, getRawDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { logger } from '../logger.js';
import { eq, and } from 'drizzle-orm';
import { cacheEmbeddedCover } from './coverart-fetch.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.flac',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.aiff',
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
  successfulRoots: string[];
  failedRoots: Array<{ path: string; error: string; failedDirs: string[] }>;
  orphanCleanupSkipped: boolean;
}

let scanStatus: ScanStatus = {
  isScanning: false,
  phase: 'idle',
  processedFiles: 0,
  totalFiles: 0,
  newTracks: 0,
  updatedTracks: 0,
  removedTracks: 0,
  artists: 0,
  albums: 0,
  tracks: 0,
  errors: 0,
  successfulRoots: [],
  failedRoots: [],
  orphanCleanupSkipped: false,
};

export function getScanStatus(): ScanStatus {
  return { ...scanStatus };
}

function emitProgress(): void {
  try {
    // Dynamic import to avoid circular dependency
    import('../socketio.js')
      .then(({ getIO }) => {
        getIO().emit('library:scan-progress', scanStatus);
      })
      .catch(() => {});
  } catch {}
}

export async function scanLibrary(libraryPaths: string[]): Promise<ScanStatus> {
  if (scanStatus.isScanning) return scanStatus;

  scanStatus = {
    isScanning: true,
    phase: 'discovering',
    processedFiles: 0,
    totalFiles: 0,
    newTracks: 0,
    updatedTracks: 0,
    removedTracks: 0,
    artists: 0,
    albums: 0,
    tracks: 0,
    errors: 0,
    successfulRoots: [],
    failedRoots: [],
    orphanCleanupSkipped: false,
  };
  artistCache.clear();
  albumCache.clear();

  const seenFilePaths = new Set<string>();

  try {
    emitProgress();
    for (const libPath of libraryPaths) {
      scanStatus.currentDir = libPath.split('/').pop() || libPath;
      scanStatus.totalFiles += await countSupportedFiles(libPath);
      emitProgress();
    }

    scanStatus.phase = 'scanning';
    scanStatus.currentFile = undefined;
    emitProgress();

    for (const libPath of libraryPaths) {
      logger.info(`Scanning: ${libPath}`);
      const result = await scanDirectory(libPath, seenFilePaths);
      if (result.ok) {
        scanStatus.successfulRoots.push(libPath);
      } else {
        scanStatus.failedRoots.push({
          path: libPath,
          error: result.error,
          failedDirs: result.failedDirs,
        });
        logger.warn(`Scan root skipped for orphan cleanup: ${libPath} (${result.error})`);
      }
      emitProgress();
    }

    // Orphan cleanup only runs for roots that were fully readable. This avoids
    // deleting database rows when a NAS share is temporarily offline.
    scanStatus.phase = 'cleaning';
    emitProgress();
    if (scanStatus.successfulRoots.length === 0) {
      scanStatus.orphanCleanupSkipped = true;
      logger.warn('Skipping orphan cleanup: no configured music roots were scanned successfully');
    } else {
      await cleanOrphans(seenFilePaths, scanStatus.successfulRoots);
    }

    scanStatus.phase = 'done';
    scanStatus.isScanning = false;
    scanStatus.currentDir = undefined;
    scanStatus.currentFile = undefined;
    emitProgress();
    logger.info(
      `Scan complete: ${scanStatus.newTracks} new, ${scanStatus.updatedTracks} updated, ${scanStatus.removedTracks} removed, ${scanStatus.errors} errors`,
    );
  } catch (err) {
    logger.error(`Scan failed: ${err}`);
    scanStatus.isScanning = false;
    scanStatus.phase = 'idle';
    emitProgress();
  }

  artistCache.clear();
  albumCache.clear();
  return scanStatus;
}

interface DirectoryScanResult {
  ok: boolean;
  error: string;
  failedDirs: string[];
}

interface LocalTrackRow {
  id: string;
  file_path: string | null;
  album_id: string;
  artist_id: string;
}

function describeFsError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function normalizeScanPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isPathUnderRoot(filePath: string, normalizedRoot: string): boolean {
  const normalizedFile = normalizeScanPath(filePath);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

async function scanDirectory(dir: string, seenFiles: Set<string>): Promise<DirectoryScanResult> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const error = describeFsError(err);
    scanStatus.errors++;
    logger.warn(`Cannot read music directory ${dir}: ${error}`);
    return { ok: false, error, failedDirs: [dir] };
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
          const dbTime = existing.updatedAt
            ? Math.floor(new Date(existing.updatedAt as any).getTime() / 1000)
            : 0;

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
      logger.info(
        `Progress: ${scanStatus.processedFiles} files | ${scanStatus.newTracks} new | ${scanStatus.updatedTracks} updated | ${scanStatus.errors} errors`,
      );
      emitProgress();
    }
  }

  // Recurse into subdirectories
  const failedDirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const result = await scanDirectory(dir + '/' + entry.name, seenFiles);
      if (!result.ok) failedDirs.push(...result.failedDirs);
    }
  }

  if (failedDirs.length > 0) {
    return {
      ok: false,
      error: `Failed to read ${failedDirs.length} director${failedDirs.length === 1 ? 'y' : 'ies'}`,
      failedDirs,
    };
  }

  return { ok: true, error: '', failedDirs: [] };
}

async function countSupportedFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countSupportedFiles(`${dir}/${entry.name}`);
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      count++;
    }
  }
  return count;
}

async function cleanOrphans(seenFiles: Set<string>, successfulRoots: string[]): Promise<void> {
  const db = getRawDb();
  const allTracks = db
    .prepare('SELECT id, file_path, album_id, artist_id FROM tracks WHERE source = ?')
    .all('local') as LocalTrackRow[];
  const normalizedSeenFiles = new Set(Array.from(seenFiles, normalizeScanPath));
  const normalizedRoots = successfulRoots.map(normalizeScanPath);

  const orphanTrackIds: string[] = [];
  const affectedAlbumIds = new Set<string>();
  const affectedArtistIds = new Set<string>();

  for (const track of allTracks) {
    const filePath = track.file_path;
    if (!filePath) continue;
    if (!normalizedRoots.some((root) => isPathUnderRoot(filePath, root))) continue;

    if (!normalizedSeenFiles.has(normalizeScanPath(filePath))) {
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
    const count =
      (db.prepare('SELECT COUNT(*) as c FROM tracks WHERE album_id = ?').get(albumId) as any)?.c ??
      0;
    if (count === 0) {
      db.prepare('DELETE FROM albums WHERE id = ?').run(albumId);
    } else {
      db.prepare('UPDATE albums SET track_count = ? WHERE id = ?').run(count, albumId);
    }
  }

  // Clean empty artists
  for (const artistId of affectedArtistIds) {
    const count =
      (db.prepare('SELECT COUNT(*) as c FROM albums WHERE artist_id = ?').get(artistId) as any)
        ?.c ?? 0;
    if (count === 0) {
      db.prepare('DELETE FROM artists WHERE id = ?').run(artistId);
    }
  }
}

async function processFile(filePath: string): Promise<void> {
  const metadata = await parseFile(filePath);
  const { common, format } = metadata;

  const trackArtistNames = normalizePeople(common.artists ?? common.artist);
  const isCompilation = Boolean((common as { compilation?: boolean | string }).compilation);
  const artistName = trackArtistNames.join(', ') || common.albumartist || 'Unknown Artist';
  const albumArtistName = common.albumartist || (isCompilation ? 'Various Artists' : artistName);
  const albumTitle = common.album || 'Unknown Album';
  const trackTitle = common.title || basename(filePath, extname(filePath));
  const composer = normalizePeople(common.composer).join(', ') || undefined;
  const conductor = normalizePeople(common.conductor).join(', ') || undefined;

  // Upsert artist
  const artistKey = albumArtistName.toLowerCase();
  let artistId = artistCache.get(artistKey);
  if (!artistId) {
    artistId = uuid();
    artistCache.set(artistKey, artistId);
    const db = getDb();
    const existing = db.select().from(artists).where(eq(artists.name, albumArtistName)).get();
    if (existing) {
      artistId = existing.id;
      artistCache.set(artistKey, artistId);
    } else {
      db.insert(artists).values({ id: artistId, name: albumArtistName, source: 'local' }).run();
      scanStatus.artists++;
    }
  }

  // Upsert album. The folder is part of the identity: the same album ripped at
  // multiple qualities (each in its own folder) becomes separate album entries
  // instead of one album with every track duplicated. The quality (format /
  // sample rate / bit depth) is stored so the UI can tell those editions apart.
  const albumDir = dirname(filePath);
  const albumKey = `${artistId}:${albumTitle.toLowerCase()}:${albumDir.toLowerCase()}`;
  let albumId = albumCache.get(albumKey);
  if (!albumId) {
    albumId = uuid();
    albumCache.set(albumKey, albumId);
    const db = getDb();
    const existing = db
      .select()
      .from(albums)
      .where(
        and(
          eq(albums.title, albumTitle),
          eq(albums.artistId, artistId),
          eq(albums.dirPath, albumDir),
        ),
      )
      .get();
    if (existing) {
      albumId = existing.id;
      albumCache.set(albumKey, albumId);
    } else {
      db.insert(albums)
        .values({
          id: albumId,
          title: albumTitle,
          artistId,
          artistName: albumArtistName,
          year: common.year,
          genre: common.genre?.[0],
          isCompilation,
          source: 'local',
          dirPath: albumDir,
          format: extname(filePath).slice(1).toLowerCase(),
          sampleRate: format.sampleRate,
          bitDepth: format.bitsPerSample,
        })
        .run();
      scanStatus.albums++;
    }
  }

  // ReplayGain (per-track). music-metadata returns IRatio { ratio, dB }.
  // We store the dB value (player applies 10^(dB/20)) and the peak ratio
  // (used to clamp the gain so we don't clip when the track has hot peaks).
  const rgTrackGain = (common as { replaygain_track_gain?: { dB?: number } }).replaygain_track_gain
    ?.dB;
  const rgTrackPeak = (common as { replaygain_track_peak?: { ratio?: number } })
    .replaygain_track_peak?.ratio;
  const rgAlbumGain = (common as { replaygain_album_gain?: { dB?: number } }).replaygain_album_gain
    ?.dB;
  const rgAlbumPeak = (common as { replaygain_album_peak?: { ratio?: number } })
    .replaygain_album_peak?.ratio;

  // Upsert track (insert or update)
  const db = getDb();
  const existingTrack = db.select().from(tracks).where(eq(tracks.filePath, filePath)).get();
  const trackData = {
    title: trackTitle,
    albumId,
    albumTitle,
    artistId,
    artistName,
    artistNames: trackArtistNames.join(', ') || null,
    composer: composer ?? null,
    conductor: conductor ?? null,
    trackNumber: common.track?.no ?? undefined,
    discNumber: common.disk?.no ?? 1,
    duration: format.duration,
    format: extname(filePath).slice(1).toLowerCase(),
    sampleRate: format.sampleRate,
    bitDepth: format.bitsPerSample,
    replayGainTrack: rgTrackGain ?? null,
    replayGainTrackPeak: rgTrackPeak ?? null,
    filePath,
    source: 'local' as const,
    updatedAt: new Date(),
  };

  if (existingTrack) {
    db.update(tracks).set(trackData).where(eq(tracks.id, existingTrack.id)).run();
  } else {
    db.insert(tracks)
      .values({ id: uuid(), ...trackData })
      .run();
  }

  // Album-level RG: prefer the value embedded in the file (every track on the
  // same album should carry the identical album_gain tag). We write it every
  // time so the latest-scanned track wins — fine because the value is the
  // same across the album.
  if (rgAlbumGain !== undefined || rgAlbumPeak !== undefined) {
    db.update(albums)
      .set({
        replayGainAlbum: rgAlbumGain ?? null,
        replayGainAlbumPeak: rgAlbumPeak ?? null,
      })
      .where(eq(albums.id, albumId))
      .run();
  }

  const cover = selectCover(common.picture);
  if (cover) {
    cacheEmbeddedCover(albumId, Buffer.from(cover.data), cover.format || 'image/jpeg');
  }

  // Update album track count
  const trackCountResult = db.select().from(tracks).where(eq(tracks.albumId, albumId)).all();
  db.update(albums)
    .set({
      trackCount: trackCountResult.length,
      artistName: albumArtistName,
      year: common.year,
      genre: common.genre?.[0],
      isCompilation,
      updatedAt: new Date(),
    })
    .where(eq(albums.id, albumId))
    .run();
}

function normalizePeople(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw
    .flatMap((item) => item.split(/\s*(?:;|\/)\s*/))
    .map((item) => item.trim())
    .filter(Boolean);
}

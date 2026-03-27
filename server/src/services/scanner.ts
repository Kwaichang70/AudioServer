import { readdir } from 'node:fs/promises';
import { extname, basename } from 'path';
// @ts-expect-error - music-metadata types don't export parseFile in ESM mode
import { parseFile } from 'music-metadata';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
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
  phase: 'idle' | 'scanning' | 'done';
  processedFiles: number;
  artists: number;
  albums: number;
  tracks: number;
  errors: number;
  currentDir?: string;
}

let scanStatus: ScanStatus = {
  isScanning: false, phase: 'idle',
  processedFiles: 0, artists: 0, albums: 0, tracks: 0, errors: 0,
};

export function getScanStatus(): ScanStatus {
  return { ...scanStatus };
}

export async function scanLibrary(libraryPaths: string[]): Promise<ScanStatus> {
  if (scanStatus.isScanning) return scanStatus;

  scanStatus = {
    isScanning: true, phase: 'scanning',
    processedFiles: 0, artists: 0, albums: 0, tracks: 0, errors: 0,
  };
  artistCache.clear();
  albumCache.clear();

  try {
    for (const libPath of libraryPaths) {
      logger.info(`Scanning: ${libPath}`);
      await scanDirectory(libPath);
    }
    scanStatus.phase = 'done';
    scanStatus.isScanning = false;
    logger.info(`Scan complete: ${scanStatus.artists} artists, ${scanStatus.albums} albums, ${scanStatus.tracks} tracks, ${scanStatus.errors} errors`);
  } catch (err) {
    logger.error(`Scan failed: ${err}`);
    scanStatus.isScanning = false;
    scanStatus.phase = 'idle';
  }

  artistCache.clear();
  albumCache.clear();
  return scanStatus;
}

// Walk and process one directory at a time (stream-like, no big collect step)
async function scanDirectory(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn(`Cannot read: ${dir}`);
    return;
  }

  scanStatus.currentDir = dir.split('/').pop() || dir;

  // Process audio files in this directory
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    const filePath = dir + '/' + entry.name;
    try {
      const result = await processFile(filePath);
      if (result.newArtist) scanStatus.artists++;
      if (result.newAlbum) scanStatus.albums++;
      scanStatus.tracks++;
    } catch (err) {
      scanStatus.errors++;
      if (scanStatus.errors <= 3) {
        logger.error(`SCAN ERROR [${filePath}]: ${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    scanStatus.processedFiles++;

    if (scanStatus.processedFiles % 100 === 0) {
      logger.info(`Progress: ${scanStatus.processedFiles} files | ${scanStatus.artists} artists | ${scanStatus.albums} albums | ${scanStatus.tracks} tracks | ${scanStatus.errors} errors`);
    }
  }

  // Recurse into subdirectories
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await scanDirectory(dir + '/' + entry.name);
    }
  }
}

async function processFile(filePath: string): Promise<{ newArtist: boolean; newAlbum: boolean }> {
  const metadata = await parseFile(filePath);
  const { common, format } = metadata;

  const artistName = common.artist || common.albumartist || 'Unknown Artist';
  const albumTitle = common.album || 'Unknown Album';
  const trackTitle = common.title || basename(filePath, extname(filePath));

  let newArtist = false;
  let newAlbum = false;

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
      newArtist = true;
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
        id: albumId,
        title: albumTitle,
        artistId,
        artistName,
        year: common.year,
        genre: common.genre?.[0],
        source: 'local',
      }).run();
      newAlbum = true;
    }
  }

  // Insert track (skip if already exists)
  const db = getDb();
  const existingTrack = db.select().from(tracks).where(eq(tracks.filePath, filePath)).get();
  if (!existingTrack) {
    db.insert(tracks).values({
      id: uuid(),
      title: trackTitle,
      albumId,
      albumTitle,
      artistId,
      artistName,
      trackNumber: common.track?.no ?? undefined,
      discNumber: common.disk?.no ?? 1,
      duration: format.duration,
      format: extname(filePath).slice(1).toLowerCase(),
      sampleRate: format.sampleRate,
      bitDepth: format.bitsPerSample,
      filePath,
      source: 'local',
    }).run();
  }

  // Update album track count
  const trackCountResult = db.select().from(tracks).where(eq(tracks.albumId, albumId)).all();
  db.update(albums).set({ trackCount: trackCountResult.length }).where(eq(albums.id, albumId)).run();

  return { newArtist, newAlbum };
}

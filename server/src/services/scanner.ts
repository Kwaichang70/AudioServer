import { readdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';
// @ts-expect-error - music-metadata ESM/CJS interop
import { parseFile } from 'music-metadata';
import { v4 as uuid } from 'uuid';
import { getDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { logger } from '../logger.js';
import { eq } from 'drizzle-orm';

const SUPPORTED_EXTENSIONS = new Set([
  '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.aiff',
]);

// Simple in-memory cache to map artist/album names to IDs during a scan
const artistCache = new Map<string, string>();
const albumCache = new Map<string, string>();

export async function scanLibrary(libraryPaths: string[]): Promise<{ tracks: number; albums: number; artists: number }> {
  let trackCount = 0;
  let albumCount = 0;
  let artistCount = 0;

  artistCache.clear();
  albumCache.clear();

  for (const libPath of libraryPaths) {
    logger.info(`Scanning: ${libPath}`);
    const files = await collectAudioFiles(libPath);
    logger.info(`Found ${files.length} audio files in ${libPath}`);

    for (const filePath of files) {
      try {
        const result = await processFile(filePath);
        if (result.newArtist) artistCount++;
        if (result.newAlbum) albumCount++;
        trackCount++;
      } catch (err) {
        logger.warn(`Failed to process ${filePath}: ${err}`);
      }
    }
  }

  artistCache.clear();
  albumCache.clear();

  logger.info(`Scan complete: ${artistCount} artists, ${albumCount} albums, ${trackCount} tracks`);
  return { tracks: trackCount, albums: albumCount, artists: artistCount };
}

async function collectAudioFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await collectAudioFiles(fullPath);
        results.push(...subFiles);
      } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  } catch (err) {
    logger.warn(`Cannot read directory ${dir}: ${err}`);
  }

  return results;
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

  // Insert track
  const trackId = uuid();
  const db = getDb();

  // Check if track already exists by file path
  const existingTrack = db.select().from(tracks).where(eq(tracks.filePath, filePath)).get();
  if (!existingTrack) {
    db.insert(tracks).values({
      id: trackId,
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

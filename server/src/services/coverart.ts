// @ts-expect-error - music-metadata types don't export parseFile in ESM mode
import { parseFile, selectCover } from 'music-metadata';
import { getDb } from '../db/index.js';
import { tracks } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';

interface CoverResult {
  data: Buffer;
  mime: string;
}

// Simple in-memory LRU cache for cover art (avoids re-reading files from NAS)
const coverCache = new Map<string, CoverResult | null>();
const MAX_CACHE_SIZE = 200;

function addToCache(key: string, value: CoverResult | null) {
  if (coverCache.size >= MAX_CACHE_SIZE) {
    // Delete oldest entry
    const firstKey = coverCache.keys().next().value!;
    coverCache.delete(firstKey);
  }
  coverCache.set(key, value);
}

export async function getCoverForTrack(trackId: string): Promise<CoverResult | null> {
  if (coverCache.has(trackId)) return coverCache.get(trackId)!;

  const db = getDb();
  const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get();
  if (!track?.filePath) return null;

  return getCoverFromFile(track.filePath, trackId);
}

export async function getCoverForAlbum(albumId: string): Promise<CoverResult | null> {
  if (coverCache.has(`album:${albumId}`)) return coverCache.get(`album:${albumId}`)!;

  const db = getDb();
  // Get first track of this album that has a file path
  const track = db.select().from(tracks)
    .where(eq(tracks.albumId, albumId))
    .limit(1)
    .get();
  if (!track?.filePath) return null;

  const result = await getCoverFromFile(track.filePath, `album:${albumId}`);
  return result;
}

async function getCoverFromFile(filePath: string, cacheKey: string): Promise<CoverResult | null> {
  try {
    const metadata = await parseFile(filePath);
    const cover = selectCover(metadata.common.picture);
    if (cover) {
      const result: CoverResult = {
        data: Buffer.from(cover.data),
        mime: cover.format || 'image/jpeg',
      };
      addToCache(cacheKey, result);
      return result;
    }
  } catch (err) {
    logger.debug(`No cover art in ${filePath}: ${err}`);
  }

  addToCache(cacheKey, null);
  return null;
}

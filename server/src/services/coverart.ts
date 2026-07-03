// @ts-expect-error - music-metadata types don't export parseFile in ESM mode
import { parseFile, selectCover } from 'music-metadata';
import { getDb } from '../db/index.js';
import { tracks } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { readCachedCover } from './coverart-fetch.js';

interface CoverResult {
  data: Buffer;
  mime: string;
}

// Simple in-memory LRU cache for cover art (avoids re-reading files from NAS)
const coverCache = new Map<string, CoverResult | null>();
const MAX_CACHE_SIZE = 200;

function addToCache(key: string, value: CoverResult | null) {
  if (coverCache.size >= MAX_CACHE_SIZE) {
    const firstKey = coverCache.keys().next().value!;
    coverCache.delete(firstKey);
  }
  coverCache.set(key, value);
}

export async function getCoverForTrack(trackId: string): Promise<CoverResult | null> {
  const hit = coverCache.get(trackId);
  if (hit) return hit;
  const hadNegative = coverCache.has(trackId); // cached null = "no embedded art"

  const db = getDb();
  const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get();
  if (!track) return null;

  // On a negative hit, don't re-parse the audio file — but DO re-check the
  // album's disk-cached art (cheap existsSync): the fetch job may have stored
  // it since, and tracks without embedded art should show the album cover.
  if (!hadNegative && track.filePath) {
    const embedded = await getCoverFromFile(track.filePath, trackId);
    if (embedded) return embedded;
  }

  const albumArt = track.albumId ? readCachedCover(track.albumId) : null;
  if (albumArt) {
    coverCache.set(trackId, albumArt);
    return albumArt;
  }
  return null;
}

export async function getCoverForAlbum(albumId: string): Promise<CoverResult | null> {
  const memKey = `album:${albumId}`;
  const hit = coverCache.get(memKey);
  if (hit) return hit;
  const hadNegative = coverCache.has(memKey);

  // 1. Check disk cache (fetched from MusicBrainz/Spotify, or embedded art the
  // scanner cached). Also re-checked on negative memory hits: the fetch job
  // may have stored art since the 404 was cached — without this, covers stay
  // 404 until the container restarts.
  const cached = readCachedCover(albumId);
  if (cached) {
    addToCache(memKey, cached);
    return cached;
  }
  if (hadNegative) return null; // negative + still nothing on disk: skip re-parsing

  // 2. Try extracting from embedded audio metadata
  const db = getDb();
  const track = db.select().from(tracks).where(eq(tracks.albumId, albumId)).limit(1).get();
  if (!track?.filePath) return null;

  const result = await getCoverFromFile(track.filePath, memKey);
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

import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/index.js';
import { albums } from '../db/schema.js';
// eq removed - not currently used
import { logger } from '../logger.js';

const COVER_DIR = './data/covers';
const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const COVERART_API = 'https://coverartarchive.org';
const USER_AGENT = 'AudioServer/1.0 (https://github.com/Kwaichang70/AudioServer)';

// Rate limiting: MusicBrainz allows 1 request per second
let lastRequestTime = 0;
async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastRequestTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestTime = Date.now();

  return fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
}

interface FetchStatus {
  isRunning: boolean;
  total: number;
  processed: number;
  found: number;
  notFound: number;
}

let fetchStatus: FetchStatus = {
  isRunning: false, total: 0, processed: 0, found: 0, notFound: 0,
};

export function getCoverFetchStatus(): FetchStatus {
  return { ...fetchStatus };
}

/**
 * Get the local cover path for an album. Returns null if not cached.
 */
export function getLocalCoverPath(albumId: string): string | null {
  const path = join(COVER_DIR, `${albumId}.jpg`);
  return existsSync(path) ? path : null;
}

/**
 * Fetch cover art for all albums that don't have one.
 * Runs in background, uses MusicBrainz + Cover Art Archive.
 */
export async function fetchMissingCovers(): Promise<FetchStatus> {
  if (fetchStatus.isRunning) return fetchStatus;

  mkdirSync(COVER_DIR, { recursive: true });

  const db = getDb();
  const allAlbums = db.select().from(albums).all();

  // Filter albums that don't have a local cover yet
  const missing = allAlbums.filter((a) => !getLocalCoverPath(a.id));

  fetchStatus = {
    isRunning: true,
    total: missing.length,
    processed: 0,
    found: 0,
    notFound: 0,
  };

  logger.info(`Cover art fetch: ${missing.length} albums without covers`);

  for (const album of missing) {
    try {
      const found = await fetchCoverForAlbum(album.id, album.artistName, album.title);
      if (found) {
        fetchStatus.found++;
      } else {
        fetchStatus.notFound++;
      }
    } catch (err) {
      fetchStatus.notFound++;
      logger.debug(`Cover fetch failed for "${album.title}": ${err}`);
    }

    fetchStatus.processed++;

    if (fetchStatus.processed % 50 === 0) {
      logger.info(`Cover art: ${fetchStatus.processed}/${fetchStatus.total} (${fetchStatus.found} found)`);
    }
  }

  fetchStatus.isRunning = false;
  logger.info(`Cover art fetch complete: ${fetchStatus.found} found, ${fetchStatus.notFound} not found`);
  return fetchStatus;
}

/**
 * Try to fetch cover art for a single album.
 * Returns true if found and saved.
 */
async function fetchCoverForAlbum(albumId: string, artist: string, title: string): Promise<boolean> {
  // Skip "Unknown Album"
  if (title === 'Unknown Album') return false;

  // Already have it?
  if (getLocalCoverPath(albumId)) return true;

  // Strategy 1: MusicBrainz + Cover Art Archive
  const coverData = await fetchFromMusicBrainz(artist, title);
  if (coverData) {
    saveCover(albumId, coverData);
    return true;
  }

  // Strategy 2: Spotify search (if authenticated)
  const spotifyCover = await fetchFromSpotify(artist, title);
  if (spotifyCover) {
    saveCover(albumId, spotifyCover);
    return true;
  }

  return false;
}

async function fetchFromMusicBrainz(artist: string, title: string): Promise<Buffer | null> {
  try {
    // Clean up search terms
    const cleanArtist = artist.replace(/[^\w\s]/g, '').trim();
    const cleanTitle = title.replace(/[^\w\s]/g, '').trim();

    if (!cleanArtist || !cleanTitle) return null;

    // Search for the release on MusicBrainz
    const query = `release:"${cleanTitle}" AND artist:"${cleanArtist}"`;
    const searchUrl = `${MUSICBRAINZ_API}/release?query=${encodeURIComponent(query)}&limit=5&fmt=json`;

    const searchRes = await rateLimitedFetch(searchUrl);
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json() as any;
    const releases = searchData.releases || [];

    if (releases.length === 0) return null;

    // Try each release until we find cover art
    for (const release of releases.slice(0, 3)) {
      const mbid = release.id;

      try {
        // Check Cover Art Archive
        const coverRes = await rateLimitedFetch(`${COVERART_API}/release/${mbid}`);
        if (!coverRes.ok) continue;

        const coverData = await coverRes.json() as any;
        const frontImage = coverData.images?.find((img: any) =>
          img.front === true || img.types?.includes('Front')
        );

        if (!frontImage) continue;

        // Download the image (use thumbnail for smaller size)
        const imageUrl = frontImage.thumbnails?.large || frontImage.thumbnails?.small || frontImage.image;
        if (!imageUrl) continue;

        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) continue;

        const buffer = Buffer.from(await imgRes.arrayBuffer());
        if (buffer.length > 1000) { // Sanity check: at least 1KB
          return buffer;
        }
      } catch {
        // Try next release
      }
    }

    return null;
  } catch (err) {
    logger.debug(`MusicBrainz search failed for "${artist} - ${title}": ${err}`);
    return null;
  }
}

async function fetchFromSpotify(artist: string, title: string): Promise<Buffer | null> {
  try {
    // Use the provider registry to access Spotify
    const { providers } = await import('../providers/registry.js');
    if (!providers.spotify.auth.isAuthenticated) return null;

    const results = await providers.spotify.search(`album:${title} artist:${artist}`, 3);
    const album = results.albums?.[0];
    if (!album?.coverUrl) return null;

    const imgRes = await fetch(album.coverUrl);
    if (!imgRes.ok) return null;

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    if (buffer.length > 1000) return buffer;
  } catch (err) {
    logger.debug(`Spotify cover fetch failed for "${artist} - ${title}": ${err}`);
  }
  return null;
}

function saveCover(albumId: string, data: Buffer): void {
  mkdirSync(COVER_DIR, { recursive: true });
  const path = join(COVER_DIR, `${albumId}.jpg`);
  writeFileSync(path, data);
}

/**
 * Read a cached cover from disk.
 */
export function readCachedCover(albumId: string): { data: Buffer; mime: string } | null {
  const path = getLocalCoverPath(albumId);
  if (!path) return null;
  try {
    return { data: readFileSync(path), mime: 'image/jpeg' };
  } catch {
    return null;
  }
}

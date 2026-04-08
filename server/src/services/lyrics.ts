import { getDb } from '../db/index.js';
import { tracks } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';

// music-metadata parseFile (ESM compat)
const mm = await import('music-metadata');
const parseFile = (mm as any).parseFile;

const LRCLIB_API = 'https://lrclib.net/api';

interface LyricsResult {
  plain?: string;
  synced?: string; // LRC format
  source: 'embedded' | 'lrclib';
}

// In-memory cache
const cache = new Map<string, LyricsResult | null>();

/**
 * Get lyrics for a track. Tries:
 * 1. Embedded lyrics from audio file metadata (USLT/SYLT tags)
 * 2. LRCLIB.net free API
 */
export async function getLyrics(trackId: string): Promise<LyricsResult | null> {
  if (cache.has(trackId)) return cache.get(trackId) || null;

  const db = getDb();
  const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get();
  if (!track) return null;

  // Try embedded lyrics from file
  if (track.filePath) {
    try {
      const metadata = await parseFile(track.filePath);
      const lyrics = metadata.common.lyrics;
      if (lyrics && lyrics.length > 0) {
        const text = typeof lyrics[0] === 'string' ? lyrics[0] : lyrics[0].text;
        if (text) {
          const result: LyricsResult = { plain: text, source: 'embedded' };
          // Check if it's synced (LRC format)
          if (text.match(/^\[\d{2}:\d{2}/m)) {
            result.synced = text;
          }
          cache.set(trackId, result);
          return result;
        }
      }
    } catch {
      // File parsing failed, try online
    }
  }

  // Try LRCLIB
  try {
    const params = new URLSearchParams({
      track_name: track.title,
      artist_name: track.artistName,
    });
    if (track.albumTitle) params.set('album_name', track.albumTitle);
    if (track.duration) params.set('duration', String(Math.round(track.duration)));

    const res = await fetch(`${LRCLIB_API}/get?${params}`, {
      headers: { 'User-Agent': 'AudioServer/1.0' },
    });

    if (res.ok) {
      const data = await res.json() as any;
      const result: LyricsResult = { source: 'lrclib' };
      if (data.syncedLyrics) result.synced = data.syncedLyrics;
      if (data.plainLyrics) result.plain = data.plainLyrics;

      if (result.plain || result.synced) {
        cache.set(trackId, result);
        logger.debug(`Lyrics found for "${track.title}" via LRCLIB`);
        return result;
      }
    }
  } catch (err) {
    logger.debug(`LRCLIB fetch failed for "${track.title}": ${err}`);
  }

  cache.set(trackId, null);
  return null;
}

/**
 * Parse synced LRC lyrics into timed lines
 */
export function parseLrc(lrc: string): { time: number; text: string }[] {
  const lines: { time: number; text: string }[] = [];
  for (const line of lrc.split('\n')) {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (match) {
      const min = parseInt(match[1]);
      const sec = parseInt(match[2]);
      const ms = parseInt(match[3].padEnd(3, '0'));
      const time = min * 60 + sec + ms / 1000;
      const text = match[4].trim();
      if (text) lines.push({ time, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

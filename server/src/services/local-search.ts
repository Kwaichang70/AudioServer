import type { Album, Artist, Track } from '@audioserver/shared';
import { getRawDb } from '../db/index.js';

/**
 * Ranked local search (V07.3).
 *
 * One query per entity, all case-insensitive on the NOCASE indexes:
 *   rank 0  exact match on the title/name
 *   rank 1  title/name starts with the query (prefix, index-assisted)
 *   rank 2  title/name contains the query
 *   rank 3  another field contains it (artist on a track, album on a track)
 * Ties break alphabetically. Missing local files stay in the results, marked
 * by `availability`, so a user understands why a known track cannot play.
 *
 * The benchmark (`npm run bench:search`) showed plain LIKE with these
 * indexes stays far below the 300 ms p95 target at 50 000 tracks, so no
 * FTS5 virtual table is used. Add one only with a new measurement.
 */

export interface LocalSearchOptions {
  limit?: number;
  /** Only tracks in this container format ('flac', 'mp3', ...). */
  format?: string;
  /** 'lossless' (flac/wav/aiff/alac) or 'hires' (> 16 bit or > 48 kHz). */
  quality?: 'lossless' | 'hires';
}

export interface LocalSearchResults {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
}

const LOSSLESS_FORMATS = ['flac', 'wav', 'aiff', 'aif', 'alac', 'ape'];

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function searchLocal(query: string, options: LocalSearchOptions = {}): LocalSearchResults {
  const q = query.trim();
  if (!q) return { artists: [], albums: [], tracks: [] };
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const db = getRawDb();
  const exact = q;
  const prefix = `${escapeLike(q)}%`;
  const contains = `%${escapeLike(q)}%`;

  const artistRows = db
    .prepare(
      `SELECT id, name, image_url as imageUrl, source
         FROM artists
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY CASE WHEN name = ? COLLATE NOCASE THEN 0 WHEN name LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
                 name COLLATE NOCASE
        LIMIT ?`,
    )
    .all(contains, exact, prefix, limit) as Artist[];

  const albumRows = db
    .prepare(
      `SELECT id, title, artist_id as artistId, artist_name as artistName, year, genre,
              cover_url as coverUrl, is_compilation as isCompilation, track_count as trackCount,
              format, sample_rate as sampleRate, bit_depth as bitDepth, source
         FROM albums
        WHERE title LIKE ? ESCAPE '\\' OR artist_name LIKE ? ESCAPE '\\'
        ORDER BY CASE WHEN title = ? COLLATE NOCASE THEN 0
                      WHEN title LIKE ? ESCAPE '\\' THEN 1
                      WHEN title LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END,
                 title COLLATE NOCASE
        LIMIT ?`,
    )
    .all(contains, contains, exact, prefix, contains, limit) as Album[];

  const filters: string[] = [];
  const params: unknown[] = [contains, contains, contains];
  if (options.format) {
    filters.push('AND format = ?');
    params.push(options.format.toLowerCase());
  }
  if (options.quality === 'lossless') {
    filters.push(`AND format IN (${LOSSLESS_FORMATS.map(() => '?').join(',')})`);
    params.push(...LOSSLESS_FORMATS);
  } else if (options.quality === 'hires') {
    filters.push(
      `AND format IN (${LOSSLESS_FORMATS.map(() => '?').join(',')}) AND (bit_depth > 16 OR sample_rate > 48000)`,
    );
    params.push(...LOSSLESS_FORMATS);
  }
  params.push(exact, prefix, contains, limit);

  const trackRows = db
    .prepare(
      `SELECT id, title, album_id as albumId, album_title as albumTitle, artist_id as artistId,
              artist_name as artistName, artist_names as artistNames, track_number as trackNumber,
              disc_number as discNumber, duration, format, sample_rate as sampleRate,
              bit_depth as bitDepth, file_path as filePath, cover_url as coverUrl, source, availability
         FROM tracks
        WHERE (title LIKE ? ESCAPE '\\' OR artist_name LIKE ? ESCAPE '\\' OR album_title LIKE ? ESCAPE '\\')
          ${filters.join(' ')}
        ORDER BY CASE WHEN title = ? COLLATE NOCASE THEN 0
                      WHEN title LIKE ? ESCAPE '\\' THEN 1
                      WHEN title LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END,
                 CASE WHEN availability = 'missing' THEN 1 ELSE 0 END, title COLLATE NOCASE
        LIMIT ?`,
    )
    .all(...params) as Track[];

  return { artists: artistRows, albums: albumRows, tracks: trackRows };
}

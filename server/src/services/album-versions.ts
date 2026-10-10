import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';
import { compareForm } from './identify.js';

/**
 * Other versions of an album (R04.3).
 *
 * Two kinds, and both say what they are:
 *
 * - LOCAL editions: the same album in another quality or pressing. They are
 *   found by identity when there is one (the same MusicBrainz release group),
 *   and otherwise by the same artist and title with a different edition key —
 *   the FLAC next to the MP3 rip, the 24-bit remaster next to the CD.
 * - QOBUZ alternatives: the same album on Qobuz, matched on artist and title
 *   in compare-form, with the best quality Qobuz offers so the page can say
 *   "also on Qobuz at 24/96" and start it from there.
 *
 * A provider that does not answer within its budget is reported as such
 * rather than as "no other versions": silence from Qobuz is not evidence.
 */

export interface LocalVersion {
  id: string;
  title: string;
  format: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  trackCount: number | null;
  label: string | null;
  releaseDate: string | null;
  /** Why it counts as the same album: 'release-group' or 'title'. */
  matchedBy: 'release-group' | 'title';
}

export interface StreamingVersion {
  id: string;
  source: 'qobuz';
  title: string;
  artistName: string;
  sampleRate: number | null;
  bitDepth: number | null;
  trackCount: number | null;
  year: number | null;
  /** True when this beats the best local edition in resolution. */
  higherResolution: boolean;
}

export interface AlbumVersions {
  local: LocalVersion[];
  streaming: StreamingVersion[];
  /** Per source: 'ok', 'unavailable' (not connected) or 'timeout'. */
  sources: Record<string, 'ok' | 'unavailable' | 'timeout' | 'error'>;
}

interface AlbumRow {
  id: string;
  title: string;
  artist_id: string;
  artist_name: string;
  edition_key: string | null;
  release_group_mbid: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
}

/** Bits × rate, so 24/96 beats 24/48 beats 16/44.1; unknown counts as nothing. */
function resolutionScore(bitDepth: number | null, sampleRate: number | null): number {
  return (bitDepth ?? 0) * (sampleRate ?? 0);
}

export function localVersions(albumId: string): LocalVersion[] {
  const db = getRawDb();
  const album = db
    .prepare(
      `SELECT id, title, artist_id, artist_name, edition_key, release_group_mbid, sample_rate, bit_depth
         FROM albums WHERE id = ?`,
    )
    .get(albumId) as AlbumRow | undefined;
  if (!album) return [];

  const rows = db
    .prepare(
      `SELECT id, title, format, sample_rate as sampleRate, bit_depth as bitDepth,
              track_count as trackCount, label, release_date as releaseDate,
              CASE WHEN ? IS NOT NULL AND release_group_mbid = ? THEN 'release-group'
                   ELSE 'title' END as matchedBy
         FROM albums
        WHERE id != ?
          AND source = 'local'
          AND (
            (? IS NOT NULL AND release_group_mbid = ?)
            OR (artist_id = ? AND title = ? COLLATE NOCASE
                AND COALESCE(edition_key, '') != COALESCE(?, ''))
          )
        ORDER BY bit_depth DESC, sample_rate DESC, format`,
    )
    .all(
      album.release_group_mbid,
      album.release_group_mbid,
      album.id,
      album.release_group_mbid,
      album.release_group_mbid,
      album.artist_id,
      album.title,
      album.edition_key,
    ) as LocalVersion[];
  return rows;
}

export interface VersionsDeps {
  searchQobuz: (query: string) => Promise<
    Array<{
      id: string;
      title: string;
      artistName: string;
      sampleRate?: number;
      bitDepth?: number;
      trackCount?: number;
      year?: number;
    }>
  >;
  /** Is Qobuz connected right now? A search without a session returns nothing. */
  qobuzReady: () => Promise<boolean>;
  timeoutMs: number;
}

let deps: VersionsDeps = {
  searchQobuz: async (query) => {
    const { providers } = await import('../providers/registry.js');
    const results = await providers.qobuz.search(query, 10);
    return results.albums;
  },
  qobuzReady: async () => {
    try {
      const { providers } = await import('../providers/registry.js');
      return providers.qobuz.getStatus().authenticated === true;
    } catch {
      return false;
    }
  },
  timeoutMs: 4000,
};

export function configureAlbumVersions(overrides: Partial<VersionsDeps>): void {
  deps = { ...deps, ...overrides };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Every other version of an album: local editions and Qobuz alternatives. */
export async function albumVersions(
  albumId: string,
  options: { includeStreaming?: boolean } = {},
): Promise<AlbumVersions | null> {
  const album = getRawDb()
    .prepare(
      `SELECT id, title, artist_id, artist_name, edition_key, release_group_mbid, sample_rate, bit_depth
         FROM albums WHERE id = ?`,
    )
    .get(albumId) as AlbumRow | undefined;
  if (!album) return null;

  const local = localVersions(albumId);
  const result: AlbumVersions = { local, streaming: [], sources: {} };
  if (options.includeStreaming === false) return result;

  const ready = await deps.qobuzReady();
  if (!ready) {
    result.sources.qobuz = 'unavailable';
    return result;
  }

  const bestLocal = Math.max(
    resolutionScore(album.bit_depth, album.sample_rate),
    ...local.map((v) => resolutionScore(v.bitDepth, v.sampleRate)),
  );
  try {
    const found = await withTimeout(
      deps.searchQobuz(`${album.artist_name} ${album.title}`),
      deps.timeoutMs,
    );
    if (found === 'timeout') {
      result.sources.qobuz = 'timeout';
      return result;
    }
    const wantedTitle = compareForm(album.title);
    const wantedArtist = compareForm(album.artist_name);
    result.streaming = found
      .filter(
        (candidate) =>
          compareForm(candidate.title) === wantedTitle &&
          compareForm(candidate.artistName) === wantedArtist,
      )
      .map((candidate) => ({
        id: candidate.id,
        source: 'qobuz' as const,
        title: candidate.title,
        artistName: candidate.artistName,
        sampleRate: candidate.sampleRate ?? null,
        bitDepth: candidate.bitDepth ?? null,
        trackCount: candidate.trackCount ?? null,
        year: candidate.year ?? null,
        higherResolution:
          resolutionScore(candidate.bitDepth ?? null, candidate.sampleRate ?? null) > bestLocal,
      }))
      .sort(
        (a, b) =>
          resolutionScore(b.bitDepth, b.sampleRate) - resolutionScore(a.bitDepth, a.sampleRate),
      );
    result.sources.qobuz = 'ok';
  } catch (err) {
    logger.debug(`AlbumVersions: Qobuz search failed for ${albumId}: ${err}`);
    result.sources.qobuz = 'error';
  }
  return result;
}

import type {
  Album,
  Artist,
  MusicProvider,
  Playlist,
  ProviderType,
  SearchResults,
  SearchSourceStatus,
  SourceRef,
  Track,
} from '@audioserver/shared';
import { LocalProvider } from './local.js';
import { TidalProvider } from './tidal.js';
import { SpotifyProvider } from './spotify.js';
import { QobuzProvider } from './qobuz.js';
import { logger } from '../logger.js';

export const SOURCE_PRIORITY: readonly ProviderType[] = [
  'local',
  'qobuz',
  'tidal',
  'spotify',
  'radio',
];

function sourceRank(source: ProviderType): number {
  const rank = SOURCE_PRIORITY.indexOf(source);
  return rank === -1 ? SOURCE_PRIORITY.length : rank;
}

/**
 * Comparison key (V07.1). Unicode-safe: accents are stripped, quotes and
 * punctuation removed, letters and digits of every script kept. The old
 * version dropped everything outside a-z/0-9, so two different Japanese or
 * Cyrillic titles collapsed into one empty key and one of them vanished.
 */
export function normalizeSearchKey(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) =>
      (part ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/['’"“”]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim(),
    )
    .join('|');
}

/**
 * Words that mark an edition rather than a different song. A title suffix in
 * brackets or after a dash that contains one of these is a version label:
 * "One (Live)", "Song [2011 Remaster]", "Track - Radio Edit".
 */
const VERSION_WORDS =
  /\b(live|remaster(?:ed)?|acoustic|demo|instrumental|radio edit|single version|album version|edit|remix|mix|mono|stereo|unplugged|extended|karaoke|alternate|alternative|take \d+|version|orchestral|session|rehearsal|bonus track|deluxe|anniversary|expanded|explicit|clean)\b/i;

const SUFFIX_GROUP = /\s*(?:\(([^()]*)\)|\[([^\]]*)\])\s*$/;
const DASH_SUFFIX = /\s+[-–—]\s+([^-–—]+)$/;

/** Split "Title (Live at Wembley)" into { base: 'Title', version: 'Live at Wembley' }. */
export function splitTitleVersion(title: string): { base: string; version?: string } {
  let base = title.trim();
  const labels: string[] = [];
  for (let i = 0; i < 3; i++) {
    const group = SUFFIX_GROUP.exec(base);
    if (group) {
      const label = (group[1] ?? group[2] ?? '').trim();
      if (VERSION_WORDS.test(label)) {
        labels.unshift(label);
        base = base.slice(0, group.index).trim();
        continue;
      }
    }
    const dash = DASH_SUFFIX.exec(base);
    if (dash && VERSION_WORDS.test(dash[1])) {
      labels.unshift(dash[1].trim());
      base = base.slice(0, dash.index).trim();
      continue;
    }
    break;
  }
  return labels.length > 0 ? { base, version: labels.join(', ') } : { base };
}

/** Normalized edition label used in keys: 'Remastered 2011' → 'remaster 2011'. */
export function editionKey(version: string | null | undefined): string {
  if (!version) return '';
  return normalizeSearchKey(version)
    .replace(/\bremastered\b/g, 'remaster')
    .replace(/\balternative\b/g, 'alternate')
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** Two durations describe the same recording when they are within this many seconds. */
export const DURATION_TOLERANCE_SECONDS = 10;

function durationsCompatible(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined || a <= 0 || b <= 0) return true;
  return Math.abs(a - b) <= DURATION_TOLERANCE_SECONDS;
}

interface Dedupable {
  id: string;
  source: ProviderType;
  availableOn?: ProviderType[];
  alternatives?: SourceRef[];
  version?: string;
  duration?: number;
  albumId?: string;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
}

function toSourceRef(item: Dedupable): SourceRef {
  return {
    source: item.source,
    id: item.id,
    albumId: item.albumId,
    version: item.version,
    duration: item.duration,
    format: item.format,
    sampleRate: item.sampleRate,
    bitDepth: item.bitDepth,
  };
}

/**
 * Merge the same item from several sources into one result that remembers
 * every source's own id (`alternatives`) and keeps `availableOn` for older
 * clients. Grouping is by `keyFn`; within a group, items only merge when
 * their edition labels match and their durations are compatible, so a live
 * take, a remaster or a radio edit stays a separate result (V07.1).
 */
export function deduplicateProviderItems<T extends Dedupable>(
  items: T[],
  keyFn: (item: T) => string,
  options: { editions?: boolean } = {},
): T[] {
  interface Group {
    best: T;
    edition: string;
    duration: number | undefined;
    sources: Set<ProviderType>;
    refs: Map<ProviderType, SourceRef>;
    order: number;
  }
  const groups = new Map<string, Group[]>();
  let order = 0;

  for (const item of items) {
    const key = keyFn(item);
    const edition = options.editions ? editionKey(item.version) : '';
    const bucket = groups.get(key) ?? [];
    if (!groups.has(key)) groups.set(key, bucket);

    let group = bucket.find(
      (g) =>
        !options.editions ||
        (g.edition === edition && durationsCompatible(g.duration, item.duration)),
    );
    if (!group) {
      group = {
        best: item,
        edition,
        duration: item.duration,
        sources: new Set(),
        refs: new Map(),
        order: order++,
      };
      bucket.push(group);
    }

    for (const source of [item.source, ...(item.availableOn ?? [])]) group.sources.add(source);
    for (const ref of [toSourceRef(item), ...(item.alternatives ?? [])]) {
      if (!group.refs.has(ref.source)) group.refs.set(ref.source, ref);
    }
    if (sourceRank(item.source) < sourceRank(group.best.source)) {
      group.best = item;
      group.duration = item.duration ?? group.duration;
    }
  }

  return Array.from(groups.values())
    .flat()
    .sort((a, b) => a.order - b.order)
    .map(({ best, sources, refs }) => ({
      ...best,
      availableOn: Array.from(sources).sort((a, b) => sourceRank(a) - sourceRank(b)),
      alternatives: Array.from(refs.values()).sort(
        (a, b) => sourceRank(a.source) - sourceRank(b.source),
      ),
    }));
}

/** Fill `version` from the title when the source did not provide one. */
function withParsedVersion<T extends { title: string; version?: string }>(item: T): T {
  if (item.version) return item;
  const { version } = splitTitleVersion(item.title);
  return version ? { ...item, version } : item;
}

function baseTitle(item: { title: string; version?: string }): string {
  return splitTitleVersion(item.title).base;
}

export function deduplicateSearchResults(results: SearchResults): SearchResults {
  const tracks = results.tracks.map(withParsedVersion);
  const albums = results.albums.map(withParsedVersion);
  return {
    ...results,
    artists: deduplicateProviderItems(results.artists, (artist: Artist) =>
      normalizeSearchKey(artist.name),
    ),
    albums: deduplicateProviderItems(
      albums,
      (album: Album) => normalizeSearchKey(album.artistName, baseTitle(album)),
      { editions: true },
    ),
    tracks: deduplicateProviderItems(
      tracks,
      (track: Track) => normalizeSearchKey(track.artistName, baseTitle(track)),
      { editions: true },
    ),
    playlists: deduplicateProviderItems(results.playlists, (playlist: Playlist) =>
      normalizeSearchKey(playlist.source, playlist.name),
    ),
  };
}

export interface SearchAllOptions {
  /** Only ask these sources; default every active provider. */
  sources?: ProviderType[];
  /** Per-provider time budget; a slow source becomes 'timeout' and the rest is returned. */
  timeoutMs?: number;
}

export const DEFAULT_SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_PROVIDER_TIMEOUT_MS) || 6000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
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

class ProviderRegistry {
  readonly local = new LocalProvider();
  readonly tidal = new TidalProvider();
  readonly spotify = new SpotifyProvider();
  readonly qobuz = new QobuzProvider();

  getAllProviders(): MusicProvider[] {
    return [this.local, this.qobuz, this.tidal, this.spotify];
  }

  getActiveProviders(): MusicProvider[] {
    return this.getAllProviders().filter((p) => p.isAvailable);
  }

  async initialize(): Promise<void> {
    for (const provider of this.getAllProviders()) {
      try {
        await provider.initialize();
        logger.info(`Provider ${provider.name}: initialized (available: ${provider.isAvailable})`);
      } catch (err) {
        logger.warn(`Provider ${provider.name}: init failed: ${err}`);
      }
    }
  }

  /**
   * Unified search (V07.4): every selected provider gets the same time
   * budget; a slow or broken one is reported in `sources` and never hides
   * the results of the others. Results are deduplicated edition-aware.
   */
  async searchAll(
    query: string,
    limit = 20,
    options: SearchAllOptions = {},
  ): Promise<SearchResults> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    const wanted = options.sources ? new Set(options.sources) : null;
    const selected = this.getAllProviders().filter((p) => !wanted || wanted.has(p.type));
    const statuses: SearchSourceStatus[] = [];
    const merged: SearchResults = { artists: [], albums: [], tracks: [], playlists: [] };

    const outcomes = await Promise.all(
      selected.map(async (p): Promise<void> => {
        if (!p.isAvailable) {
          statuses.push({ source: p.type, status: 'unavailable', ms: 0 });
          return;
        }
        const started = Date.now();
        try {
          const value = await withTimeout(p.search(query, limit), timeoutMs);
          merged.artists.push(...value.artists);
          merged.albums.push(...value.albums);
          merged.tracks.push(...value.tracks);
          merged.playlists.push(...value.playlists);
          statuses.push({
            source: p.type,
            status: 'ok',
            ms: Date.now() - started,
            counts: {
              artists: value.artists.length,
              albums: value.albums.length,
              tracks: value.tracks.length,
              playlists: value.playlists.length,
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const timedOut = message.startsWith('timeout after');
          statuses.push({
            source: p.type,
            status: timedOut ? 'timeout' : 'error',
            ms: Date.now() - started,
            error: message,
          });
          logger.warn(`Search: ${p.name} ${timedOut ? 'timed out' : 'failed'}: ${message}`);
        }
      }),
    );
    void outcomes;

    const deduplicated = deduplicateSearchResults(merged);
    deduplicated.sources = statuses.sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
    return deduplicated;
  }
}

export const providers = new ProviderRegistry();

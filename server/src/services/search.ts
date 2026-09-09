import type { Playability, ProviderType, SearchResults, Track } from '@audioserver/shared';
import { providers, SOURCE_PRIORITY } from '../providers/registry.js';
import { getCapabilities, type PlaybackSource } from './playback-resolver.js';

/**
 * Unified search (V07.2): the registry merges and deduplicates, this layer
 * says what the user can do with each result and applies the filters.
 * Playability comes from the same resolver that drives playback, so search
 * never promises what the player cannot deliver.
 */

export interface UnifiedSearchOptions {
  sources?: ProviderType[];
  quality?: 'lossless' | 'hires';
  format?: string;
  limit?: number;
  timeoutMs?: number;
}

const LOSSLESS_FORMATS = new Set(['flac', 'wav', 'aiff', 'aif', 'alac', 'ape']);
/** Streaming sources that deliver lossless audio when they can play at all. */
const LOSSLESS_SOURCES = new Set<ProviderType>(['qobuz', 'tidal']);

export function parseSearchOptions(query: Record<string, unknown>): UnifiedSearchOptions {
  const options: UnifiedSearchOptions = {};
  const sources = typeof query.sources === 'string' ? query.sources : undefined;
  if (sources) {
    const wanted = sources
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is ProviderType => (SOURCE_PRIORITY as readonly string[]).includes(s));
    if (wanted.length > 0) options.sources = wanted;
  }
  if (query.quality === 'lossless' || query.quality === 'hires') options.quality = query.quality;
  if (typeof query.format === 'string' && /^[a-z0-9]{1,8}$/i.test(query.format)) {
    options.format = query.format.toLowerCase();
  }
  const limit = parseInt(String(query.limit ?? ''), 10);
  if (Number.isFinite(limit) && limit > 0) options.limit = Math.min(limit, 50);
  const timeout = parseInt(String(query.timeoutMs ?? ''), 10);
  if (Number.isFinite(timeout) && timeout >= 500) options.timeoutMs = Math.min(timeout, 30_000);
  return options;
}

function toPlaybackSource(source: ProviderType): PlaybackSource {
  return source as PlaybackSource;
}

/** What can be done with a track from `source` right now. */
export function playabilityFor(track: Pick<Track, 'source' | 'availability'>): Playability {
  if (track.source === 'local' && track.availability === 'missing') {
    return {
      playable: false,
      browser: false,
      server: false,
      external: false,
      reason: 'missing-file',
    };
  }
  const caps = getCapabilities(toPlaybackSource(track.source));
  const external = caps.externalPlayer !== null;
  const playable = caps.browser || caps.serverDispatch || external;
  return {
    playable,
    browser: caps.browser,
    server: caps.serverDispatch,
    external,
    ...(playable ? {} : { reason: caps.reason ?? 'no-full-playback' }),
  };
}

function isLossless(track: Track): boolean {
  if (track.source === 'local') return LOSSLESS_FORMATS.has((track.format ?? '').toLowerCase());
  return LOSSLESS_SOURCES.has(track.source);
}

function isHires(track: Track): boolean {
  if (!isLossless(track)) return false;
  return (track.bitDepth ?? 0) > 16 || (track.sampleRate ?? 0) > 48_000;
}

function passesFilters(track: Track, options: UnifiedSearchOptions): boolean {
  if (options.format) {
    if (track.source !== 'local') return false;
    if ((track.format ?? '').toLowerCase() !== options.format) return false;
  }
  if (options.quality === 'lossless' && !isLossless(track)) return false;
  if (options.quality === 'hires' && !isHires(track)) return false;
  return true;
}

export async function unifiedSearch(
  query: string,
  options: UnifiedSearchOptions = {},
): Promise<SearchResults> {
  const results = await providers.searchAll(query, options.limit ?? 20, {
    sources: options.sources,
    timeoutMs: options.timeoutMs,
  });
  const tracks = results.tracks
    .filter((track) => passesFilters(track, options))
    .map((track) => ({ ...track, playability: playabilityFor(track) }));
  return { ...results, tracks };
}

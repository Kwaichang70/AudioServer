import type {
  Album,
  Artist,
  MusicProvider,
  Playlist,
  ProviderType,
  SearchResults,
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

export function normalizeSearchKey(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) =>
      (part ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/['’"“”]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .toLowerCase(),
    )
    .join('|');
}

export function deduplicateProviderItems<
  T extends { source: ProviderType; availableOn?: ProviderType[] },
>(items: T[], keyFn: (item: T) => string): T[] {
  const groups = new Map<string, { best: T; sources: Set<ProviderType> }>();

  for (const item of items) {
    const key = keyFn(item);
    const itemSources = new Set<ProviderType>([item.source, ...(item.availableOn ?? [])]);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, { best: item, sources: itemSources });
      continue;
    }

    for (const source of itemSources) existing.sources.add(source);
    if (sourceRank(item.source) < sourceRank(existing.best.source)) {
      existing.best = item;
    }
  }

  return Array.from(groups.values()).map(({ best, sources }) => ({
    ...best,
    availableOn: Array.from(sources).sort((a, b) => sourceRank(a) - sourceRank(b)),
  }));
}

export function deduplicateSearchResults(results: SearchResults): SearchResults {
  return {
    artists: deduplicateProviderItems(results.artists, (artist: Artist) =>
      normalizeSearchKey(artist.name),
    ),
    albums: deduplicateProviderItems(results.albums, (album: Album) =>
      normalizeSearchKey(album.artistName, album.title),
    ),
    tracks: deduplicateProviderItems(results.tracks, (track: Track) =>
      normalizeSearchKey(track.artistName, track.title),
    ),
    playlists: deduplicateProviderItems(results.playlists, (playlist: Playlist) =>
      normalizeSearchKey(playlist.source, playlist.name),
    ),
  };
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

  async searchAll(query: string, limit = 20): Promise<SearchResults> {
    const results = await Promise.allSettled(
      this.getActiveProviders().map((p) => p.search(query, limit)),
    );

    const merged: SearchResults = {
      artists: [],
      albums: [],
      tracks: [],
      playlists: [],
    };

    for (const result of results) {
      if (result.status === 'fulfilled') {
        merged.artists.push(...result.value.artists);
        merged.albums.push(...result.value.albums);
        merged.tracks.push(...result.value.tracks);
        merged.playlists.push(...result.value.playlists);
      }
    }

    return deduplicateSearchResults(merged);
  }
}

export const providers = new ProviderRegistry();

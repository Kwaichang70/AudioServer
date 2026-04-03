import type { MusicProvider } from '@audioserver/shared';
import { LocalProvider } from './local.js';
import { TidalProvider } from './tidal.js';
import { SpotifyProvider } from './spotify.js';
import { QobuzProvider } from './qobuz.js';
import { logger } from '../logger.js';

class ProviderRegistry {
  readonly local = new LocalProvider();
  readonly tidal = new TidalProvider();
  readonly spotify = new SpotifyProvider();
  readonly qobuz = new QobuzProvider();

  getAllProviders(): MusicProvider[] {
    return [this.local, this.tidal, this.spotify, this.qobuz];
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

  async searchAll(query: string, limit = 20) {
    const results = await Promise.allSettled(
      this.getActiveProviders().map((p) => p.search(query, limit))
    );

    const merged = { artists: [] as any[], albums: [] as any[], tracks: [] as any[], playlists: [] as any[] };

    for (const result of results) {
      if (result.status === 'fulfilled') {
        merged.artists.push(...result.value.artists);
        merged.albums.push(...result.value.albums);
        merged.tracks.push(...result.value.tracks);
        merged.playlists.push(...result.value.playlists);
      }
    }

    // Deduplicate: prefer local > qobuz > tidal > spotify
    merged.artists = this.dedup(merged.artists, (a) => a.name.toLowerCase());
    merged.albums = this.dedup(merged.albums, (a) => `${a.artistName}-${a.title}`.toLowerCase());
    merged.tracks = this.dedup(merged.tracks, (t) => `${t.artistName}-${t.title}`.toLowerCase());

    return merged;
  }

  /** Remove duplicates, keeping the first occurrence (local comes first) */
  private dedup<T extends { source?: string }>(items: T[], keyFn: (item: T) => string): T[] {
    const seen = new Map<string, T>();
    const sourceOrder: Record<string, number> = { local: 0, qobuz: 1, tidal: 2, spotify: 3 };

    for (const item of items) {
      const key = keyFn(item);
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, item);
      } else {
        // Keep the one with higher priority (lower number)
        const existingPriority = sourceOrder[existing.source || 'spotify'] ?? 9;
        const newPriority = sourceOrder[item.source || 'spotify'] ?? 9;
        if (newPriority < existingPriority) {
          seen.set(key, item);
        }
      }
    }

    return Array.from(seen.values());
  }
}

export const providers = new ProviderRegistry();

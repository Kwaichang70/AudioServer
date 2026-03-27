import type { MusicProvider } from '@audioserver/shared';
import { LocalProvider } from './local.js';
import { TidalProvider } from './tidal.js';
import { SpotifyProvider } from './spotify.js';
import { logger } from '../logger.js';

class ProviderRegistry {
  readonly local = new LocalProvider();
  readonly tidal = new TidalProvider();
  readonly spotify = new SpotifyProvider();

  getAllProviders(): MusicProvider[] {
    return [this.local, this.tidal, this.spotify];
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

    return merged;
  }
}

export const providers = new ProviderRegistry();

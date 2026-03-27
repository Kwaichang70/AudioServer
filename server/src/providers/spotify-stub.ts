import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';

/**
 * Spotify provider stub.
 *
 * Architecture notes for future implementation:
 * - Spotify Web API for metadata/search (OAuth2 Authorization Code flow)
 * - Playback limitation: Spotify Web API only controls Spotify Connect devices
 * - For server-side playback, consider:
 *   - Librespot (Rust-based Spotify Connect client) as a subprocess
 *   - Spotify Web Playback SDK (browser-only, requires Premium)
 * - Audio streaming is DRM-protected; direct stream URLs not available via API
 * - Best approach: run librespot as a Spotify Connect receiver,
 *   use Web API for browse/search, and control playback via Connect API
 */
export class SpotifyStubProvider implements AuthenticatedMusicProvider {
  readonly type = 'spotify' as const;
  readonly name = 'Spotify';
  isAvailable = false;

  auth: ProviderAuth = {
    isAuthenticated: false,
    async login() { throw new Error('Spotify integration not yet implemented'); },
    async logout() {},
    async refreshToken() {},
  };

  async initialize() { /* TODO: Check for stored tokens */ }
  async dispose() {}

  async getArtists() { return { items: [] as Artist[], total: 0 }; }
  async getArtist() { return null; }
  async getAlbums() { return { items: [] as Album[], total: 0 }; }
  async getAlbum() { return null; }
  async getAlbumTracks(): Promise<Track[]> { return []; }
  async getArtistAlbums(): Promise<Album[]> { return []; }
  async search(): Promise<SearchResults> { return { artists: [], albums: [], tracks: [], playlists: [] }; }
  async getStreamUrl(): Promise<string | null> { return null; }
  async getPlaylists(): Promise<Playlist[]> { return []; }
  async getPlaylistTracks(): Promise<Track[]> { return []; }
}

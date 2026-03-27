import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';

/**
 * Tidal provider stub.
 *
 * Architecture notes for future implementation:
 * - Use TIDAL API v2 with OAuth2 PKCE flow (clientId + clientSecret)
 * - Auth: POST https://auth.tidal.com/v1/oauth2/token
 * - Catalog: GET https://openapi.tidal.com/v2/...
 * - Streaming: requires TIDAL Player SDK or direct stream URL retrieval
 * - HiRes/MQA support via stream quality parameter
 */
export class TidalStubProvider implements AuthenticatedMusicProvider {
  readonly type = 'tidal' as const;
  readonly name = 'Tidal';
  isAvailable = false;

  auth: ProviderAuth = {
    isAuthenticated: false,
    async login() { throw new Error('Tidal integration not yet implemented'); },
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

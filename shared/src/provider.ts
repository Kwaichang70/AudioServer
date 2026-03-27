import type { Artist, Album, Track, Playlist, SearchResults, ProviderType } from './types.js';

// ─── Music Provider Interface ────────────────────────────────────
// Every music source (local library, Tidal, Spotify, Qobuz) implements this.

export interface MusicProvider {
  readonly type: ProviderType;
  readonly name: string;
  readonly isAvailable: boolean;

  // Lifecycle
  initialize(): Promise<void>;
  dispose(): Promise<void>;

  // Browse
  getArtists(page?: number, pageSize?: number): Promise<{ items: Artist[]; total: number }>;
  getArtist(id: string): Promise<Artist | null>;
  getAlbums(page?: number, pageSize?: number): Promise<{ items: Album[]; total: number }>;
  getAlbum(id: string): Promise<Album | null>;
  getAlbumTracks(albumId: string): Promise<Track[]>;
  getArtistAlbums(artistId: string): Promise<Album[]>;

  // Search
  search(query: string, limit?: number): Promise<SearchResults>;

  // Playback
  getStreamUrl(trackId: string): Promise<string | null>;

  // Playlists (optional for some providers)
  getPlaylists?(): Promise<Playlist[]>;
  getPlaylistTracks?(playlistId: string): Promise<Track[]>;
}

// ─── Provider Auth (for streaming services) ──────────────────────

export interface ProviderAuth {
  isAuthenticated: boolean;
  login(credentials: Record<string, string>): Promise<void>;
  logout(): Promise<void>;
  refreshToken?(): Promise<void>;
}

export interface AuthenticatedMusicProvider extends MusicProvider {
  auth: ProviderAuth;
}

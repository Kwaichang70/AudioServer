import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';
import { logger } from '../logger.js';
import { saveTokens, loadTokens, deleteTokens } from '../services/tokenstore.js';

const TIDAL_AUTH_URL = 'https://auth.tidal.com/v1/oauth2';
const TIDAL_API_URL = 'https://openapi.tidal.com/v2';

interface TidalTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Tidal provider with OAuth2 Authorization Code + PKCE flow.
 *
 * Setup:
 * 1. Register at https://developer.tidal.com
 * 2. Set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET in .env
 * 3. Call POST /api/providers/tidal/auth/init to get the login URL
 * 4. After user authorizes, Tidal redirects to callback URL with ?code=...
 * 5. Call POST /api/providers/tidal/auth/callback with the code
 *
 * Once authenticated, all browse/search/play methods work against the Tidal API.
 */
export class TidalProvider implements AuthenticatedMusicProvider {
  readonly type = 'tidal' as const;
  readonly name = 'Tidal';
  isAvailable = false;

  private tokens: TidalTokens | null = null;
  private clientId: string;
  private clientSecret: string;

  auth: ProviderAuth = {
    isAuthenticated: false,
    login: async (credentials) => {
      // Called with { code, redirectUri } after OAuth callback
      await this.exchangeCode(credentials.code, credentials.redirectUri);
    },
    logout: async () => {
      this.tokens = null;
      this.auth.isAuthenticated = false;
      deleteTokens('tidal');
    },
    refreshToken: async () => {
      await this.refreshAccessToken();
    },
  };

  constructor() {
    this.clientId = process.env.TIDAL_CLIENT_ID || '';
    this.clientSecret = process.env.TIDAL_CLIENT_SECRET || '';
    this.isAvailable = !!(this.clientId && this.clientSecret);
  }

  async initialize(): Promise<void> {
    if (!this.clientId || !this.clientSecret) {
      logger.info('Tidal: No client credentials configured, skipping');
      return;
    }
    try {
      const stored = loadTokens('tidal');
      if (stored) {
        this.tokens = stored;
        this.auth.isAuthenticated = true;
        logger.info('Tidal: Restored tokens from database');
        if (Date.now() >= stored.expiresAt - 60_000) {
          await this.refreshAccessToken();
          logger.info('Tidal: Refreshed expired token');
        }
      } else {
        logger.info('Tidal: Provider initialized (awaiting authentication)');
      }
    } catch (err) {
      logger.warn(`Tidal: Failed to restore tokens: ${err}`);
    }
  }

  async dispose(): Promise<void> {
    this.tokens = null;
  }

  // ─── OAuth Flow ──────────────────────────────────────────────

  getAuthUrl(redirectUri: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: 'playlists.read playlists.write collection.read collection.write',
    });
    return `${TIDAL_AUTH_URL}/authorize?${params}`;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const res = await fetch(`${TIDAL_AUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`Tidal auth failed: ${error}`);
    }

    const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.auth.isAuthenticated = true;
    saveTokens('tidal', this.tokens);
    logger.info('Tidal: Authenticated successfully');
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) throw new Error('No refresh token');

    const res = await fetch(`${TIDAL_AUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
      }),
    });

    if (!res.ok) throw new Error('Tidal token refresh failed');

    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
    this.tokens.accessToken = data.access_token;
    if (data.refresh_token) this.tokens.refreshToken = data.refresh_token;
    this.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    saveTokens('tidal', this.tokens);
  }

  private async apiRequest(path: string): Promise<any> {
    if (!this.tokens) throw new Error('Not authenticated');

    // Auto-refresh if expired
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }

    const res = await fetch(`${TIDAL_API_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${this.tokens.accessToken}`,
        'Content-Type': 'application/vnd.tidal.v1+json',
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Tidal API error: ${res.status} ${err}`);
    }
    return res.json();
  }

  // ─── MusicProvider Implementation ────────────────────────────

  async getArtists(_page?: number, _pageSize?: number) {
    // Tidal doesn't have a "list all artists" — return from user's collection
    if (!this.auth.isAuthenticated) return { items: [] as Artist[], total: 0 };
    // TODO: GET /v2/my/artists
    return { items: [] as Artist[], total: 0 };
  }

  async getArtist(id: string): Promise<Artist | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const data = await this.apiRequest(`/artists/${id}`);
      return this.mapArtist(data);
    } catch {
      return null;
    }
  }

  async getAlbums(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Album[], total: 0 };
    return { items: [] as Album[], total: 0 };
  }

  async getAlbum(id: string): Promise<Album | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const data = await this.apiRequest(`/albums/${id}`);
      return this.mapAlbum(data);
    } catch {
      return null;
    }
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.apiRequest(`/albums/${albumId}/items?limit=100`);
      return (data.data || []).map((item: any) => this.mapTrack(item.resource));
    } catch {
      return [];
    }
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.apiRequest(`/artists/${artistId}/albums?limit=50`);
      return (data.data || []).map((item: any) => this.mapAlbum(item.resource));
    } catch {
      return [];
    }
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    if (!this.auth.isAuthenticated) return { artists: [], albums: [], tracks: [], playlists: [] };
    try {
      const data = await this.apiRequest(`/searchresults/${encodeURIComponent(query)}?limit=${limit}&include=artists,albums,tracks`);
      return {
        artists: (data.artists || []).map((a: any) => this.mapArtist(a.resource)),
        albums: (data.albums || []).map((a: any) => this.mapAlbum(a.resource)),
        tracks: (data.tracks || []).map((t: any) => this.mapTrack(t.resource)),
        playlists: [],
      };
    } catch {
      return { artists: [], albums: [], tracks: [], playlists: [] };
    }
  }

  async getStreamUrl(trackId: string): Promise<string | null> {
    if (!this.auth.isAuthenticated) return null;
    // Tidal streaming requires their Player SDK — URL retrieval is limited
    // For now, return null. Real implementation needs Tidal's playbackinfo endpoint.
    logger.debug(`Tidal: Stream URL requested for ${trackId} (not yet implemented)`);
    return null;
  }

  async getPlaylists(): Promise<Playlist[]> {
    if (!this.auth.isAuthenticated) return [];
    return [];
  }

  async getPlaylistTracks(_playlistId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    return [];
  }

  // ─── Mappers ─────────────────────────────────────────────────

  private mapArtist(data: any): Artist {
    return {
      id: `tidal:${data.id}`,
      name: data.name,
      imageUrl: data.picture?.[0]?.url,
      source: 'tidal',
    };
  }

  private mapAlbum(data: any): Album {
    return {
      id: `tidal:${data.id}`,
      title: data.title,
      artistId: `tidal:${data.artists?.[0]?.id || ''}`,
      artistName: data.artists?.[0]?.name || 'Unknown',
      year: data.releaseDate ? new Date(data.releaseDate).getFullYear() : undefined,
      coverUrl: data.imageCover?.[0]?.url,
      trackCount: data.numberOfTracks,
      source: 'tidal',
    };
  }

  private mapTrack(data: any): Track {
    return {
      id: `tidal:${data.id}`,
      title: data.title,
      albumId: `tidal:${data.album?.id || ''}`,
      albumTitle: data.album?.title || '',
      artistId: `tidal:${data.artists?.[0]?.id || ''}`,
      artistName: data.artists?.[0]?.name || 'Unknown',
      trackNumber: data.trackNumber,
      duration: data.duration,
      source: 'tidal',
    };
  }
}

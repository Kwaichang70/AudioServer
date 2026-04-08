import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';
import { randomBytes, createHash } from 'crypto';
import { logger } from '../logger.js';
import { saveTokens, loadTokens, deleteTokens } from '../services/tokenstore.js';

const TIDAL_AUTH_URL = 'https://auth.tidal.com/v1/oauth2';
const TIDAL_API_URL = 'https://openapi.tidal.com/v2';
const TIDAL_LEGACY_API = 'https://api.tidal.com/v1';

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

  // PKCE state
  private codeVerifier: string | null = null;

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
    // Generate PKCE code verifier and challenge
    this.codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(this.codeVerifier).digest('base64url');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://login.tidal.com/authorize?${params}`;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
    };
    // Include PKCE code verifier if available
    if (this.codeVerifier) {
      body.code_verifier = this.codeVerifier;
      this.codeVerifier = null; // Single use
    }

    const res = await fetch(`${TIDAL_AUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(body),
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

    const url = `${TIDAL_API_URL}${path}`;
    logger.debug(`Tidal API request: ${url}`);
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.tokens.accessToken}`,
        'Content-Type': 'application/vnd.tidal.v1+json',
      },
    });

    if (!res.ok) {
      const err = await res.text();
      logger.error(`Tidal API ${res.status}: ${url} → ${err.slice(0, 300)}`);
      throw new Error(`Tidal API error: ${res.status} ${err.slice(0, 100)}`);
    }
    return res.json();
  }

  private async legacyApiRequest(path: string): Promise<any> {
    if (!this.tokens) throw new Error('Not authenticated');

    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }

    const separator = path.includes('?') ? '&' : '?';
    const res = await fetch(`${TIDAL_LEGACY_API}${path}${separator}countryCode=US`, {
      headers: {
        Authorization: `Bearer ${this.tokens.accessToken}`,
      },
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Tidal legacy API error: ${res.status} ${err}`);
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

  async search(query: string, limit = 10): Promise<SearchResults> {
    if (!this.auth.isAuthenticated) return { artists: [], albums: [], tracks: [], playlists: [] };
    try {
      // JSON:API format: fetch relationships separately
      const q = encodeURIComponent(query);
      const [artistsRes, albumsRes, tracksRes] = await Promise.allSettled([
        this.apiRequest(`/searchResults/${q}/relationships/artists?include=artists&page[limit]=${limit}`),
        this.apiRequest(`/searchResults/${q}/relationships/albums?include=albums&page[limit]=${limit}`),
        this.apiRequest(`/searchResults/${q}/relationships/tracks?include=tracks&page[limit]=${limit}`),
      ]);

      const artists = artistsRes.status === 'fulfilled'
        ? (artistsRes.value.included || []).filter((i: any) => i.type === 'artists').map((a: any) => this.mapArtist(a))
        : [];
      const albums = albumsRes.status === 'fulfilled'
        ? (albumsRes.value.included || []).filter((i: any) => i.type === 'albums').map((a: any) => this.mapAlbum(a))
        : [];
      const tracks = tracksRes.status === 'fulfilled'
        ? (tracksRes.value.included || []).filter((i: any) => i.type === 'tracks').map((t: any) => this.mapTrack(t))
        : [];

      return { artists, albums, tracks, playlists: [] };
    } catch (err) {
      logger.error(`Tidal search failed: ${err instanceof Error ? err.stack : err}`);
      return { artists: [], albums: [], tracks: [], playlists: [] };
    }
  }

  async getStreamUrl(trackId: string): Promise<string | null> {
    if (!this.auth.isAuthenticated) return null;
    const rawId = trackId.replace('tidal:', '');
    try {
      // Try legacy API playbackinfopostpaywall endpoint
      const data = await this.legacyApiRequest(
        `/tracks/${rawId}/playbackinfopostpaywall?audioquality=LOSSLESS&playbackmode=STREAM&assetpresentation=FULL`
      );
      if (data.manifest) {
        // Manifest is base64-encoded JSON containing URLs
        const manifest = JSON.parse(Buffer.from(data.manifest, 'base64').toString('utf-8'));
        if (manifest.urls && manifest.urls.length > 0) {
          logger.info(`Tidal: Got stream URL for track ${rawId} (${data.audioQuality})`);
          return manifest.urls[0];
        }
      }
      // Fallback: direct manifestMimeType check
      if (data.manifestMimeType === 'application/vnd.tidal.bts' && data.manifest) {
        logger.info(`Tidal: Got BTS manifest for track ${rawId}`);
        return data.manifest; // BTS manifest URL
      }
      logger.warn(`Tidal: No stream URL in playbackinfo response for ${rawId}`);
      return null;
    } catch (err) {
      // Fallback: try the v2 API track URL endpoint
      try {
        const data = await this.legacyApiRequest(`/tracks/${rawId}/urlpostpaywall?urlusagemode=STREAM&audioquality=LOSSLESS&assetpresentation=FULL`);
        if (data.urls && data.urls.length > 0) {
          logger.info(`Tidal: Got stream URL via urlpostpaywall for track ${rawId}`);
          return data.urls[0];
        }
      } catch (err2) {
        logger.debug(`Tidal: urlpostpaywall also failed for ${rawId}: ${err2}`);
      }
      logger.warn(`Tidal: Stream URL retrieval failed for ${rawId}: ${err}`);
      return null;
    }
  }

  async getPlaylists(): Promise<Playlist[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.legacyApiRequest('/users/me/playlists?limit=50');
      return (data.items || []).map((p: any) => ({
        id: `tidal:${p.uuid}`,
        name: p.title,
        description: p.description || '',
        trackCount: p.numberOfTracks,
        coverUrl: p.squareImage ? `https://resources.tidal.com/images/${p.squareImage.replace(/-/g, '/')}/320x320.jpg` : undefined,
        source: 'tidal',
      }));
    } catch (err) {
      logger.warn(`Tidal: Failed to get playlists: ${err}`);
      return [];
    }
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    const rawId = playlistId.replace('tidal:', '');
    try {
      const data = await this.legacyApiRequest(`/playlists/${rawId}/items?limit=100`);
      return (data.items || [])
        .filter((item: any) => item.type === 'track' && item.item)
        .map((item: any) => this.mapLegacyTrack(item.item));
    } catch (err) {
      logger.warn(`Tidal: Failed to get playlist tracks: ${err}`);
      return [];
    }
  }

  async getFavoriteAlbums(): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.legacyApiRequest('/users/me/favorites/albums?limit=50&order=DATE&orderDirection=DESC');
      return (data.items || []).map((item: any) => this.mapLegacyAlbum(item.item));
    } catch (err) {
      logger.warn(`Tidal: Failed to get favorite albums: ${err}`);
      return [];
    }
  }

  async getFavoriteTracks(): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.legacyApiRequest('/users/me/favorites/tracks?limit=100&order=DATE&orderDirection=DESC');
      return (data.items || []).map((item: any) => this.mapLegacyTrack(item.item));
    } catch (err) {
      logger.warn(`Tidal: Failed to get favorite tracks: ${err}`);
      return [];
    }
  }

  async getFavoriteArtists(): Promise<Artist[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.legacyApiRequest('/users/me/favorites/artists?limit=50&order=DATE&orderDirection=DESC');
      return (data.items || []).map((item: any) => ({
        id: `tidal:${item.item.id}`,
        name: item.item.name,
        imageUrl: item.item.picture ? `https://resources.tidal.com/images/${item.item.picture.replace(/-/g, '/')}/320x320.jpg` : undefined,
        source: 'tidal' as const,
      }));
    } catch (err) {
      logger.warn(`Tidal: Failed to get favorite artists: ${err}`);
      return [];
    }
  }

  // ─── Mappers ─────────────────────────────────────────────────

  // JSON:API format: { id, type, attributes: { title, ... }, relationships: { ... } }
  private mapArtist(data: any): Artist {
    const attrs = data.attributes || data;
    return {
      id: `tidal:${data.id}`,
      name: attrs.name,
      imageUrl: attrs.imageLinks?.[0]?.href || attrs.picture?.[0]?.url,
      source: 'tidal',
    };
  }

  private mapAlbum(data: any): Album {
    const attrs = data.attributes || data;
    return {
      id: `tidal:${data.id}`,
      title: attrs.title,
      artistId: '',
      artistName: attrs.artistName || attrs.artists?.[0]?.name || 'Unknown',
      year: attrs.releaseDate ? new Date(attrs.releaseDate).getFullYear() : undefined,
      coverUrl: attrs.imageLinks?.[0]?.href || attrs.imageCover?.[0]?.url,
      trackCount: attrs.numberOfItems || attrs.numberOfTracks,
      source: 'tidal',
    };
  }

  private mapTrack(data: any): Track {
    const attrs = data.attributes || data;
    return {
      id: `tidal:${data.id}`,
      title: attrs.title,
      albumId: '',
      albumTitle: attrs.albumName || attrs.album?.title || '',
      artistId: '',
      artistName: attrs.artistName || attrs.artists?.[0]?.name || 'Unknown',
      trackNumber: attrs.trackNumber,
      duration: attrs.duration ? attrs.duration / 1000 : undefined, // API returns ms
      source: 'tidal',
    };
  }

  // Legacy API mappers (api.tidal.com/v1 has different field names)
  private mapLegacyTrack(data: any): Track {
    return {
      id: `tidal:${data.id}`,
      title: data.title,
      albumId: `tidal:${data.album?.id || ''}`,
      albumTitle: data.album?.title || '',
      artistId: `tidal:${data.artist?.id ? `tidal:${data.artist.id}` : ''}`,
      artistName: data.artist?.name || data.artists?.[0]?.name || 'Unknown',
      trackNumber: data.trackNumber,
      duration: data.duration,
      source: 'tidal',
    };
  }

  private mapLegacyAlbum(data: any): Album {
    return {
      id: `tidal:${data.id}`,
      title: data.title,
      artistId: data.artist?.id ? `tidal:${data.artist.id}` : '',
      artistName: data.artist?.name || data.artists?.[0]?.name || 'Unknown',
      year: data.releaseDate ? new Date(data.releaseDate).getFullYear() : undefined,
      coverUrl: data.cover ? `https://resources.tidal.com/images/${data.cover.replace(/-/g, '/')}/640x640.jpg` : undefined,
      trackCount: data.numberOfTracks,
      source: 'tidal',
    };
  }
}

import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';
import { logger } from '../logger.js';
import { saveTokens, loadTokens, deleteTokens } from '../services/tokenstore.js';

const QOBUZ_AUTH_URL = 'https://auth.qobuz.com/oauth';
const QOBUZ_API_URL = 'https://api.qobuz.com/v1';

interface QobuzTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class QobuzProvider implements AuthenticatedMusicProvider {
  readonly type = 'qobuz' as const;
  readonly name = 'Qobuz';
  isAvailable = false;

  private tokens: QobuzTokens | null = null;
  private clientId: string;
  private clientSecret: string;

  auth: ProviderAuth = {
    isAuthenticated: false,
    login: async (credentials) => {
      await this.exchangeCode(credentials.code, credentials.redirectUri);
    },
    logout: async () => {
      this.tokens = null;
      this.auth.isAuthenticated = false;
      deleteTokens('qobuz');
    },
    refreshToken: async () => {
      await this.refreshAccessToken();
    },
  };

  constructor() {
    this.clientId = process.env.QOBUZ_CLIENT_ID || '';
    this.clientSecret = process.env.QOBUZ_CLIENT_SECRET || '';
    this.isAvailable = !!(this.clientId && this.clientSecret);
  }

  async initialize(): Promise<void> {
    if (!this.clientId || !this.clientSecret) {
      logger.info('Qobuz: No client credentials configured, skipping');
      return;
    }

    try {
      const stored = loadTokens('qobuz');
      if (stored) {
        this.tokens = stored;
        this.auth.isAuthenticated = true;
        logger.info('Qobuz: Restored tokens from database');
        if (Date.now() >= stored.expiresAt - 60_000) {
          await this.refreshAccessToken();
          logger.info('Qobuz: Refreshed expired token');
        }
      } else {
        logger.info('Qobuz: Provider initialized (awaiting authentication)');
      }
    } catch (err) {
      logger.warn(`Qobuz: Failed to restore tokens: ${err}`);
    }
  }

  async dispose(): Promise<void> {
    this.tokens = null;
  }

  getAuthUrl(redirectUri: string): string {
    const scopes = ['offline_access', 'streaming', 'user-library-read'];
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
    });
    return `${QOBUZ_AUTH_URL}/authorize?${params}`;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const res = await fetch(`${QOBUZ_AUTH_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qobuz auth failed: ${text}`);
    }

    const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.auth.isAuthenticated = true;
    saveTokens('qobuz', this.tokens);
    logger.info('Qobuz: Authenticated successfully');
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) throw new Error('No refresh token');

    const res = await fetch(`${QOBUZ_AUTH_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!res.ok) {
      throw new Error('Qobuz token refresh failed');
    }

    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!this.tokens) throw new Error('No existing token to refresh');

    this.tokens.accessToken = data.access_token;
    if (data.refresh_token) this.tokens.refreshToken = data.refresh_token;
    this.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    saveTokens('qobuz', this.tokens);
  }

  private async apiRequest(path: string): Promise<any> {
    if (!this.tokens) throw new Error('Not authenticated');
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }

    const res = await fetch(`${QOBUZ_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${this.tokens.accessToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qobuz API error: ${res.status} ${text}`);
    }

    return res.json();
  }

  async getArtists(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Artist[], total: 0 };
    return { items: [] as Artist[], total: 0 };
  }

  async getArtist(_id: string): Promise<Artist | null> {
    if (!this.auth.isAuthenticated) return null;
    return null;
  }

  async getAlbums(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Album[], total: 0 };
    return { items: [] as Album[], total: 0 };
  }

  async getAlbum(_id: string): Promise<Album | null> {
    if (!this.auth.isAuthenticated) return null;
    return null;
  }

  async getAlbumTracks(_albumId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    return [];
  }

  async getArtistAlbums(_artistId: string): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    return [];
  }

  async search(_query: string, _limit = 20): Promise<SearchResults> {
    if (!this.auth.isAuthenticated) return { artists: [], albums: [], tracks: [], playlists: [] };
    return { artists: [], albums: [], tracks: [], playlists: [] };
  }

  async getStreamUrl(_trackId: string): Promise<string | null> {
    if (!this.auth.isAuthenticated) return null;
    logger.debug('Qobuz: getStreamUrl called but not implemented');
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
}

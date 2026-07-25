import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';
import { createHash } from 'crypto';
import { logger } from '../logger.js';
import { deleteTokens, loadTokens, saveTokens } from '../services/tokenstore.js';

const QOBUZ_API_URL = 'https://www.qobuz.com/api.json/0.2';
const QOBUZ_DEFAULT_FORMAT_ID = '5';
const QOBUZ_SUPPORTED_FORMAT_IDS = new Set(['5', '6', '7', '27']);

export type QobuzErrorCode =
  | 'qobuz_not_configured'
  | 'qobuz_not_authenticated'
  | 'qobuz_invalid_credentials'
  | 'qobuz_stream_unavailable'
  | 'qobuz_geo_or_subscription_blocked';

export interface QobuzStatus {
  available: boolean;
  configured: boolean;
  authenticated: boolean;
  streamingAvailable: boolean;
  reason: 'ready' | QobuzErrorCode;
  formatId: string;
  accountName?: string;
}

export interface QobuzStreamInfo {
  url: string;
  formatId: string;
  expiresAt?: number;
}

interface StoredQobuzSession {
  userId: number | null;
  displayName: string | null;
  storedAt: number;
}

interface QobuzLoginResponse {
  user_auth_token?: string;
  user?: {
    id?: number;
    display_name?: string;
    login?: string;
  };
}

interface QobuzImageResponse {
  large?: string;
  medium?: string;
  small?: string;
}

interface QobuzArtistSummaryResponse {
  id: string | number;
  name: string;
}

interface QobuzArtistResponse extends QobuzArtistSummaryResponse {
  image?: QobuzImageResponse;
  picture?: string;
  albums?: QobuzPageResponse<QobuzAlbumResponse>;
}

interface QobuzAlbumResponse {
  id: string | number;
  title: string;
  artist?: QobuzArtistSummaryResponse;
  released_at?: number;
  image?: QobuzImageResponse;
  genre?: { name?: string };
  tracks_count?: number;
  tracks?: QobuzPageResponse<QobuzTrackResponse>;
}

interface QobuzTrackResponse {
  id: string | number;
  title: string;
  album?: Pick<QobuzAlbumResponse, 'id' | 'title'>;
  performer?: QobuzArtistSummaryResponse;
  artist?: QobuzArtistSummaryResponse;
  track_number?: number;
  duration?: number;
  maximum_sampling_rate?: number;
  maximum_bit_depth?: number;
}

interface QobuzPlaylistResponse {
  id: string | number;
  name: string;
  description?: string;
  tracks_count?: number;
  image_rectangle?: string[];
  tracks?: QobuzPageResponse<QobuzTrackResponse>;
}

interface QobuzPageResponse<T> {
  items?: T[];
  total?: number;
}

interface QobuzSearchPageResponse<T> {
  items?: Array<T | null>;
}

interface QobuzFavoritesResponse {
  artists?: QobuzPageResponse<QobuzArtistResponse>;
  albums?: QobuzPageResponse<QobuzAlbumResponse>;
}

interface QobuzSearchResponse {
  artists?: QobuzSearchPageResponse<QobuzArtistResponse>;
  albums?: QobuzSearchPageResponse<QobuzAlbumResponse>;
  tracks?: QobuzSearchPageResponse<QobuzTrackResponse>;
}

interface QobuzPlaylistsResponse {
  playlists?: QobuzPageResponse<QobuzPlaylistResponse>;
}

interface QobuzFileUrlResponse {
  url?: string;
  expires_at?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isQobuzErrorResponse(value: unknown): boolean {
  return isRecord(value) && value.status === 'error';
}

function getQobuzErrorMessage(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.error === 'string') return value.error;
  if (isRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message;
  }
  return fallback;
}

export class QobuzProviderError extends Error {
  constructor(
    public code: QobuzErrorCode,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = 'QobuzProviderError';
  }
}

export function createQobuzStreamSignature(
  trackId: string,
  formatId: string,
  requestTs: string,
  appSecret: string,
): string {
  const payload = `trackgetFileUrlformat_id${formatId}intentstreamtrack_id${trackId}${requestTs}${appSecret}`;
  return createHash('md5').update(payload).digest('hex');
}

function env(name: string): string {
  return process.env[name]?.trim() || '';
}

function normalizeFormatId(value: string | undefined): string {
  const candidate = value?.trim() || QOBUZ_DEFAULT_FORMAT_ID;
  return QOBUZ_SUPPORTED_FORMAT_IDS.has(candidate) ? candidate : QOBUZ_DEFAULT_FORMAT_ID;
}

/**
 * Qobuz provider using the unofficial API (username/password login).
 * Same approach as qobuz-dl, Volumio's Qobuz plugin, and other open-source players.
 *
 * Robust mode: streaming requires explicit QOBUZ_APP_ID and QOBUZ_APP_SECRET.
 * User auth can come from QOBUZ_USERNAME/QOBUZ_PASSWORD or from the Settings UI.
 */
export class QobuzProvider implements AuthenticatedMusicProvider {
  readonly type = 'qobuz' as const;
  readonly name = 'Qobuz';
  isAvailable = false;

  private appId = '';
  private appSecret = '';
  private formatId = QOBUZ_DEFAULT_FORMAT_ID;
  private userAuthToken: string | null = null;
  private userId: number | null = null;
  private accountName: string | null = null;

  auth: ProviderAuth = {
    isAuthenticated: false,
    login: async (credentials) => {
      await this.loginWithPassword(credentials.username, credentials.password);
    },
    logout: async () => {
      this.userAuthToken = null;
      this.userId = null;
      this.accountName = null;
      this.auth.isAuthenticated = false;
      deleteTokens('qobuz');
    },
    refreshToken: async () => {
      await this.reauthenticateWithEnvCredentials();
    },
  };

  constructor() {
    this.reloadConfig();
  }

  async initialize(): Promise<void> {
    this.reloadConfig();
    if (!this.hasAppCredentials()) {
      logger.info('Qobuz: Missing QOBUZ_APP_ID/QOBUZ_APP_SECRET, streaming disabled');
      return;
    }

    const { username, password } = this.getEnvCredentials();
    if (username && password) {
      try {
        await this.loginWithPassword(username, password);
        return;
      } catch (err) {
        logger.warn(`Qobuz: Login with env credentials failed: ${err}`);
      }
    }

    if (this.loadStoredSession()) {
      logger.info('Qobuz: Restored user auth token from database');
      return;
    }

    logger.info(
      'Qobuz: App configured, awaiting user login via Settings or QOBUZ_USERNAME/QOBUZ_PASSWORD.',
    );
  }

  async dispose(): Promise<void> {
    this.userAuthToken = null;
  }

  // Dummy method for interface compatibility
  getAuthUrl(_redirectUri: string): string {
    return '';
  }

  // ─── Auth ────────────────────────────────────────────────────

  getStatus(): QobuzStatus {
    this.reloadConfig();
    const configured = this.hasAppCredentials();
    const authenticated = this.auth.isAuthenticated && !!this.userAuthToken;
    let reason: QobuzStatus['reason'] = 'ready';
    if (!configured) reason = 'qobuz_not_configured';
    else if (!authenticated) reason = 'qobuz_not_authenticated';

    return {
      available: this.isAvailable,
      configured,
      authenticated,
      streamingAvailable: configured && authenticated,
      reason,
      formatId: this.formatId,
      accountName: this.accountName || undefined,
    };
  }

  private reloadConfig(): void {
    this.appId = env('QOBUZ_APP_ID');
    this.appSecret = env('QOBUZ_APP_SECRET');
    this.formatId = normalizeFormatId(process.env.QOBUZ_AUDIO_FORMAT);
    this.isAvailable = this.hasAppCredentials();
  }

  private hasAppCredentials(): boolean {
    return !!(this.appId && this.appSecret);
  }

  private getEnvCredentials(): { username: string; password: string } {
    return { username: env('QOBUZ_USERNAME'), password: env('QOBUZ_PASSWORD') };
  }

  private requireConfigured(): void {
    this.reloadConfig();
    if (!this.hasAppCredentials()) {
      throw new QobuzProviderError(
        'qobuz_not_configured',
        'Qobuz streaming requires QOBUZ_APP_ID and QOBUZ_APP_SECRET.',
        400,
      );
    }
  }

  private requireAuthenticated(): void {
    if (!this.userAuthToken) {
      this.auth.isAuthenticated = false;
      throw new QobuzProviderError(
        'qobuz_not_authenticated',
        'Qobuz is not authenticated. Login in Settings or set QOBUZ_USERNAME/QOBUZ_PASSWORD.',
        401,
      );
    }
  }

  private async loginWithPassword(username: string, password: string): Promise<void> {
    this.requireConfigured();
    if (!username || !password) {
      throw new QobuzProviderError(
        'qobuz_invalid_credentials',
        'Qobuz username and password are required.',
        400,
      );
    }

    const res = await fetch(`${QOBUZ_API_URL}/user/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-App-Id': this.appId,
      },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new QobuzProviderError('qobuz_invalid_credentials', `Qobuz login failed: ${text}`, 401);
    }

    const data = (await res.json()) as QobuzLoginResponse;
    if (!data.user_auth_token) {
      throw new QobuzProviderError(
        'qobuz_invalid_credentials',
        'Qobuz login failed: no auth token in response',
        401,
      );
    }

    this.userAuthToken = data.user_auth_token;
    this.userId = data.user?.id ?? null;
    this.accountName = data.user?.display_name || data.user?.login || username;
    this.auth.isAuthenticated = true;
    this.isAvailable = true;

    this.saveSession();

    logger.info(`Qobuz: Logged in as ${this.accountName || username}`);
  }

  private saveSession(): void {
    if (!this.userAuthToken) return;
    const metadata: StoredQobuzSession = {
      userId: this.userId,
      displayName: this.accountName,
      storedAt: Date.now(),
    };
    saveTokens('qobuz', {
      accessToken: this.userAuthToken,
      refreshToken: JSON.stringify(metadata),
      expiresAt: 0,
    });
  }

  private loadStoredSession(): boolean {
    const stored = loadTokens('qobuz');
    if (!stored?.accessToken) return false;
    try {
      const metadata = JSON.parse(stored.refreshToken) as Partial<StoredQobuzSession>;
      this.userAuthToken = stored.accessToken;
      this.userId = typeof metadata.userId === 'number' ? metadata.userId : null;
      this.accountName = typeof metadata.displayName === 'string' ? metadata.displayName : null;
      this.auth.isAuthenticated = true;
      return true;
    } catch {
      // Legacy builds stored username:base64(password) in refresh_token. Remove
      // that row so credentials are no longer persisted in the database.
      deleteTokens('qobuz');
      return false;
    }
  }

  private async reauthenticateWithEnvCredentials(): Promise<void> {
    const { username, password } = this.getEnvCredentials();
    if (!username || !password) {
      this.userAuthToken = null;
      this.userId = null;
      this.accountName = null;
      this.auth.isAuthenticated = false;
      throw new QobuzProviderError(
        'qobuz_not_authenticated',
        'Qobuz token expired. Login again in Settings or set QOBUZ_USERNAME/QOBUZ_PASSWORD.',
        401,
      );
    }
    await this.loginWithPassword(username, password);
  }

  // ─── API ─────────────────────────────────────────────────────

  private async apiRequest<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    this.requireConfigured();
    this.requireAuthenticated();

    return this.withAuthRetry(() => this.rawApiRequest<T>(endpoint, params));
  }

  private async rawApiRequest<T>(
    endpoint: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(`${QOBUZ_API_URL}/${endpoint}`);
    url.searchParams.set('app_id', this.appId);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: { 'X-User-Auth-Token': this.userAuthToken! },
    });

    const text = await res.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (res.status === 401) {
      throw new QobuzProviderError(
        'qobuz_not_authenticated',
        'Qobuz token expired or is invalid.',
        401,
      );
    }
    if (!res.ok || isQobuzErrorResponse(data)) {
      const err = this.mapApiError(endpoint, res.status, data);
      logger.error(`Qobuz API ${res.status}: ${endpoint} → ${err.message.slice(0, 200)}`);
      throw err;
    }

    return data as T;
  }

  private async withAuthRetry<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (err instanceof QobuzProviderError && err.code === 'qobuz_not_authenticated') {
        logger.info('Qobuz: Token expired, attempting env credential re-login');
        await this.reauthenticateWithEnvCredentials();
        return request();
      }
      throw err;
    }
  }

  private mapApiError(endpoint: string, status: number, data: unknown): QobuzProviderError {
    const message = getQobuzErrorMessage(data, `Qobuz API error: ${status}`);
    const lower = message.toLowerCase();
    if (lower.includes('app') && lower.includes('secret')) {
      return new QobuzProviderError('qobuz_not_configured', message, 400);
    }
    if (
      status === 403 ||
      lower.includes('subscription') ||
      lower.includes('geo') ||
      lower.includes('not available') ||
      lower.includes('not streamable') ||
      lower.includes('right')
    ) {
      return new QobuzProviderError('qobuz_geo_or_subscription_blocked', message, 403);
    }
    if (endpoint === 'track/getFileUrl') {
      return new QobuzProviderError('qobuz_stream_unavailable', message, status || 404);
    }
    return new QobuzProviderError('qobuz_stream_unavailable', message, status || 500);
  }

  // ─── MusicProvider ───────────────────────────────────────────

  async getArtists(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Artist[], total: 0 };
    try {
      const data = await this.apiRequest<QobuzFavoritesResponse>('favorite/getUserFavorites', {
        type: 'artists',
        limit: '50',
      });
      const artists = (data.artists?.items || []).map((artist) => this.mapArtist(artist));
      return { items: artists, total: data.artists?.total || 0 };
    } catch {
      return { items: [] as Artist[], total: 0 };
    }
  }

  async getArtist(id: string): Promise<Artist | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const qobuzId = id.replace('qobuz:', '');
      const data = await this.apiRequest<QobuzArtistResponse>('artist/get', {
        artist_id: qobuzId,
      });
      return this.mapArtist(data);
    } catch {
      return null;
    }
  }

  async getAlbums(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Album[], total: 0 };
    try {
      const data = await this.apiRequest<QobuzFavoritesResponse>('favorite/getUserFavorites', {
        type: 'albums',
        limit: '50',
      });
      const albums = (data.albums?.items || []).map((album) => this.mapAlbum(album));
      return { items: albums, total: data.albums?.total || 0 };
    } catch {
      return { items: [] as Album[], total: 0 };
    }
  }

  async getAlbum(id: string): Promise<Album | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const qobuzId = id.replace('qobuz:', '');
      const data = await this.apiRequest<QobuzAlbumResponse>('album/get', {
        album_id: qobuzId,
      });
      return this.mapAlbum(data);
    } catch {
      return null;
    }
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const qobuzId = albumId.replace('qobuz:', '');
      const data = await this.apiRequest<QobuzAlbumResponse>('album/get', {
        album_id: qobuzId,
      });
      return (data.tracks?.items || []).map((track) => this.mapTrack(track, data));
    } catch {
      return [];
    }
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const qobuzId = artistId.replace('qobuz:', '');
      const data = await this.apiRequest<QobuzArtistResponse>('artist/get', {
        artist_id: qobuzId,
        extra: 'albums',
        limit: '50',
      });
      return (data.albums?.items || []).map((album) => this.mapAlbum(album));
    } catch {
      return [];
    }
  }

  async search(query: string, limit = 10): Promise<SearchResults> {
    if (!this.auth.isAuthenticated) return { artists: [], albums: [], tracks: [], playlists: [] };
    try {
      const data = await this.apiRequest<QobuzSearchResponse>('catalog/search', {
        query,
        limit: String(limit),
      });
      return {
        artists: (data.artists?.items || [])
          .filter((artist): artist is QobuzArtistResponse => Boolean(artist?.id))
          .map((artist) => this.mapArtist(artist)),
        albums: (data.albums?.items || [])
          .filter((album): album is QobuzAlbumResponse => Boolean(album?.id))
          .map((album) => this.mapAlbum(album)),
        tracks: (data.tracks?.items || [])
          .filter((track): track is QobuzTrackResponse => Boolean(track?.id))
          .map((track) => this.mapTrack(track)),
        playlists: [],
      };
    } catch (err) {
      logger.error(`Qobuz search failed: ${err}`);
      return { artists: [], albums: [], tracks: [], playlists: [] };
    }
  }

  async getStreamUrl(trackId: string): Promise<string | null> {
    const stream = await this.getStreamInfo(trackId);
    return stream.url;
  }

  async getStreamInfo(trackId: string): Promise<QobuzStreamInfo> {
    this.requireConfigured();
    this.requireAuthenticated();

    const qobuzId = trackId.replace('qobuz:', '');
    const requestTs = Math.floor(Date.now() / 1000).toString();
    const requestSig = createQobuzStreamSignature(
      qobuzId,
      this.formatId,
      requestTs,
      this.appSecret,
    );

    const data = await this.apiRequest<QobuzFileUrlResponse>('track/getFileUrl', {
      track_id: qobuzId,
      format_id: this.formatId,
      intent: 'stream',
      request_ts: requestTs,
      request_sig: requestSig,
    });

    if (!data?.url || typeof data.url !== 'string') {
      throw new QobuzProviderError(
        'qobuz_stream_unavailable',
        'Qobuz did not return a stream URL for this track.',
        404,
      );
    }

    return {
      url: data.url,
      formatId: this.formatId,
      expiresAt: typeof data.expires_at === 'number' ? data.expires_at : undefined,
    };
  }

  async getPlaylists(): Promise<Playlist[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.apiRequest<QobuzPlaylistsResponse>('playlist/getUserPlaylists', {
        limit: '50',
      });
      return (data.playlists?.items || []).map((playlist) => this.mapPlaylist(playlist));
    } catch {
      return [];
    }
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const qobuzId = playlistId.replace('qobuz:', '');
      const data = await this.apiRequest<QobuzPlaylistResponse>('playlist/get', {
        playlist_id: qobuzId,
        extra: 'tracks',
        limit: '100',
      });
      return (data.tracks?.items || []).map((track) => this.mapTrack(track));
    } catch {
      return [];
    }
  }

  // ─── Mappers ─────────────────────────────────────────────────

  private mapArtist(data: QobuzArtistResponse): Artist {
    return {
      id: `qobuz:${data.id}`,
      name: data.name,
      imageUrl: data.image?.large || data.image?.medium || data.picture,
      source: 'qobuz',
    };
  }

  private mapAlbum(data: QobuzAlbumResponse): Album {
    return {
      id: `qobuz:${data.id}`,
      title: data.title,
      artistId: `qobuz:${data.artist?.id || ''}`,
      artistName: data.artist?.name || 'Unknown',
      year: data.released_at ? new Date(data.released_at * 1000).getFullYear() : undefined,
      coverUrl: data.image?.large || data.image?.small,
      genre: data.genre?.name,
      trackCount: data.tracks_count,
      source: 'qobuz',
    };
  }

  private mapTrack(data: QobuzTrackResponse, album?: QobuzAlbumResponse): Track {
    const trackAlbum = album || data.album;
    return {
      id: `qobuz:${data.id}`,
      title: data.title,
      albumId: `qobuz:${trackAlbum?.id || ''}`,
      albumTitle: trackAlbum?.title || '',
      artistId: `qobuz:${data.performer?.id || data.artist?.id || ''}`,
      artistName: data.performer?.name || data.artist?.name || 'Unknown',
      trackNumber: data.track_number,
      duration: data.duration,
      sampleRate: data.maximum_sampling_rate ? data.maximum_sampling_rate * 1000 : undefined,
      bitDepth: data.maximum_bit_depth,
      source: 'qobuz',
    };
  }

  private mapPlaylist(data: QobuzPlaylistResponse): Playlist {
    return {
      id: `qobuz:${data.id}`,
      name: data.name,
      description: data.description,
      trackCount: data.tracks_count || 0,
      coverUrl: data.image_rectangle?.[0],
      source: 'qobuz',
    };
  }
}

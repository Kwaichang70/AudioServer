import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';
import { logger } from '../logger.js';
import { saveTokens, loadTokens, deleteTokens } from '../services/tokenstore.js';

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com';
const SPOTIFY_API_URL = 'https://api.spotify.com/v1';

interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface SpotifyImageResponse {
  url: string;
}

interface SpotifyArtistSummaryResponse {
  id: string;
  name: string;
}

interface SpotifyArtistResponse extends SpotifyArtistSummaryResponse {
  images?: SpotifyImageResponse[];
}

interface SpotifyAlbumResponse {
  id: string;
  name: string;
  artists?: SpotifyArtistSummaryResponse[];
  release_date?: string;
  images?: SpotifyImageResponse[];
  total_tracks?: number;
  tracks?: SpotifyPageResponse<SpotifyTrackResponse>;
}

interface SpotifyTrackResponse {
  id: string;
  name: string;
  album?: SpotifyAlbumResponse;
  artists?: SpotifyArtistSummaryResponse[];
  track_number?: number;
  duration_ms?: number;
}

interface SpotifyPlaylistResponse {
  id: string;
  name: string;
  description?: string;
  tracks?: { total?: number };
  images?: SpotifyImageResponse[];
}

interface SpotifyPageResponse<T> {
  items?: T[];
  total?: number;
}

interface SpotifySearchPageResponse<T> {
  items?: Array<T | null>;
}

interface SpotifyFollowingResponse {
  artists?: SpotifyPageResponse<SpotifyArtistResponse>;
}

interface SpotifySavedAlbumsResponse extends SpotifyPageResponse<{ album: SpotifyAlbumResponse }> {}

interface SpotifySearchResponse {
  artists?: SpotifySearchPageResponse<SpotifyArtistResponse>;
  albums?: SpotifySearchPageResponse<SpotifyAlbumResponse>;
  tracks?: SpotifySearchPageResponse<SpotifyTrackResponse>;
  playlists?: SpotifySearchPageResponse<SpotifyPlaylistResponse>;
}

interface SpotifyPlaylistTracksResponse {
  items?: Array<{ track?: SpotifyTrackResponse | null }>;
}

export interface SpotifyConnectDevice {
  id: string;
  name: string;
  type: string;
  is_active?: boolean;
  is_private_session?: boolean;
  is_restricted?: boolean;
  volume_percent?: number;
}

interface SpotifyDevicesResponse {
  devices?: SpotifyConnectDevice[];
}

export interface SpotifyPlaybackState {
  is_playing?: boolean;
  progress_ms?: number;
  item?: SpotifyTrackResponse | null;
  device?: SpotifyConnectDevice;
}

/**
 * Spotify provider using Web API for metadata + Spotify Connect for playback.
 *
 * Architecture:
 * - OAuth2 Authorization Code flow for user authentication
 * - Web API for browse, search, playlists (full metadata access)
 * - Playback: Spotify Web API only controls Spotify Connect devices
 *   For server-side audio output, use Librespot (Rust Spotify Connect client)
 *   running as a subprocess that acts as a Spotify Connect receiver.
 *
 * Setup:
 * 1. Create app at https://developer.spotify.com/dashboard
 * 2. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env
 * 3. Add redirect URI: http://localhost:3001/api/providers/spotify/callback
 * 4. Call POST /api/providers/spotify/auth/init to get the login URL
 *
 * Librespot integration (future):
 * - Install librespot: cargo install librespot
 * - Run: librespot --name "AudioServer" --backend pipe --initial-volume 80
 * - Pipe audio output to DLNA/Sonos via ffmpeg or directly to ALSA
 */
export class SpotifyProvider implements AuthenticatedMusicProvider {
  readonly type = 'spotify' as const;
  readonly name = 'Spotify';
  isAvailable = false;

  private tokens: SpotifyTokens | null = null;
  private clientId: string;
  private clientSecret: string;
  // When Spotify returns 429, pause GET/search calls until this timestamp so a
  // background batch (cover-art fetch) can't keep the whole account rate-limited
  // — which would also break the user's own searches.
  private rateLimitedUntil = 0;

  auth: ProviderAuth = {
    isAuthenticated: false,
    login: async (credentials) => {
      await this.exchangeCode(credentials.code, credentials.redirectUri);
    },
    logout: async () => {
      this.tokens = null;
      this.auth.isAuthenticated = false;
      deleteTokens('spotify');
    },
    refreshToken: async () => {
      await this.refreshAccessToken();
    },
  };

  constructor() {
    this.clientId = process.env.SPOTIFY_CLIENT_ID || '';
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';
    this.isAvailable = !!(this.clientId && this.clientSecret);
  }

  async initialize(): Promise<void> {
    if (!this.clientId) {
      logger.info('Spotify: No client credentials configured, skipping');
      return;
    }
    // Try to load tokens from DB
    try {
      const stored = loadTokens('spotify');
      if (stored) {
        this.tokens = stored;
        this.auth.isAuthenticated = true;
        logger.info('Spotify: Restored tokens from database');
        // Refresh if expired
        if (Date.now() >= stored.expiresAt - 60_000) {
          await this.refreshAccessToken();
          logger.info('Spotify: Refreshed expired token');
        }
      } else {
        logger.info('Spotify: Provider initialized (awaiting authentication)');
      }
    } catch (err) {
      logger.warn(`Spotify: Failed to restore tokens: ${err}`);
    }
  }

  async dispose(): Promise<void> {
    this.tokens = null;
  }

  // ─── OAuth Flow ──────────────────────────────────────────────

  getAuthUrl(redirectUri: string): string {
    // Spotify Development Mode (since the March 2026 changes) rejects the whole
    // authorize request up front — error=server_error, *before* the consent
    // screen — if it asks for scopes whose endpoints were pulled from Dev Mode,
    // i.e. the library/playlist "browse" scopes. We request only what in-browser
    // playback via the Web Playback SDK needs: streaming + the SDK-required
    // identity scopes + playback control. (Catalogue browsing inside the app
    // would need Extended Quota Mode anyway, since those endpoints are gone.)
    const scopes = [
      'streaming', // Web Playback SDK: in-browser playback
      'user-read-email', // required by the Web Playback SDK
      'user-read-private', // required by the Web Playback SDK
      'user-read-playback-state', // read player state for the transport UI
      'user-modify-playback-state', // start / pause / seek on the SDK device
    ].join(' ');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: scopes,
      redirect_uri: redirectUri,
    });
    return `${SPOTIFY_AUTH_URL}/authorize?${params}`;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<void> {
    const res = await fetch(`${SPOTIFY_AUTH_URL}/api/token`, {
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

    if (!res.ok) throw new Error(`Spotify auth failed: ${await res.text()}`);

    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.auth.isAuthenticated = true;
    saveTokens('spotify', this.tokens);
    logger.info('Spotify: Authenticated successfully');
  }

  // Single-flight: the 3s Connect poll, searches, and the Web Playback token
  // endpoint can all hit an expired token at once. Spotify may rotate refresh
  // tokens, so parallel refreshes risk invalidating each other — share one.
  private refreshInflight: Promise<void> | null = null;

  private refreshAccessToken(): Promise<void> {
    if (!this.refreshInflight) {
      this.refreshInflight = this.doRefreshAccessToken().finally(() => {
        this.refreshInflight = null;
      });
    }
    return this.refreshInflight;
  }

  private async doRefreshAccessToken(): Promise<void> {
    if (!this.tokens?.refreshToken) throw new Error('No refresh token');

    const res = await fetch(`${SPOTIFY_AUTH_URL}/api/token`, {
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

    if (!res.ok) {
      // 400/401 = refresh token revoked/invalid (e.g. app access withdrawn).
      // Without deauthing here, every 3s poll would retry the refresh POST
      // forever while the UI keeps claiming "connected". Transient errors
      // (5xx, network) fall through and just throw.
      if (res.status === 400 || res.status === 401) {
        logger.error(
          `Spotify refresh token rejected (${res.status}) — disconnecting; re-connect Spotify in Settings`,
        );
        this.tokens = null;
        this.auth.isAuthenticated = false;
        deleteTokens('spotify');
      }
      throw new Error(`Spotify token refresh failed (${res.status})`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    this.tokens.accessToken = data.access_token;
    if (data.refresh_token) this.tokens.refreshToken = data.refresh_token;
    this.tokens.expiresAt = Date.now() + data.expires_in * 1000;
    saveTokens('spotify', this.tokens);
  }

  private async getHeaders(): Promise<Record<string, string>> {
    if (!this.tokens) throw new Error('Not authenticated');
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }
    return { Authorization: `Bearer ${this.tokens.accessToken}` };
  }

  /**
   * Return a currently-valid access token for the browser Web Playback SDK.
   * The SDK's getOAuthToken callback needs a fresh token; we refresh here if
   * it's within 60s of expiry so the SDK never receives a stale one.
   * The token already carries the `streaming` scope (requested in getAuthUrl).
   */
  async getWebPlaybackToken(): Promise<{ accessToken: string; expiresAt: number }> {
    if (!this.tokens) throw new Error('Not authenticated');
    if (Date.now() >= this.tokens.expiresAt - 60_000) {
      await this.refreshAccessToken();
    }
    return { accessToken: this.tokens.accessToken, expiresAt: this.tokens.expiresAt };
  }

  // Honor Retry-After (capped) and pause API calls for that window so we stop
  // hammering — that's what lets the rolling rate-limit window drain and the
  // user's own searches start working again. Shared by every request path so
  // whichever call first sees the 429 starts the cooldown for all of them.
  private noteRateLimit(res: { headers: { get(name: string): string | null } }): void {
    const retryAfter = Math.min(Number(res.headers.get('Retry-After')) || 5, 30);
    this.rateLimitedUntil = Date.now() + retryAfter * 1000;
    logger.warn(`Spotify rate-limited (429); pausing API calls for ${retryAfter}s`);
  }

  private async apiRequest<T>(path: string): Promise<T> {
    if (Date.now() < this.rateLimitedUntil) {
      throw new Error('Spotify API error: 429 (cooling down)');
    }
    const headers = await this.getHeaders();
    const url = `${SPOTIFY_API_URL}${path}`;
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      this.noteRateLimit(res);
      throw new Error('Spotify API error: 429 Too many requests');
    }
    if (!res.ok) {
      const text = await res.text();
      logger.error(`Spotify API ${res.status}: ${url} → ${text.slice(0, 200)}`);
      throw new Error(`Spotify API error: ${res.status} ${text.slice(0, 100)}`);
    }
    return (await res.json()) as T;
  }

  // PUT/POST are direct user actions (play/pause/volume): they still run
  // during a cooldown — failing them fast wouldn't make them succeed — but a
  // 429 here does START the cooldown so the GET/search paths back off.
  private async apiPut(path: string, body?: unknown): Promise<void> {
    const headers = await this.getHeaders();
    const res = await fetch(`${SPOTIFY_API_URL}${path}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      if (res.status === 429) this.noteRateLimit(res);
      const text = await res.text();
      throw new Error(`Spotify API error: ${res.status} ${text}`);
    }
  }

  private async apiPost(path: string, body?: unknown): Promise<void> {
    const headers = await this.getHeaders();
    const res = await fetch(`${SPOTIFY_API_URL}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      if (res.status === 429) this.noteRateLimit(res);
      const text = await res.text();
      throw new Error(`Spotify API error: ${res.status} ${text}`);
    }
  }

  // ─── Spotify Connect ─────────────────────────────────────────

  async getConnectDevices(): Promise<SpotifyConnectDevice[]> {
    if (!this.auth.isAuthenticated) return [];
    const data = await this.apiRequest<SpotifyDevicesResponse>('/me/player/devices');
    return data.devices || [];
  }

  async getPlaybackState(): Promise<SpotifyPlaybackState | null> {
    if (!this.auth.isAuthenticated) return null;
    // Polled every 3s by the client during Connect playback — the most
    // frequent Spotify call in the app, so it must honor the 429 cooldown
    // (and set it when it's the first to see a 429).
    if (Date.now() < this.rateLimitedUntil) return null;
    const headers = await this.getHeaders();
    const res = await fetch(`${SPOTIFY_API_URL}/me/player`, { headers });
    if (res.status === 429) {
      this.noteRateLimit(res);
      return null;
    }
    if (res.status === 204) return null; // No active playback
    if (!res.ok) return null;
    return (await res.json()) as SpotifyPlaybackState;
  }

  async connectPlay(trackUri: string, deviceId?: string): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : '';
    await this.apiPut(`/me/player/play${params}`, {
      uris: [trackUri],
    });
  }

  async connectPlayContext(
    contextUri: string,
    deviceId?: string,
    offset?: number | { uri: string },
  ): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : '';
    await this.apiPut(`/me/player/play${params}`, {
      context_uri: contextUri,
      // Numeric offsets address a position; {uri} addresses a specific track
      // within the context — the client uses the latter to start an album at
      // the clicked track while letting Spotify advance natively afterwards.
      offset: typeof offset === 'number' ? { position: offset } : offset,
    });
  }

  async connectPause(deviceId?: string): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : '';
    await this.apiPut(`/me/player/pause${params}`);
  }

  async connectResume(deviceId?: string): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : '';
    await this.apiPut(`/me/player/play${params}`);
  }

  async connectNext(deviceId?: string): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : '';
    await this.apiPost(`/me/player/next${params}`);
  }

  async connectPrevious(deviceId?: string): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : '';
    await this.apiPost(`/me/player/previous${params}`);
  }

  async connectSetVolume(volume: number, deviceId?: string): Promise<void> {
    const params = new URLSearchParams({ volume_percent: String(Math.round(volume)) });
    if (deviceId) params.set('device_id', deviceId);
    await this.apiPut(`/me/player/volume?${params}`);
  }

  async connectTransferPlayback(deviceId: string): Promise<void> {
    await this.apiPut('/me/player', { device_ids: [deviceId], play: true });
  }

  // ─── MusicProvider Implementation ────────────────────────────

  async getArtists(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Artist[], total: 0 };
    try {
      const data = await this.apiRequest<SpotifyFollowingResponse>(
        '/me/following?type=artist&limit=50',
      );
      const artists = (data.artists?.items || []).map((artist) => this.mapArtist(artist));
      return { items: artists, total: data.artists?.total || 0 };
    } catch {
      return { items: [] as Artist[], total: 0 };
    }
  }

  async getArtist(id: string): Promise<Artist | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const spotifyId = id.replace('spotify:', '');
      const data = await this.apiRequest<SpotifyArtistResponse>(`/artists/${spotifyId}`);
      return this.mapArtist(data);
    } catch {
      return null;
    }
  }

  async getAlbums(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Album[], total: 0 };
    try {
      const data = await this.apiRequest<SpotifySavedAlbumsResponse>('/me/albums?limit=50');
      const albums = (data.items || []).map((item) => this.mapAlbum(item.album));
      return { items: albums, total: data.total || 0 };
    } catch {
      return { items: [] as Album[], total: 0 };
    }
  }

  async getAlbum(id: string): Promise<Album | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const spotifyId = id.replace('spotify:', '');
      return this.mapAlbum(await this.apiRequest<SpotifyAlbumResponse>(`/albums/${spotifyId}`));
    } catch {
      return null;
    }
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const spotifyId = albumId.replace('spotify:', '');
      const album = await this.apiRequest<SpotifyAlbumResponse>(`/albums/${spotifyId}`);
      return (album.tracks?.items || []).map((track) => this.mapTrack(track, album));
    } catch {
      return [];
    }
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const spotifyId = artistId.replace('spotify:', '');
      const data = await this.apiRequest<SpotifyPageResponse<SpotifyAlbumResponse>>(
        `/artists/${spotifyId}/albums?limit=50`,
      );
      return (data.items || []).map((album) => this.mapAlbum(album));
    } catch {
      return [];
    }
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    if (!this.auth.isAuthenticated) {
      logger.debug('Spotify search skipped: not authenticated');
      return { artists: [], albums: [], tracks: [], playlists: [] };
    }
    try {
      const data = await this.apiRequest<SpotifySearchResponse>(
        `/search?q=${encodeURIComponent(query)}&type=artist,album,track,playlist&limit=${Math.min(limit, 10)}`,
      );
      return {
        artists: (data.artists?.items || [])
          .filter((artist): artist is SpotifyArtistResponse => Boolean(artist?.id))
          .map((artist) => this.mapArtist(artist)),
        albums: (data.albums?.items || [])
          .filter((album): album is SpotifyAlbumResponse => Boolean(album?.id))
          .map((album) => this.mapAlbum(album)),
        tracks: (data.tracks?.items || [])
          .filter((track): track is SpotifyTrackResponse => Boolean(track?.id))
          .map((track) => this.mapTrack(track)),
        playlists: (data.playlists?.items || [])
          .filter((playlist): playlist is SpotifyPlaylistResponse => Boolean(playlist?.id))
          .map((playlist) => this.mapPlaylist(playlist)),
      };
    } catch (err) {
      logger.error(`Spotify search failed: ${err}`);
      return { artists: [], albums: [], tracks: [], playlists: [] };
    }
  }

  async getStreamUrl(_trackId: string): Promise<string | null> {
    // Spotify doesn't provide direct stream URLs via Web API.
    // Playback must go through Spotify Connect or Librespot.
    return null;
  }

  async getPlaylists(): Promise<Playlist[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data =
        await this.apiRequest<SpotifyPageResponse<SpotifyPlaylistResponse>>(
          '/me/playlists?limit=50',
        );
      return (data.items || []).map((playlist) => this.mapPlaylist(playlist));
    } catch {
      return [];
    }
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const spotifyId = playlistId.replace('spotify:', '');
      const data = await this.apiRequest<SpotifyPlaylistTracksResponse>(
        `/playlists/${spotifyId}/tracks?limit=100`,
      );
      return (data.items || [])
        .map((item) => item.track)
        .filter((track): track is SpotifyTrackResponse => Boolean(track))
        .map((track) => this.mapTrack(track));
    } catch {
      return [];
    }
  }

  // ─── Mappers ─────────────────────────────────────────────────

  private mapArtist(data: SpotifyArtistResponse): Artist {
    return {
      id: `spotify:${data.id}`,
      name: data.name,
      imageUrl: data.images?.[0]?.url,
      source: 'spotify',
    };
  }

  private mapAlbum(data: SpotifyAlbumResponse): Album {
    return {
      id: `spotify:${data.id}`,
      title: data.name,
      artistId: `spotify:${data.artists?.[0]?.id || ''}`,
      artistName: data.artists?.[0]?.name || 'Unknown',
      year: data.release_date ? new Date(data.release_date).getFullYear() : undefined,
      coverUrl: data.images?.[0]?.url,
      trackCount: data.total_tracks,
      source: 'spotify',
    };
  }

  private mapTrack(data: SpotifyTrackResponse, album?: SpotifyAlbumResponse): Track {
    const trackAlbum = album || data.album;
    return {
      id: `spotify:${data.id}`,
      title: data.name,
      albumId: `spotify:${trackAlbum?.id || ''}`,
      albumTitle: trackAlbum?.name || '',
      artistId: `spotify:${data.artists?.[0]?.id || ''}`,
      artistName: data.artists?.[0]?.name || 'Unknown',
      trackNumber: data.track_number,
      duration: data.duration_ms ? data.duration_ms / 1000 : undefined,
      source: 'spotify',
    };
  }

  private mapPlaylist(data: SpotifyPlaylistResponse): Playlist {
    return {
      id: `spotify:${data.id}`,
      name: data.name,
      description: data.description,
      trackCount: data.tracks?.total || 0,
      coverUrl: data.images?.[0]?.url,
      source: 'spotify',
    };
  }
}

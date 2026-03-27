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
    const scopes = [
      'user-read-private',
      'user-library-read',
      'playlist-read-private',
      'playlist-read-collaborative',
      'streaming',
      'user-read-playback-state',
      'user-modify-playback-state',
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

    const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    this.tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    this.auth.isAuthenticated = true;
    saveTokens('spotify', this.tokens);
    logger.info('Spotify: Authenticated successfully');
  }

  private async refreshAccessToken(): Promise<void> {
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

    if (!res.ok) throw new Error('Spotify token refresh failed');

    const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
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

  private async apiRequest(path: string): Promise<any> {
    const headers = await this.getHeaders();
    const url = `${SPOTIFY_API_URL}${path}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      logger.error(`Spotify API ${res.status}: ${url} → ${text.slice(0, 200)}`);
      throw new Error(`Spotify API error: ${res.status} ${text.slice(0, 100)}`);
    }
    return res.json();
  }

  private async apiPut(path: string, body?: any): Promise<void> {
    const headers = await this.getHeaders();
    const res = await fetch(`${SPOTIFY_API_URL}${path}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Spotify API error: ${res.status} ${text}`);
    }
  }

  private async apiPost(path: string, body?: any): Promise<void> {
    const headers = await this.getHeaders();
    const res = await fetch(`${SPOTIFY_API_URL}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Spotify API error: ${res.status} ${text}`);
    }
  }

  // ─── Spotify Connect ─────────────────────────────────────────

  async getConnectDevices(): Promise<any[]> {
    if (!this.auth.isAuthenticated) return [];
    const data = await this.apiRequest('/me/player/devices');
    return data.devices || [];
  }

  async getPlaybackState(): Promise<any> {
    if (!this.auth.isAuthenticated) return null;
    const headers = await this.getHeaders();
    const res = await fetch(`${SPOTIFY_API_URL}/me/player`, { headers });
    if (res.status === 204) return null; // No active playback
    if (!res.ok) return null;
    return res.json();
  }

  async connectPlay(trackUri: string, deviceId?: string): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : '';
    await this.apiPut(`/me/player/play${params}`, {
      uris: [trackUri],
    });
  }

  async connectPlayContext(contextUri: string, deviceId?: string, offset?: number): Promise<void> {
    const params = deviceId ? `?device_id=${deviceId}` : '';
    await this.apiPut(`/me/player/play${params}`, {
      context_uri: contextUri,
      offset: offset !== undefined ? { position: offset } : undefined,
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
      const data = await this.apiRequest('/me/following?type=artist&limit=50');
      const artists = (data.artists?.items || []).map((a: any) => this.mapArtist(a));
      return { items: artists, total: data.artists?.total || 0 };
    } catch { return { items: [] as Artist[], total: 0 }; }
  }

  async getArtist(id: string): Promise<Artist | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const spotifyId = id.replace('spotify:', '');
      const data = await this.apiRequest(`/artists/${spotifyId}`);
      return this.mapArtist(data);
    } catch { return null; }
  }

  async getAlbums(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Album[], total: 0 };
    try {
      const data = await this.apiRequest('/me/albums?limit=50');
      const albums = (data.items || []).map((i: any) => this.mapAlbum(i.album));
      return { items: albums, total: data.total || 0 };
    } catch { return { items: [] as Album[], total: 0 }; }
  }

  async getAlbum(id: string): Promise<Album | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const spotifyId = id.replace('spotify:', '');
      return this.mapAlbum(await this.apiRequest(`/albums/${spotifyId}`));
    } catch { return null; }
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const spotifyId = albumId.replace('spotify:', '');
      const album = await this.apiRequest(`/albums/${spotifyId}`);
      return (album.tracks?.items || []).map((t: any) => this.mapTrack(t, album));
    } catch { return []; }
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const spotifyId = artistId.replace('spotify:', '');
      const data = await this.apiRequest(`/artists/${spotifyId}/albums?limit=50`);
      return (data.items || []).map((a: any) => this.mapAlbum(a));
    } catch { return []; }
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    if (!this.auth.isAuthenticated) {
      logger.debug('Spotify search skipped: not authenticated');
      return { artists: [], albums: [], tracks: [], playlists: [] };
    }
    try {
      const data = await this.apiRequest(`/search?q=${encodeURIComponent(query)}&type=artist,album,track,playlist&limit=${limit}`);
      return {
        artists: (data.artists?.items || []).filter((a: any) => a?.id).map((a: any) => this.mapArtist(a)),
        albums: (data.albums?.items || []).filter((a: any) => a?.id).map((a: any) => this.mapAlbum(a)),
        tracks: (data.tracks?.items || []).filter((t: any) => t?.id).map((t: any) => this.mapTrack(t)),
        playlists: (data.playlists?.items || []).filter((p: any) => p?.id).map((p: any) => this.mapPlaylist(p)),
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
      const data = await this.apiRequest('/me/playlists?limit=50');
      return (data.items || []).map((p: any) => this.mapPlaylist(p));
    } catch { return []; }
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const spotifyId = playlistId.replace('spotify:', '');
      const data = await this.apiRequest(`/playlists/${spotifyId}/tracks?limit=100`);
      return (data.items || [])
        .filter((i: any) => i.track)
        .map((i: any) => this.mapTrack(i.track));
    } catch { return []; }
  }

  // ─── Mappers ─────────────────────────────────────────────────

  private mapArtist(data: any): Artist {
    return {
      id: `spotify:${data.id}`,
      name: data.name,
      imageUrl: data.images?.[0]?.url,
      source: 'spotify',
    };
  }

  private mapAlbum(data: any): Album {
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

  private mapTrack(data: any, album?: any): Track {
    return {
      id: `spotify:${data.id}`,
      title: data.name,
      albumId: `spotify:${(album || data.album)?.id || ''}`,
      albumTitle: (album || data.album)?.name || '',
      artistId: `spotify:${data.artists?.[0]?.id || ''}`,
      artistName: data.artists?.[0]?.name || 'Unknown',
      trackNumber: data.track_number,
      duration: data.duration_ms ? data.duration_ms / 1000 : undefined,
      source: 'spotify',
    };
  }

  private mapPlaylist(data: any): Playlist {
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

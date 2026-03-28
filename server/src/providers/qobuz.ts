import type { AuthenticatedMusicProvider, ProviderAuth } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults, Playlist } from '@audioserver/shared';
import { logger } from '../logger.js';
import { getRawDb } from '../db/index.js';

const QOBUZ_API_URL = 'https://www.qobuz.com/api.json/0.2';
// App ID from the Qobuz web player (public, used by many open-source projects)
const QOBUZ_APP_ID = '285473059';

/**
 * Qobuz provider using the unofficial API (username/password login).
 * Same approach as qobuz-dl, Volumio's Qobuz plugin, and other open-source players.
 *
 * Setup: set QOBUZ_USERNAME and QOBUZ_PASSWORD in .env
 * Or login via the Settings page.
 */
export class QobuzProvider implements AuthenticatedMusicProvider {
  readonly type = 'qobuz' as const;
  readonly name = 'Qobuz';
  isAvailable = false;

  private userAuthToken: string | null = null;
  private userId: number | null = null;
  private appSecret: string | null = null;

  auth: ProviderAuth = {
    isAuthenticated: false,
    login: async (credentials) => {
      await this.loginWithPassword(credentials.username, credentials.password);
    },
    logout: async () => {
      this.userAuthToken = null;
      this.userId = null;
      this.auth.isAuthenticated = false;
      this.deleteStoredCredentials();
    },
    refreshToken: async () => {
      // Re-login with stored credentials
      const creds = this.loadStoredCredentials();
      if (creds) await this.loginWithPassword(creds.username, creds.password);
    },
  };

  constructor() {
    const username = process.env.QOBUZ_USERNAME || '';
    const password = process.env.QOBUZ_PASSWORD || '';
    this.isAvailable = !!(username || this.loadStoredCredentials());
  }

  async initialize(): Promise<void> {
    // Try env vars first
    const username = process.env.QOBUZ_USERNAME;
    const password = process.env.QOBUZ_PASSWORD;

    if (username && password) {
      try {
        await this.loginWithPassword(username, password);
        return;
      } catch (err) {
        logger.warn(`Qobuz: Login with env credentials failed: ${err}`);
      }
    }

    // Try stored credentials
    const stored = this.loadStoredCredentials();
    if (stored) {
      try {
        await this.loginWithPassword(stored.username, stored.password);
        return;
      } catch (err) {
        logger.warn(`Qobuz: Login with stored credentials failed: ${err}`);
      }
    }

    logger.info('Qobuz: No credentials configured. Login via Settings or set QOBUZ_USERNAME/QOBUZ_PASSWORD.');
  }

  async dispose(): Promise<void> {
    this.userAuthToken = null;
  }

  // Dummy method for interface compatibility
  getAuthUrl(_redirectUri: string): string {
    return '';
  }

  // ─── Auth ────────────────────────────────────────────────────

  private async loginWithPassword(username: string, password: string): Promise<void> {
    const res = await fetch(`${QOBUZ_API_URL}/user/login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&app_id=${QOBUZ_APP_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Qobuz login failed: ${text}`);
    }

    const data = await res.json() as any;
    if (!data.user_auth_token) {
      throw new Error('Qobuz login failed: no auth token in response');
    }

    this.userAuthToken = data.user_auth_token;
    this.userId = data.user?.id;
    this.auth.isAuthenticated = true;
    this.isAvailable = true;

    // Store credentials for persistence across restarts
    this.saveCredentials(username, password);

    logger.info(`Qobuz: Logged in as ${data.user?.display_name || username}`);
  }

  private saveCredentials(username: string, password: string): void {
    try {
      const db = getRawDb();
      db.prepare(`
        INSERT OR REPLACE INTO provider_tokens (provider, access_token, refresh_token, expires_at)
        VALUES ('qobuz', ?, ?, ?)
      `).run(this.userAuthToken || '', `${username}:${Buffer.from(password).toString('base64')}`, 0);
    } catch {}
  }

  private loadStoredCredentials(): { username: string; password: string } | null {
    try {
      const db = getRawDb();
      const row = db.prepare('SELECT * FROM provider_tokens WHERE provider = ?').get('qobuz') as any;
      if (!row || !row.refresh_token) return null;
      const [username, passwordB64] = row.refresh_token.split(':');
      if (!username || !passwordB64) return null;
      return { username, password: Buffer.from(passwordB64, 'base64').toString() };
    } catch {
      return null;
    }
  }

  private deleteStoredCredentials(): void {
    try {
      const db = getRawDb();
      db.prepare('DELETE FROM provider_tokens WHERE provider = ?').run('qobuz');
    } catch {}
  }

  // ─── API ─────────────────────────────────────────────────────

  private async apiRequest(endpoint: string, params: Record<string, string> = {}): Promise<any> {
    if (!this.userAuthToken) throw new Error('Not authenticated');

    const url = new URL(`${QOBUZ_API_URL}/${endpoint}`);
    url.searchParams.set('app_id', QOBUZ_APP_ID);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: { 'X-User-Auth-Token': this.userAuthToken },
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error(`Qobuz API ${res.status}: ${endpoint} → ${text.slice(0, 200)}`);
      throw new Error(`Qobuz API error: ${res.status}`);
    }

    return res.json();
  }

  // ─── MusicProvider ───────────────────────────────────────────

  async getArtists(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Artist[], total: 0 };
    try {
      const data = await this.apiRequest('favorite/getUserFavorites', { type: 'artists', limit: '50' });
      const artists = (data.artists?.items || []).map((a: any) => this.mapArtist(a));
      return { items: artists, total: data.artists?.total || 0 };
    } catch { return { items: [] as Artist[], total: 0 }; }
  }

  async getArtist(id: string): Promise<Artist | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const qobuzId = id.replace('qobuz:', '');
      const data = await this.apiRequest('artist/get', { artist_id: qobuzId });
      return this.mapArtist(data);
    } catch { return null; }
  }

  async getAlbums(_page?: number, _pageSize?: number) {
    if (!this.auth.isAuthenticated) return { items: [] as Album[], total: 0 };
    try {
      const data = await this.apiRequest('favorite/getUserFavorites', { type: 'albums', limit: '50' });
      const albums = (data.albums?.items || []).map((a: any) => this.mapAlbum(a));
      return { items: albums, total: data.albums?.total || 0 };
    } catch { return { items: [] as Album[], total: 0 }; }
  }

  async getAlbum(id: string): Promise<Album | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const qobuzId = id.replace('qobuz:', '');
      const data = await this.apiRequest('album/get', { album_id: qobuzId });
      return this.mapAlbum(data);
    } catch { return null; }
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const qobuzId = albumId.replace('qobuz:', '');
      const data = await this.apiRequest('album/get', { album_id: qobuzId });
      return (data.tracks?.items || []).map((t: any) => this.mapTrack(t, data));
    } catch { return []; }
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const qobuzId = artistId.replace('qobuz:', '');
      const data = await this.apiRequest('artist/get', { artist_id: qobuzId, extra: 'albums', limit: '50' });
      return (data.albums?.items || []).map((a: any) => this.mapAlbum(a));
    } catch { return []; }
  }

  async search(query: string, limit = 10): Promise<SearchResults> {
    if (!this.auth.isAuthenticated) return { artists: [], albums: [], tracks: [], playlists: [] };
    try {
      const data = await this.apiRequest('catalog/search', { query, limit: String(limit) });
      return {
        artists: (data.artists?.items || []).filter((a: any) => a?.id).map((a: any) => this.mapArtist(a)),
        albums: (data.albums?.items || []).filter((a: any) => a?.id).map((a: any) => this.mapAlbum(a)),
        tracks: (data.tracks?.items || []).filter((t: any) => t?.id).map((t: any) => this.mapTrack(t)),
        playlists: [],
      };
    } catch (err) {
      logger.error(`Qobuz search failed: ${err}`);
      return { artists: [], albums: [], tracks: [], playlists: [] };
    }
  }

  async getStreamUrl(trackId: string): Promise<string | null> {
    if (!this.auth.isAuthenticated) return null;
    try {
      const qobuzId = trackId.replace('qobuz:', '');
      // format_id: 27 = FLAC 24-bit, 7 = FLAC 16-bit, 5 = MP3 320
      const data = await this.apiRequest('track/getFileUrl', {
        track_id: qobuzId,
        format_id: '27', // Try hi-res first
        intent: 'stream',
      });
      return data.url || null;
    } catch {
      // Fallback to lower quality
      try {
        const qobuzId = trackId.replace('qobuz:', '');
        const data = await this.apiRequest('track/getFileUrl', {
          track_id: qobuzId,
          format_id: '5',
          intent: 'stream',
        });
        return data.url || null;
      } catch {
        return null;
      }
    }
  }

  async getPlaylists(): Promise<Playlist[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const data = await this.apiRequest('playlist/getUserPlaylists', { limit: '50' });
      return (data.playlists?.items || []).map((p: any) => this.mapPlaylist(p));
    } catch { return []; }
  }

  async getPlaylistTracks(playlistId: string): Promise<Track[]> {
    if (!this.auth.isAuthenticated) return [];
    try {
      const qobuzId = playlistId.replace('qobuz:', '');
      const data = await this.apiRequest('playlist/get', { playlist_id: qobuzId, extra: 'tracks', limit: '100' });
      return (data.tracks?.items || []).map((t: any) => this.mapTrack(t));
    } catch { return []; }
  }

  // ─── Mappers ─────────────────────────────────────────────────

  private mapArtist(data: any): Artist {
    return {
      id: `qobuz:${data.id}`,
      name: data.name,
      imageUrl: data.image?.large || data.image?.medium || data.picture,
      source: 'qobuz',
    };
  }

  private mapAlbum(data: any): Album {
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

  private mapTrack(data: any, album?: any): Track {
    return {
      id: `qobuz:${data.id}`,
      title: data.title,
      albumId: `qobuz:${(album || data.album)?.id || ''}`,
      albumTitle: (album || data.album)?.title || '',
      artistId: `qobuz:${data.performer?.id || data.artist?.id || ''}`,
      artistName: data.performer?.name || data.artist?.name || 'Unknown',
      trackNumber: data.track_number,
      duration: data.duration,
      sampleRate: data.maximum_sampling_rate ? data.maximum_sampling_rate * 1000 : undefined,
      bitDepth: data.maximum_bit_depth,
      source: 'qobuz',
    };
  }

  private mapPlaylist(data: any): Playlist {
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

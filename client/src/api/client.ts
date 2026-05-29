import type { Track, RadioStation } from '@audioserver/shared';
import { API_BASE, STORAGE_KEYS } from '../constants.js';

// Fase 1 status: argument types are typed; return types are still `any` because
// many callers use ad-hoc shapes (FavTrack, HistoryEntry, PaginatedResponse, etc.)
// that don't yet align with @audioserver/shared. Tightening returns + migrating
// callers is fase 2 (stability) work — the local interfaces below document the
// expected shape so the migration has a target.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResult = any;

/**
 * Thrown by fetchApi on non-2xx responses. Carries the HTTP status and the
 * server's structured error payload (when available) so callers can react
 * differently to 401/403/404 vs. generic 5xx.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.statusCode === 401;
  }

  get isForbidden(): boolean {
    return this.statusCode === 403;
  }

  get isNotFound(): boolean {
    return this.statusCode === 404;
  }
}

// Listeners that get notified of every ApiError. NowPlayingBar / a toast
// provider can subscribe to show a unified UI without each call site adding
// its own try/catch.
type ErrorListener = (err: ApiError) => void;
const errorListeners = new Set<ErrorListener>();

export function onApiError(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem(STORAGE_KEYS.authToken);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
      message?: string;
      requestId?: string;
    } | null;
    const err = new ApiError(
      body?.message || body?.error || res.statusText || `API error ${res.status}`,
      res.status,
      body?.error,
      body?.requestId,
    );
    for (const l of errorListeners) {
      try {
        l(err);
      } catch {
        // swallow listener errors so one bad subscriber doesn't poison the rest
      }
    }
    throw err;
  }
  return res.json();
}

// ─── Stream token cache ──────────────────────────────────────────
// <img>/<audio> tags cannot send Authorization headers, so we attach a
// session-scoped HMAC token via ?t=. Token TTL is 1h server-side; we refresh
// 5min early so in-flight requests never hit a 401.
let streamToken: string | null = null;
let streamTokenExpiresAt = 0;
let streamTokenInflight: Promise<string> | null = null;

async function fetchStreamToken(): Promise<string> {
  const res = await fetchApi<{ data: { token: string; expiresIn: number } }>('/auth/stream-token');
  streamToken = res.data.token;
  streamTokenExpiresAt = Date.now() + (res.data.expiresIn - 300) * 1000;
  return streamToken;
}

export async function ensureStreamToken(): Promise<string> {
  if (streamToken && Date.now() < streamTokenExpiresAt) return streamToken;
  if (!streamTokenInflight) {
    streamTokenInflight = fetchStreamToken().finally(() => {
      streamTokenInflight = null;
    });
  }
  return streamTokenInflight;
}

export function clearStreamToken(): void {
  streamToken = null;
  streamTokenExpiresAt = 0;
}

function withToken(url: string): string {
  if (!streamToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${encodeURIComponent(streamToken)}`;
}

// ─── Documented response shapes (used as migration target in fase 2) ──
// These interfaces describe what each endpoint *will* return when callers
// are migrated to use shared types. Currently they're informational only.

export interface LibraryStats {
  artists: number;
  albums: number;
  tracks: number;
}
export interface ScanStatus {
  state: 'idle' | 'discovering' | 'scanning' | 'cleaning' | 'done' | 'error';
  filesDiscovered: number;
  filesScanned: number;
  errors: number;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface SmartPlaylistRule {
  field: 'genre' | 'year' | 'format' | 'sampleRate' | 'bitDepth' | 'artistName';
  operator: 'equals' | 'contains' | 'greaterThan' | 'lessThan' | 'between';
  value: string;
  value2?: string;
}

export const api = {
  // ─── Library ────────────────────────────────────────────────
  getStats: (): Promise<ApiResult> => fetchApi('/library/stats'),
  getArtists: (page = 1, limit = 50): Promise<ApiResult> =>
    fetchApi(`/library/artists?page=${page}&limit=${limit}`),
  getArtist: (id: string): Promise<ApiResult> => fetchApi(`/library/artists/${id}`),
  getArtistAlbums: (id: string): Promise<ApiResult> => fetchApi(`/library/artists/${id}/albums`),
  getAlbums: (page = 1, limit = 50): Promise<ApiResult> =>
    fetchApi(`/library/albums?page=${page}&limit=${limit}`),
  getAlbum: (id: string): Promise<ApiResult> => fetchApi(`/library/albums/${id}`),
  getAlbumTracks: (id: string): Promise<ApiResult> => fetchApi(`/library/albums/${id}/tracks`),
  getTracks: (page = 1, limit = 100): Promise<ApiResult> =>
    fetchApi(`/library/tracks?page=${page}&limit=${limit}`),
  search: (q: string, limit = 20): Promise<ApiResult> =>
    fetchApi(`/library/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  scanLibrary: (): Promise<ApiResult> => fetchApi('/library/scan', { method: 'POST' }),
  getScanStatus: (): Promise<ApiResult> => fetchApi('/library/scan/status'),

  // ─── Devices ────────────────────────────────────────────────
  getDevices: (): Promise<ApiResult> => fetchApi('/devices'),
  discoverDevices: (): Promise<ApiResult> => fetchApi('/devices/discover'),
  getDeviceStatus: (id: string): Promise<ApiResult> => fetchApi(`/devices/${id}/status`),
  devicePlay: (
    id: string,
    streamUrl: string,
    metadata?: Record<string, unknown>,
    trackId?: string,
  ): Promise<ApiResult> =>
    fetchApi(`/devices/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ streamUrl, metadata, trackId }),
    }),
  deviceSetNext: (
    id: string,
    streamUrl: string,
    metadata?: Record<string, unknown>,
  ): Promise<ApiResult> =>
    fetchApi(`/devices/${id}/set-next`, {
      method: 'POST',
      body: JSON.stringify({ streamUrl, metadata }),
    }),
  devicePause: (id: string): Promise<ApiResult> =>
    fetchApi(`/devices/${id}/pause`, { method: 'POST' }),
  deviceResume: (id: string): Promise<ApiResult> =>
    fetchApi(`/devices/${id}/resume`, { method: 'POST' }),
  deviceStop: (id: string): Promise<ApiResult> =>
    fetchApi(`/devices/${id}/stop`, { method: 'POST' }),
  deviceVolume: (id: string, volume: number): Promise<ApiResult> =>
    fetchApi(`/devices/${id}/volume`, { method: 'POST', body: JSON.stringify({ volume }) }),

  // ─── Auth ───────────────────────────────────────────────────
  register: (username: string, password: string): Promise<ApiResult> =>
    fetchApi('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string): Promise<ApiResult> =>
    fetchApi('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  getMe: (): Promise<ApiResult> => fetchApi('/auth/me'),

  // ─── Users (admin) ──────────────────────────────────────────
  getUsers: (): Promise<ApiResult> => fetchApi('/auth/users'),
  createUser: (username: string, password: string, role?: string): Promise<ApiResult> =>
    fetchApi('/auth/users/create', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    }),
  deleteUser: (id: string): Promise<ApiResult> =>
    fetchApi(`/auth/users/${id}`, { method: 'DELETE' }),

  // ─── Playback ──────────────────────────────────────────────
  getNowPlaying: (): Promise<ApiResult> => fetchApi('/playback/now-playing'),
  getQueue: (): Promise<ApiResult> => fetchApi('/playback/queue'),
  addToQueue: (track: Partial<Track> | object): Promise<ApiResult> =>
    fetchApi('/playback/queue/add', { method: 'POST', body: JSON.stringify({ track }) }),
  clearQueue: (): Promise<ApiResult> => fetchApi('/playback/queue/clear', { method: 'POST' }),
  removeFromQueue: (index: number): Promise<ApiResult> =>
    fetchApi('/playback/queue/remove', { method: 'POST', body: JSON.stringify({ index }) }),
  moveInQueue: (from: number, to: number): Promise<ApiResult> =>
    fetchApi('/playback/queue/move', { method: 'POST', body: JSON.stringify({ from, to }) }),
  play: (track: Partial<Track> | object, deviceId?: string): Promise<ApiResult> =>
    fetchApi('/playback/play', { method: 'POST', body: JSON.stringify({ track, deviceId }) }),
  pause: (): Promise<ApiResult> => fetchApi('/playback/pause', { method: 'POST' }),
  stop: (): Promise<ApiResult> => fetchApi('/playback/stop', { method: 'POST' }),
  setVolume: (volume: number): Promise<ApiResult> =>
    fetchApi('/playback/volume', { method: 'POST', body: JSON.stringify({ volume }) }),

  // ─── History & Favorites ───────────────────────────────────
  recordPlay: (trackId: string, albumId: string, artistId: string): Promise<ApiResult> =>
    fetchApi('/history/played', {
      method: 'POST',
      body: JSON.stringify({ trackId, albumId, artistId }),
    }),
  getRecentAlbums: (): Promise<ApiResult> => fetchApi('/history/recent'),
  getTopArtists: (): Promise<ApiResult> => fetchApi('/history/top-artists'),
  getHistoryTracks: (page = 1, limit = 50): Promise<ApiResult> =>
    fetchApi(`/history/tracks?page=${page}&limit=${limit}`),
  getFavoriteTracks: (): Promise<ApiResult> => fetchApi('/history/favorites/tracks'),
  toggleFavorite: (itemType: string, itemId: string): Promise<ApiResult> =>
    fetchApi('/history/favorites', {
      method: 'POST',
      body: JSON.stringify({ itemType, itemId }),
    }),
  getFavorites: (type: string): Promise<ApiResult> => fetchApi(`/history/favorites?type=${type}`),
  checkFavorite: (type: string, id: string): Promise<ApiResult> =>
    fetchApi(`/history/favorites/check?type=${type}&id=${id}`),

  // ─── Spotify Connect ────────────────────────────────────────
  spotifyConnectDevices: (): Promise<ApiResult> => fetchApi('/providers/spotify/connect/devices'),
  spotifyConnectState: (): Promise<ApiResult> => fetchApi('/providers/spotify/connect/state'),
  spotifyConnectPlay: (trackUri: string, deviceId?: string): Promise<ApiResult> =>
    fetchApi('/providers/spotify/connect/play', {
      method: 'POST',
      body: JSON.stringify({ trackUri, deviceId }),
    }),
  spotifyConnectPause: (deviceId?: string): Promise<ApiResult> =>
    fetchApi('/providers/spotify/connect/pause', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),
  spotifyConnectResume: (deviceId?: string): Promise<ApiResult> =>
    fetchApi('/providers/spotify/connect/resume', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),
  spotifyConnectNext: (deviceId?: string): Promise<ApiResult> =>
    fetchApi('/providers/spotify/connect/next', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),
  spotifyConnectPrevious: (deviceId?: string): Promise<ApiResult> =>
    fetchApi('/providers/spotify/connect/previous', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),
  spotifyConnectVolume: (volume: number, deviceId?: string): Promise<ApiResult> =>
    fetchApi('/providers/spotify/connect/volume', {
      method: 'POST',
      body: JSON.stringify({ volume, deviceId }),
    }),

  // ─── Librespot ──────────────────────────────────────────────
  librespotStatus: (): Promise<ApiResult> => fetchApi('/librespot/status'),
  librespotStart: (username: string, password: string): Promise<ApiResult> =>
    fetchApi('/librespot/start', { method: 'POST', body: JSON.stringify({ username, password }) }),
  librespotStop: (): Promise<ApiResult> => fetchApi('/librespot/stop', { method: 'POST' }),
  librespotPlayToDevice: (trackUri: string, deviceId: string): Promise<ApiResult> =>
    fetchApi('/librespot/play-to-device', {
      method: 'POST',
      body: JSON.stringify({ trackUri, deviceId }),
    }),

  // ─── Playlists ──────────────────────────────────────────────
  getPlaylists: (): Promise<ApiResult> => fetchApi('/playlists'),
  getPlaylist: (id: string): Promise<ApiResult> => fetchApi(`/playlists/${id}`),
  createPlaylist: (name: string, description?: string): Promise<ApiResult> =>
    fetchApi('/playlists', { method: 'POST', body: JSON.stringify({ name, description }) }),
  updatePlaylist: (id: string, data: { name?: string; description?: string }): Promise<ApiResult> =>
    fetchApi(`/playlists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePlaylist: (id: string): Promise<ApiResult> =>
    fetchApi(`/playlists/${id}`, { method: 'DELETE' }),
  getPlaylistTracks: (id: string): Promise<ApiResult> => fetchApi(`/playlists/${id}/tracks`),
  addToPlaylist: (playlistId: string, trackId: string): Promise<ApiResult> =>
    fetchApi(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackId }),
    }),
  removeFromPlaylist: (playlistId: string, trackId: string): Promise<ApiResult> =>
    fetchApi(`/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' }),
  reorderPlaylist: (playlistId: string, trackIds: string[]): Promise<ApiResult> =>
    fetchApi(`/playlists/${playlistId}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ trackIds }),
    }),
  exportPlaylist: (playlistId: string): string => `${API_BASE}/playlists/${playlistId}/export`,
  importPlaylist: (name: string, content: string): Promise<ApiResult> =>
    fetchApi('/playlists/import', { method: 'POST', body: JSON.stringify({ name, content }) }),

  // ─── Recently added ─────────────────────────────────────────
  getRecentlyAdded: (limit = 20): Promise<ApiResult> =>
    fetchApi(`/library/albums/recent?limit=${limit}`),

  // ─── Genres ─────────────────────────────────────────────────
  getGenres: (): Promise<ApiResult> => fetchApi('/library/genres'),
  getGenreAlbums: (genre: string, page = 1, limit = 50): Promise<ApiResult> =>
    fetchApi(`/library/genres/${encodeURIComponent(genre)}/albums?page=${page}&limit=${limit}`),

  // ─── Smart Playlists ────────────────────────────────────────
  getSmartPlaylists: (): Promise<ApiResult> => fetchApi('/smart-playlists'),
  createSmartPlaylist: (name: string, rules: unknown[]): Promise<ApiResult> =>
    fetchApi('/smart-playlists', { method: 'POST', body: JSON.stringify({ name, rules }) }),
  getSmartPlaylistTracks: (id: string): Promise<ApiResult> =>
    fetchApi(`/smart-playlists/${id}/tracks`),
  updateSmartPlaylist: (
    id: string,
    data: { name?: string; rules?: unknown[] },
  ): Promise<ApiResult> =>
    fetchApi(`/smart-playlists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSmartPlaylist: (id: string): Promise<ApiResult> =>
    fetchApi(`/smart-playlists/${id}`, { method: 'DELETE' }),

  // ─── Health ─────────────────────────────────────────────────
  getHealth: (): Promise<ApiResult> => fetchApi('/health'),

  // ─── Providers ──────────────────────────────────────────────
  getProviderStatus: (): Promise<ApiResult> => fetchApi('/providers/status'),
  providerSearch: (q: string): Promise<ApiResult> =>
    fetchApi(`/providers/search?q=${encodeURIComponent(q)}`),
  providerAuthInit: (provider: string, redirectUri: string): Promise<ApiResult> =>
    fetchApi(`/providers/${provider}/auth/init`, {
      method: 'POST',
      body: JSON.stringify({ redirectUri }),
    }),
  providerAuthCallback: (provider: string, code: string, redirectUri: string): Promise<ApiResult> =>
    fetchApi(`/providers/${provider}/auth/callback`, {
      method: 'POST',
      body: JSON.stringify({ code, redirectUri }),
    }),
  providerAuthLogout: (provider: string): Promise<ApiResult> =>
    fetchApi(`/providers/${provider}/auth/logout`, { method: 'POST' }),
  qobuzLogin: (username: string, password: string): Promise<ApiResult> =>
    fetchApi('/providers/qobuz/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  // ─── Tidal/Spotify/Qobuz ────────────────────────────────────
  getTidalAlbum: (id: string): Promise<ApiResult> => fetchApi(`/providers/tidal/albums/${id}`),
  getTidalAlbumTracks: (id: string): Promise<ApiResult> =>
    fetchApi(`/providers/tidal/albums/${id}/tracks`),
  getTidalStreamUrl: (trackId: string): Promise<ApiResult> =>
    fetchApi(`/providers/tidal/tracks/${trackId}/stream`),
  getTidalPlaylists: (): Promise<ApiResult> => fetchApi('/providers/tidal/playlists'),
  getTidalPlaylistTracks: (id: string): Promise<ApiResult> =>
    fetchApi(`/providers/tidal/playlists/${id}/tracks`),
  getTidalFavoriteAlbums: (): Promise<ApiResult> => fetchApi('/providers/tidal/favorites/albums'),
  getTidalFavoriteTracks: (): Promise<ApiResult> => fetchApi('/providers/tidal/favorites/tracks'),
  getTidalFavoriteArtists: (): Promise<ApiResult> => fetchApi('/providers/tidal/favorites/artists'),
  getSpotifyAlbum: (id: string): Promise<ApiResult> => fetchApi(`/providers/spotify/albums/${id}`),
  getSpotifyAlbumTracks: (id: string): Promise<ApiResult> =>
    fetchApi(`/providers/spotify/albums/${id}/tracks`),
  getQobuzAlbum: (id: string): Promise<ApiResult> => fetchApi(`/providers/qobuz/albums/${id}`),
  getQobuzAlbumTracks: (id: string): Promise<ApiResult> =>
    fetchApi(`/providers/qobuz/albums/${id}/tracks`),
  getQobuzStreamUrl: (trackId: string): Promise<ApiResult> =>
    fetchApi(`/providers/qobuz/tracks/${trackId}/stream`),

  // ─── Radio ──────────────────────────────────────────────────
  getRadioFeatured: (): Promise<ApiResult> => fetchApi('/radio/featured'),
  searchRadio: (q: string, country = 'NL', tag?: string): Promise<ApiResult> => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (country) params.set('country', country);
    if (tag) params.set('tag', tag);
    return fetchApi(`/radio/search?${params}`);
  },
  getRadioStation: (uuid: string): Promise<ApiResult> => fetchApi(`/radio/stations/${uuid}`),
  getRadioStream: (uuid: string): Promise<ApiResult> => fetchApi(`/radio/stations/${uuid}/stream`),
  cacheRadioStation: (station: RadioStation | Record<string, unknown>): Promise<ApiResult> =>
    fetchApi('/radio/stations/cache', { method: 'POST', body: JSON.stringify(station) }),

  // ─── Lyrics ─────────────────────────────────────────────────
  getLyrics: (trackId: string): Promise<ApiResult> => fetchApi(`/library/tracks/${trackId}/lyrics`),

  // ─── Scrobbling ─────────────────────────────────────────────
  getScrobbleConfig: (): Promise<ApiResult> => fetchApi('/scrobble/config'),
  getLastfmAuthUrl: (): Promise<ApiResult> => fetchApi('/scrobble/lastfm/auth-url'),
  authenticateLastfm: (token: string): Promise<ApiResult> =>
    fetchApi('/scrobble/lastfm/auth', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnectLastfm: (): Promise<ApiResult> =>
    fetchApi('/scrobble/lastfm/disconnect', { method: 'POST' }),
  authenticateListenbrainz: (token: string): Promise<ApiResult> =>
    fetchApi('/scrobble/listenbrainz/auth', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnectListenbrainz: (): Promise<ApiResult> =>
    fetchApi('/scrobble/listenbrainz/disconnect', { method: 'POST' }),

  // ─── Cover art fetch ────────────────────────────────────────
  fetchCovers: (): Promise<ApiResult> => fetchApi('/library/covers/fetch', { method: 'POST' }),
  getCoverFetchStatus: (): Promise<ApiResult> => fetchApi('/library/covers/fetch/status'),
  fetchArtistImages: (): Promise<ApiResult> =>
    fetchApi('/library/artists/images/fetch', { method: 'POST' }),
  getArtistImageFetchStatus: (): Promise<ApiResult> =>
    fetchApi('/library/artists/images/fetch/status'),

  // ─── Librespot (alias) ──────────────────────────────────────
  getLibrespotStatus: (): Promise<ApiResult> => fetchApi('/librespot/status'),

  // ─── URLs (used by <img>/<audio> tags) ──────────────────────
  // Embed a stream-token (?t=...) when one has been fetched. Call `ensureStreamToken()`
  // once at app startup (e.g. in App.tsx) to prime the cache.
  getStreamUrl: (trackId: string): string =>
    withToken(`${API_BASE}/library/tracks/${trackId}/stream`),
  getAlbumCoverUrl: (albumId: string): string =>
    withToken(`${API_BASE}/library/albums/${albumId}/cover`),
  getArtistImageUrl: (artistId: string): string =>
    withToken(`${API_BASE}/library/artists/${artistId}/image`),
  getTrackCoverUrl: (trackId: string): string =>
    withToken(`${API_BASE}/library/tracks/${trackId}/cover`),
};

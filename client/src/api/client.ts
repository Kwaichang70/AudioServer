import type { Album, Artist, RadioStation, Track } from '@audioserver/shared';
import { API_BASE, STORAGE_KEYS } from '../constants.js';
import type {
  ApiResponse,
  AuthResult,
  DeviceStatusResponse,
  DevicesResponse,
  FavoriteResponseMap,
  FavoriteTrack,
  FavoriteType,
  FetchStatus,
  HealthResponse,
  HistoryEntry,
  LastfmAuthUrl,
  LibrespotStatus,
  LibraryAlbum,
  LibraryArtist,
  LibraryStats,
  LibraryTrack,
  ListenBrainzDiscover,
  ListenBrainzStats,
  LocalSearchResults,
  OkResponse,
  PaginatedResponse,
  PlaybackQueueResponse,
  PlaybackStateResponse,
  PlaylistImportMeta,
  ProviderAuthResult,
  ProviderSearchResponse,
  ProviderStatuses,
  QobuzStreamInfo,
  RadioStreamInfo,
  RecentAlbum,
  ScanStatus,
  ScrobbleConfig,
  SimilarArtistsResult,
  SmartPlaylist,
  SpotifyConnectDevice,
  SpotifyPlaybackState,
  SpotifyToken,
  StoredPlaylist,
  TopArtist,
  UserAccount,
  LyricsResult,
} from './types.js';

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
let streamTokenTimer: ReturnType<typeof setTimeout> | null = null;

// withToken() is synchronous (it runs during render), so the cached token must
// be kept fresh proactively: without this, every cover <img> and local stream
// silently starts failing ~1h into a listening session.
function scheduleStreamTokenRefresh(delayMs: number): void {
  if (streamTokenTimer) clearTimeout(streamTokenTimer);
  streamTokenTimer = setTimeout(() => {
    if (!localStorage.getItem(STORAGE_KEYS.authToken)) return; // logged out
    fetchStreamToken().catch(() => scheduleStreamTokenRefresh(60_000));
  }, delayMs);
}

async function fetchStreamToken(): Promise<string> {
  const res = await fetchApi<{ data: { token: string; expiresIn: number } }>('/auth/stream-token');
  streamToken = res.data.token;
  streamTokenExpiresAt = Date.now() + (res.data.expiresIn - 300) * 1000;
  // Renew well before the cached copy goes stale (timers in background tabs
  // may be throttled; the visibilitychange hook below covers that gap).
  scheduleStreamTokenRefresh(Math.max((res.data.expiresIn - 600) * 1000, 60_000));
  return streamToken;
}

// Returning to a tab that slept past the renewal timer: refresh immediately.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && streamToken && Date.now() >= streamTokenExpiresAt) {
      ensureStreamToken().catch(() => {});
    }
  });
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
  if (streamTokenTimer) {
    clearTimeout(streamTokenTimer);
    streamTokenTimer = null;
  }
}

function withToken(url: string): string {
  if (!streamToken) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${encodeURIComponent(streamToken)}`;
}

export interface SmartPlaylistRule {
  field: 'genre' | 'year' | 'format' | 'sampleRate' | 'bitDepth' | 'artistName';
  operator: 'equals' | 'contains' | 'greaterThan' | 'lessThan' | 'between';
  value: string;
  value2?: string;
}

export const api = {
  // ─── Library ────────────────────────────────────────────────
  getStats: (): Promise<ApiResponse<LibraryStats>> => fetchApi('/library/stats'),
  getArtists: (page = 1, limit = 50): Promise<PaginatedResponse<LibraryArtist>> =>
    fetchApi(`/library/artists?page=${page}&limit=${limit}`),
  getArtist: (id: string): Promise<ApiResponse<LibraryArtist>> =>
    fetchApi(`/library/artists/${id}`),
  getArtistAlbums: (id: string): Promise<ApiResponse<LibraryAlbum[]>> =>
    fetchApi(`/library/artists/${id}/albums`),
  getSimilarArtists: (id: string): Promise<ApiResponse<SimilarArtistsResult>> =>
    fetchApi(`/library/artists/${id}/similar`),
  getAlbums: (page = 1, limit = 50): Promise<PaginatedResponse<LibraryAlbum>> =>
    fetchApi(`/library/albums?page=${page}&limit=${limit}`),
  getAlbum: (id: string): Promise<ApiResponse<LibraryAlbum>> => fetchApi(`/library/albums/${id}`),
  getAlbumTracks: (id: string): Promise<ApiResponse<LibraryTrack[]>> =>
    fetchApi(`/library/albums/${id}/tracks`),
  getTracks: (page = 1, limit = 100): Promise<PaginatedResponse<LibraryTrack>> =>
    fetchApi(`/library/tracks?page=${page}&limit=${limit}`),
  search: (q: string, limit = 20): Promise<ApiResponse<LocalSearchResults>> =>
    fetchApi(`/library/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  scanLibrary: (): Promise<ApiResponse<ScanStatus>> =>
    fetchApi('/library/scan', { method: 'POST' }),
  getScanStatus: (): Promise<ApiResponse<ScanStatus>> => fetchApi('/library/scan/status'),

  // ─── Devices ────────────────────────────────────────────────
  getDevices: (): Promise<DevicesResponse> => fetchApi('/devices'),
  discoverDevices: (): Promise<DevicesResponse> => fetchApi('/devices/discover'),
  getDeviceStatus: (id: string): Promise<DeviceStatusResponse> => fetchApi(`/devices/${id}/status`),
  devicePlay: (
    id: string,
    streamUrl: string,
    metadata?: Record<string, unknown>,
    trackId?: string,
  ): Promise<OkResponse> =>
    fetchApi(`/devices/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ streamUrl, metadata, trackId }),
    }),
  deviceSetNext: (
    id: string,
    streamUrl: string,
    metadata?: Record<string, unknown>,
  ): Promise<OkResponse> =>
    fetchApi(`/devices/${id}/set-next`, {
      method: 'POST',
      body: JSON.stringify({ streamUrl, metadata }),
    }),
  devicePause: (id: string): Promise<OkResponse> =>
    fetchApi(`/devices/${id}/pause`, { method: 'POST' }),
  deviceResume: (id: string): Promise<OkResponse> =>
    fetchApi(`/devices/${id}/resume`, { method: 'POST' }),
  deviceStop: (id: string): Promise<OkResponse> =>
    fetchApi(`/devices/${id}/stop`, { method: 'POST' }),
  deviceVolume: (id: string, volume: number): Promise<OkResponse> =>
    fetchApi(`/devices/${id}/volume`, { method: 'POST', body: JSON.stringify({ volume }) }),

  // ─── Auth ───────────────────────────────────────────────────
  register: (username: string, password: string): Promise<ApiResponse<AuthResult>> =>
    fetchApi('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string): Promise<ApiResponse<AuthResult>> =>
    fetchApi('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  getMe: (): Promise<ApiResponse<UserAccount | null>> => fetchApi('/auth/me'),

  // ─── Users (admin) ──────────────────────────────────────────
  getUsers: (): Promise<ApiResponse<UserAccount[]>> => fetchApi('/auth/users'),
  createUser: (
    username: string,
    password: string,
    role?: string,
  ): Promise<ApiResponse<UserAccount>> =>
    fetchApi('/auth/users/create', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    }),
  deleteUser: (id: string): Promise<OkResponse> =>
    fetchApi(`/auth/users/${id}`, { method: 'DELETE' }),

  // ─── Playback ──────────────────────────────────────────────
  getNowPlaying: (): Promise<PlaybackStateResponse> => fetchApi('/playback/now-playing'),
  getQueue: (): Promise<PlaybackQueueResponse> => fetchApi('/playback/queue'),
  addToQueue: (track: Partial<Track> | object): Promise<PlaybackQueueResponse> =>
    fetchApi('/playback/queue/add', { method: 'POST', body: JSON.stringify({ track }) }),
  // Hand the whole queue to the server. For external local devices the server
  // then drives playback itself (auto-advance from the NAS), so the album
  // keeps playing when this client sleeps.
  setServerQueue: (
    tracks: object[],
    startIndex: number,
    deviceId: string,
    shuffle: boolean,
    repeat: 'off' | 'all' | 'one',
  ): Promise<OkResponse> =>
    fetchApi('/playback/queue/set', {
      method: 'POST',
      body: JSON.stringify({ tracks, startIndex, deviceId, shuffle, repeat }),
    }),
  clearQueue: (): Promise<PlaybackQueueResponse> =>
    fetchApi('/playback/queue/clear', { method: 'POST' }),
  removeFromQueue: (index: number): Promise<PlaybackQueueResponse> =>
    fetchApi('/playback/queue/remove', { method: 'POST', body: JSON.stringify({ index }) }),
  moveInQueue: (from: number, to: number): Promise<PlaybackQueueResponse> =>
    fetchApi('/playback/queue/move', { method: 'POST', body: JSON.stringify({ from, to }) }),
  play: (track: Partial<Track> | object, deviceId?: string): Promise<PlaybackStateResponse> =>
    fetchApi('/playback/play', { method: 'POST', body: JSON.stringify({ track, deviceId }) }),
  pause: (): Promise<PlaybackStateResponse> => fetchApi('/playback/pause', { method: 'POST' }),
  stop: (): Promise<PlaybackStateResponse> => fetchApi('/playback/stop', { method: 'POST' }),
  setVolume: (volume: number): Promise<PlaybackStateResponse> =>
    fetchApi('/playback/volume', { method: 'POST', body: JSON.stringify({ volume }) }),

  // ─── History & Favorites ───────────────────────────────────
  recordPlay: (trackId: string, albumId: string, artistId: string): Promise<OkResponse> =>
    fetchApi('/history/played', {
      method: 'POST',
      body: JSON.stringify({ trackId, albumId, artistId }),
    }),
  getRecentAlbums: (): Promise<ApiResponse<RecentAlbum[]>> => fetchApi('/history/recent'),
  getTopArtists: (): Promise<ApiResponse<TopArtist[]>> => fetchApi('/history/top-artists'),
  getHistoryTracks: (page = 1, limit = 50): Promise<PaginatedResponse<HistoryEntry>> =>
    fetchApi(`/history/tracks?page=${page}&limit=${limit}`),
  getFavoriteTracks: (): Promise<ApiResponse<FavoriteTrack[]>> =>
    fetchApi('/history/favorites/tracks'),
  toggleFavorite: (
    itemType: FavoriteType,
    itemId: string,
  ): Promise<ApiResponse<{ favorited: boolean }>> =>
    fetchApi('/history/favorites', {
      method: 'POST',
      body: JSON.stringify({ itemType, itemId }),
    }),
  // Track favorites use the dedicated enriched endpoint above; the generic
  // route returns raw favorite rows for `track` and is therefore intentionally
  // limited to the entity types it actually hydrates.
  getFavorites: <T extends Exclude<FavoriteType, 'track'>>(
    type: T,
  ): Promise<ApiResponse<FavoriteResponseMap[T][]>> => fetchApi(`/history/favorites?type=${type}`),
  checkFavorite: (type: FavoriteType, id: string): Promise<ApiResponse<{ favorited: boolean }>> =>
    fetchApi(`/history/favorites/check?type=${type}&id=${id}`),

  // ─── Spotify Connect ────────────────────────────────────────
  // Short-lived access token for the browser Web Playback SDK.
  spotifyToken: (): Promise<ApiResponse<SpotifyToken>> => fetchApi('/providers/spotify/token'),
  spotifyConnectDevices: (): Promise<ApiResponse<SpotifyConnectDevice[]>> =>
    fetchApi('/providers/spotify/connect/devices'),
  spotifyConnectState: (): Promise<ApiResponse<SpotifyPlaybackState | null>> =>
    fetchApi('/providers/spotify/connect/state'),
  spotifyConnectPlay: (trackUri: string, deviceId?: string): Promise<OkResponse> =>
    fetchApi('/providers/spotify/connect/play', {
      method: 'POST',
      body: JSON.stringify({ trackUri, deviceId }),
    }),
  // Play a whole context (album/playlist) starting at offsetUri. Spotify then
  // advances tracks natively on the target device — playback continues even
  // when no AudioServer client is awake.
  spotifyConnectPlayContext: (
    contextUri: string,
    deviceId?: string,
    offsetUri?: string,
  ): Promise<OkResponse> =>
    fetchApi('/providers/spotify/connect/play', {
      method: 'POST',
      body: JSON.stringify({
        contextUri,
        deviceId,
        offset: offsetUri ? { uri: offsetUri } : undefined,
      }),
    }),
  spotifyConnectPause: (deviceId?: string): Promise<OkResponse> =>
    fetchApi('/providers/spotify/connect/pause', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),
  spotifyConnectResume: (deviceId?: string): Promise<OkResponse> =>
    fetchApi('/providers/spotify/connect/resume', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),
  spotifyConnectNext: (deviceId?: string): Promise<OkResponse> =>
    fetchApi('/providers/spotify/connect/next', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),
  spotifyConnectPrevious: (deviceId?: string): Promise<OkResponse> =>
    fetchApi('/providers/spotify/connect/previous', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }),
  spotifyConnectVolume: (volume: number, deviceId?: string): Promise<OkResponse> =>
    fetchApi('/providers/spotify/connect/volume', {
      method: 'POST',
      body: JSON.stringify({ volume, deviceId }),
    }),

  // ─── Librespot ──────────────────────────────────────────────
  librespotStatus: (): Promise<ApiResponse<LibrespotStatus>> => fetchApi('/librespot/status'),
  librespotStart: (username: string, password: string): Promise<ApiResponse<{ started: true }>> =>
    fetchApi('/librespot/start', { method: 'POST', body: JSON.stringify({ username, password }) }),
  librespotStop: (): Promise<ApiResponse<{ stopped: true }>> =>
    fetchApi('/librespot/stop', { method: 'POST' }),
  librespotPlayToDevice: (
    trackUri: string,
    deviceId: string,
  ): Promise<ApiResponse<{ ok: true; streamUrl: string }>> =>
    fetchApi('/librespot/play-to-device', {
      method: 'POST',
      body: JSON.stringify({ trackUri, deviceId }),
    }),

  // ─── Playlists ──────────────────────────────────────────────
  getPlaylists: (): Promise<ApiResponse<StoredPlaylist[]>> => fetchApi('/playlists'),
  getPlaylist: (id: string): Promise<ApiResponse<StoredPlaylist>> => fetchApi(`/playlists/${id}`),
  createPlaylist: (name: string, description?: string): Promise<ApiResponse<StoredPlaylist>> =>
    fetchApi('/playlists', { method: 'POST', body: JSON.stringify({ name, description }) }),
  updatePlaylist: (
    id: string,
    data: { name?: string; description?: string },
  ): Promise<ApiResponse<StoredPlaylist>> =>
    fetchApi(`/playlists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePlaylist: (id: string): Promise<OkResponse> =>
    fetchApi(`/playlists/${id}`, { method: 'DELETE' }),
  getPlaylistTracks: (id: string): Promise<ApiResponse<LibraryTrack[]>> =>
    fetchApi(`/playlists/${id}/tracks`),
  addToPlaylist: (
    playlistId: string,
    trackId: string,
  ): Promise<ApiResponse<{ ok: true; trackCount: number }>> =>
    fetchApi(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackId }),
    }),
  removeFromPlaylist: (
    playlistId: string,
    trackId: string,
  ): Promise<ApiResponse<{ ok: true; trackCount: number }>> =>
    fetchApi(`/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' }),
  reorderPlaylist: (playlistId: string, trackIds: string[]): Promise<OkResponse> =>
    fetchApi(`/playlists/${playlistId}/reorder`, {
      method: 'POST',
      body: JSON.stringify({ trackIds }),
    }),
  exportPlaylist: (playlistId: string): string => `${API_BASE}/playlists/${playlistId}/export`,
  importPlaylist: (
    name: string,
    content: string,
  ): Promise<ApiResponse<StoredPlaylist, PlaylistImportMeta>> =>
    fetchApi('/playlists/import', { method: 'POST', body: JSON.stringify({ name, content }) }),

  // ─── Recently added ─────────────────────────────────────────
  getRecentlyAdded: (limit = 20): Promise<ApiResponse<LibraryAlbum[]>> =>
    fetchApi(`/library/albums/recent?limit=${limit}`),

  // ─── Genres ─────────────────────────────────────────────────
  getGenres: (): Promise<
    ApiResponse<Array<{ genre: string; albumCount: number; trackCount: number }>>
  > => fetchApi('/library/genres'),
  getGenreAlbums: (genre: string, page = 1, limit = 50): Promise<PaginatedResponse<LibraryAlbum>> =>
    fetchApi(`/library/genres/${encodeURIComponent(genre)}/albums?page=${page}&limit=${limit}`),

  // ─── Smart Playlists ────────────────────────────────────────
  getSmartPlaylists: (): Promise<ApiResponse<SmartPlaylist[]>> => fetchApi('/smart-playlists'),
  createSmartPlaylist: (name: string, rules: unknown[]): Promise<ApiResponse<SmartPlaylist>> =>
    fetchApi('/smart-playlists', { method: 'POST', body: JSON.stringify({ name, rules }) }),
  getSmartPlaylistTracks: (id: string): Promise<ApiResponse<LibraryTrack[]>> =>
    fetchApi(`/smart-playlists/${id}/tracks`),
  updateSmartPlaylist: (
    id: string,
    data: { name?: string; rules?: unknown[] },
  ): Promise<ApiResponse<SmartPlaylist>> =>
    fetchApi(`/smart-playlists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSmartPlaylist: (id: string): Promise<OkResponse> =>
    fetchApi(`/smart-playlists/${id}`, { method: 'DELETE' }),

  // ─── Health ─────────────────────────────────────────────────
  getHealth: (): Promise<HealthResponse> => fetchApi('/health'),

  // ─── Providers ──────────────────────────────────────────────
  getProviderStatus: (): Promise<ApiResponse<ProviderStatuses>> => fetchApi('/providers/status'),
  providerSearch: (q: string): Promise<ProviderSearchResponse> =>
    fetchApi(`/providers/search?q=${encodeURIComponent(q)}`),
  providerAuthInit: (
    provider: string,
    redirectUri: string,
  ): Promise<ApiResponse<{ authUrl: string }>> =>
    fetchApi(`/providers/${provider}/auth/init`, {
      method: 'POST',
      body: JSON.stringify({ redirectUri }),
    }),
  providerAuthCallback: (
    provider: string,
    code: string,
    redirectUri: string,
  ): Promise<ApiResponse<ProviderAuthResult>> =>
    fetchApi(`/providers/${provider}/auth/callback`, {
      method: 'POST',
      body: JSON.stringify({ code, redirectUri }),
    }),
  providerAuthLogout: (
    provider: string,
  ): Promise<ApiResponse<ProviderAuthResult | ProviderStatuses['qobuz']>> =>
    fetchApi(`/providers/${provider}/auth/logout`, { method: 'POST' }),
  qobuzLogin: (
    username: string,
    password: string,
  ): Promise<ApiResponse<ProviderStatuses['qobuz']>> =>
    fetchApi('/providers/qobuz/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  // ─── Tidal/Spotify/Qobuz ────────────────────────────────────
  getTidalAlbum: (id: string): Promise<ApiResponse<Album | null>> =>
    fetchApi(`/providers/tidal/albums/${id}`),
  getTidalAlbumTracks: (id: string): Promise<ApiResponse<Track[]>> =>
    fetchApi(`/providers/tidal/albums/${id}/tracks`),
  getTidalStreamUrl: (trackId: string): Promise<ApiResponse<never>> =>
    fetchApi(`/providers/tidal/tracks/${trackId}/stream`),
  getTidalPlaylists: (): Promise<ApiResponse<StoredPlaylist[]>> =>
    fetchApi('/providers/tidal/playlists'),
  getTidalPlaylistTracks: (id: string): Promise<ApiResponse<Track[]>> =>
    fetchApi(`/providers/tidal/playlists/${id}/tracks`),
  getTidalFavoriteAlbums: (): Promise<ApiResponse<Album[]>> =>
    fetchApi('/providers/tidal/favorites/albums'),
  getTidalFavoriteTracks: (): Promise<ApiResponse<Track[]>> =>
    fetchApi('/providers/tidal/favorites/tracks'),
  getTidalFavoriteArtists: (): Promise<ApiResponse<Artist[]>> =>
    fetchApi('/providers/tidal/favorites/artists'),
  getSpotifyAlbum: (id: string): Promise<ApiResponse<Album | null>> =>
    fetchApi(`/providers/spotify/albums/${id}`),
  getSpotifyAlbumTracks: (id: string): Promise<ApiResponse<Track[]>> =>
    fetchApi(`/providers/spotify/albums/${id}/tracks`),
  getQobuzAlbum: (id: string): Promise<ApiResponse<Album | null>> =>
    fetchApi(`/providers/qobuz/albums/${id}`),
  getQobuzAlbumTracks: (id: string): Promise<ApiResponse<Track[]>> =>
    fetchApi(`/providers/qobuz/albums/${id}/tracks`),
  getQobuzStreamUrl: (trackId: string): Promise<ApiResponse<QobuzStreamInfo>> =>
    fetchApi(`/providers/qobuz/tracks/${trackId}/stream`),

  // ─── Radio ──────────────────────────────────────────────────
  getRadioFeatured: (): Promise<ApiResponse<RadioStation[]>> => fetchApi('/radio/featured'),
  searchRadio: (q: string, country = 'NL', tag?: string): Promise<ApiResponse<RadioStation[]>> => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (country) params.set('country', country);
    if (tag) params.set('tag', tag);
    return fetchApi(`/radio/search?${params}`);
  },
  getRadioStation: (uuid: string): Promise<ApiResponse<RadioStation>> =>
    fetchApi(`/radio/stations/${uuid}`),
  getRadioStream: (uuid: string): Promise<ApiResponse<RadioStreamInfo>> =>
    fetchApi(`/radio/stations/${uuid}/stream`),
  cacheRadioStation: (station: RadioStation | Record<string, unknown>): Promise<OkResponse> =>
    fetchApi('/radio/stations/cache', { method: 'POST', body: JSON.stringify(station) }),

  // ─── Lyrics ─────────────────────────────────────────────────
  getLyrics: (trackId: string): Promise<ApiResponse<LyricsResult>> =>
    fetchApi(`/library/tracks/${trackId}/lyrics`),

  // ─── Scrobbling ─────────────────────────────────────────────
  getScrobbleConfig: (): Promise<ApiResponse<ScrobbleConfig>> => fetchApi('/scrobble/config'),
  getLastfmAuthUrl: (): Promise<ApiResponse<LastfmAuthUrl>> =>
    fetchApi('/scrobble/lastfm/auth-url'),
  authenticateLastfm: (
    token: string,
  ): Promise<ApiResponse<{ username: string; authenticated: true }>> =>
    fetchApi('/scrobble/lastfm/auth', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnectLastfm: (): Promise<OkResponse> =>
    fetchApi('/scrobble/lastfm/disconnect', { method: 'POST' }),
  authenticateListenbrainz: (token: string): Promise<ApiResponse<{ authenticated: true }>> =>
    fetchApi('/scrobble/listenbrainz/auth', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnectListenbrainz: (): Promise<OkResponse> =>
    fetchApi('/scrobble/listenbrainz/disconnect', { method: 'POST' }),

  // ─── ListenBrainz read API (stats / discovery) ──────────────
  listenbrainzStatus: (): Promise<ApiResponse<{ configured: boolean }>> =>
    fetchApi('/listenbrainz/status'),
  listenbrainzStats: (range = 'month'): Promise<ApiResponse<ListenBrainzStats>> =>
    fetchApi(`/listenbrainz/stats?range=${encodeURIComponent(range)}`),
  listenbrainzDiscover: (): Promise<ApiResponse<ListenBrainzDiscover>> =>
    fetchApi('/listenbrainz/discover'),

  // ─── Cover art fetch ────────────────────────────────────────
  fetchCovers: (): Promise<ApiResponse<FetchStatus>> =>
    fetchApi('/library/covers/fetch', { method: 'POST' }),
  getCoverFetchStatus: (): Promise<ApiResponse<FetchStatus>> =>
    fetchApi('/library/covers/fetch/status'),
  fetchArtistImages: (): Promise<ApiResponse<FetchStatus>> =>
    fetchApi('/library/artists/images/fetch', { method: 'POST' }),
  getArtistImageFetchStatus: (): Promise<ApiResponse<FetchStatus>> =>
    fetchApi('/library/artists/images/fetch/status'),

  // ─── Librespot (alias) ──────────────────────────────────────
  getLibrespotStatus: (): Promise<ApiResponse<LibrespotStatus>> => fetchApi('/librespot/status'),

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

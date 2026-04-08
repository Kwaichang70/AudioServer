const API_BASE = '/api';

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('audioserver_token');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || `API error: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Library (paginated)
  getArtists: (page = 1, limit = 50) => fetchApi<any>(`/library/artists?page=${page}&limit=${limit}`),
  getArtist: (id: string) => fetchApi<any>(`/library/artists/${id}`),
  getArtistAlbums: (id: string) => fetchApi<any>(`/library/artists/${id}/albums`),
  getAlbums: (page = 1, limit = 50) => fetchApi<any>(`/library/albums?page=${page}&limit=${limit}`),
  getAlbum: (id: string) => fetchApi<any>(`/library/albums/${id}`),
  getAlbumTracks: (id: string) => fetchApi<any>(`/library/albums/${id}/tracks`),
  search: (q: string) => fetchApi<any>(`/library/search?q=${encodeURIComponent(q)}`),
  scanLibrary: () => fetchApi<any>('/library/scan', { method: 'POST' }),
  getScanStatus: () => fetchApi<any>('/library/scan/status'),

  // Devices
  getDevices: () => fetchApi<any>('/devices'),
  discoverDevices: () => fetchApi<any>('/devices/discover'),
  getDeviceStatus: (id: string) => fetchApi<any>(`/devices/${id}/status`),
  devicePlay: (id: string, streamUrl: string, metadata?: any, trackId?: string) =>
    fetchApi<any>(`/devices/${id}/play`, { method: 'POST', body: JSON.stringify({ streamUrl, metadata, trackId }) }),
  deviceSetNext: (id: string, streamUrl: string, metadata?: any) =>
    fetchApi<any>(`/devices/${id}/set-next`, { method: 'POST', body: JSON.stringify({ streamUrl, metadata }) }),
  devicePause: (id: string) => fetchApi<any>(`/devices/${id}/pause`, { method: 'POST' }),
  deviceResume: (id: string) => fetchApi<any>(`/devices/${id}/resume`, { method: 'POST' }),
  deviceStop: (id: string) => fetchApi<any>(`/devices/${id}/stop`, { method: 'POST' }),
  deviceVolume: (id: string, volume: number) =>
    fetchApi<any>(`/devices/${id}/volume`, { method: 'POST', body: JSON.stringify({ volume }) }),

  // Auth
  register: (username: string, password: string) =>
    fetchApi<any>('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    fetchApi<any>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  getMe: () => fetchApi<any>('/auth/me'),

  // Playback
  getNowPlaying: () => fetchApi<any>('/playback/now-playing'),
  getQueue: () => fetchApi<any>('/playback/queue'),
  addToQueue: (track: any) =>
    fetchApi<any>('/playback/queue/add', { method: 'POST', body: JSON.stringify({ track }) }),
  clearQueue: () => fetchApi<any>('/playback/queue/clear', { method: 'POST' }),
  removeFromQueue: (index: number) =>
    fetchApi<any>('/playback/queue/remove', { method: 'POST', body: JSON.stringify({ index }) }),
  moveInQueue: (from: number, to: number) =>
    fetchApi<any>('/playback/queue/move', { method: 'POST', body: JSON.stringify({ from, to }) }),
  play: (track: any, deviceId?: string) =>
    fetchApi<any>('/playback/play', { method: 'POST', body: JSON.stringify({ track, deviceId }) }),
  pause: () => fetchApi<any>('/playback/pause', { method: 'POST' }),
  stop: () => fetchApi<any>('/playback/stop', { method: 'POST' }),
  setVolume: (volume: number) =>
    fetchApi<any>('/playback/volume', { method: 'POST', body: JSON.stringify({ volume }) }),

  // History & Favorites
  recordPlay: (trackId: string, albumId: string, artistId: string) =>
    fetchApi<any>('/history/played', { method: 'POST', body: JSON.stringify({ trackId, albumId, artistId }) }),
  getRecentAlbums: () => fetchApi<any>('/history/recent'),
  getTopArtists: () => fetchApi<any>('/history/top-artists'),
  getHistoryTracks: (page = 1, limit = 50) => fetchApi<any>(`/history/tracks?page=${page}&limit=${limit}`),
  getFavoriteTracks: () => fetchApi<any>('/history/favorites/tracks'),
  toggleFavorite: (itemType: string, itemId: string) =>
    fetchApi<any>('/history/favorites', { method: 'POST', body: JSON.stringify({ itemType, itemId }) }),
  getFavorites: (type: string) => fetchApi<any>(`/history/favorites?type=${type}`),
  checkFavorite: (type: string, id: string) =>
    fetchApi<any>(`/history/favorites/check?type=${type}&id=${id}`),

  // Spotify Connect
  spotifyConnectDevices: () => fetchApi<any>('/providers/spotify/connect/devices'),
  spotifyConnectState: () => fetchApi<any>('/providers/spotify/connect/state'),
  spotifyConnectPlay: (trackUri: string, deviceId?: string) =>
    fetchApi<any>('/providers/spotify/connect/play', { method: 'POST', body: JSON.stringify({ trackUri, deviceId }) }),
  spotifyConnectPause: (deviceId?: string) =>
    fetchApi<any>('/providers/spotify/connect/pause', { method: 'POST', body: JSON.stringify({ deviceId }) }),
  spotifyConnectResume: (deviceId?: string) =>
    fetchApi<any>('/providers/spotify/connect/resume', { method: 'POST', body: JSON.stringify({ deviceId }) }),
  spotifyConnectNext: (deviceId?: string) =>
    fetchApi<any>('/providers/spotify/connect/next', { method: 'POST', body: JSON.stringify({ deviceId }) }),
  spotifyConnectPrevious: (deviceId?: string) =>
    fetchApi<any>('/providers/spotify/connect/previous', { method: 'POST', body: JSON.stringify({ deviceId }) }),
  spotifyConnectVolume: (volume: number, deviceId?: string) =>
    fetchApi<any>('/providers/spotify/connect/volume', { method: 'POST', body: JSON.stringify({ volume, deviceId }) }),

  // Librespot
  librespotStatus: () => fetchApi<any>('/librespot/status'),
  librespotStart: (username: string, password: string) =>
    fetchApi<any>('/librespot/start', { method: 'POST', body: JSON.stringify({ username, password }) }),
  librespotStop: () => fetchApi<any>('/librespot/stop', { method: 'POST' }),
  librespotPlayToDevice: (trackUri: string, deviceId: string) =>
    fetchApi<any>('/librespot/play-to-device', { method: 'POST', body: JSON.stringify({ trackUri, deviceId }) }),

  // Playlists
  getPlaylists: () => fetchApi<any>('/playlists'),
  getPlaylist: (id: string) => fetchApi<any>(`/playlists/${id}`),
  createPlaylist: (name: string, description?: string) =>
    fetchApi<any>('/playlists', { method: 'POST', body: JSON.stringify({ name, description }) }),
  updatePlaylist: (id: string, data: { name?: string; description?: string }) =>
    fetchApi<any>(`/playlists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deletePlaylist: (id: string) => fetchApi<any>(`/playlists/${id}`, { method: 'DELETE' }),
  getPlaylistTracks: (id: string) => fetchApi<any>(`/playlists/${id}/tracks`),
  addToPlaylist: (playlistId: string, trackId: string) =>
    fetchApi<any>(`/playlists/${playlistId}/tracks`, { method: 'POST', body: JSON.stringify({ trackId }) }),
  removeFromPlaylist: (playlistId: string, trackId: string) =>
    fetchApi<any>(`/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' }),
  reorderPlaylist: (playlistId: string, trackIds: string[]) =>
    fetchApi<any>(`/playlists/${playlistId}/reorder`, { method: 'POST', body: JSON.stringify({ trackIds }) }),
  exportPlaylist: (playlistId: string) => `${API_BASE}/playlists/${playlistId}/export`,
  importPlaylist: (name: string, content: string) =>
    fetchApi<any>('/playlists/import', { method: 'POST', body: JSON.stringify({ name, content }) }),

  // Recently added albums
  getRecentlyAdded: (limit = 20) => fetchApi<any>(`/library/albums/recent?limit=${limit}`),

  // Genres
  getGenres: () => fetchApi<any>('/library/genres'),
  getGenreAlbums: (genre: string, page = 1, limit = 50) =>
    fetchApi<any>(`/library/genres/${encodeURIComponent(genre)}/albums?page=${page}&limit=${limit}`),

  // Smart Playlists
  getSmartPlaylists: () => fetchApi<any>('/smart-playlists'),
  createSmartPlaylist: (name: string, rules: any[]) =>
    fetchApi<any>('/smart-playlists', { method: 'POST', body: JSON.stringify({ name, rules }) }),
  getSmartPlaylistTracks: (id: string) => fetchApi<any>(`/smart-playlists/${id}/tracks`),
  updateSmartPlaylist: (id: string, data: { name?: string; rules?: any[] }) =>
    fetchApi<any>(`/smart-playlists/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSmartPlaylist: (id: string) => fetchApi<any>(`/smart-playlists/${id}`, { method: 'DELETE' }),

  // Library stats
  getStats: () => fetchApi<any>('/library/stats'),

  // Health
  getHealth: () => fetchApi<any>('/health'),

  // Providers
  getProviderStatus: () => fetchApi<any>('/providers/status'),
  providerSearch: (q: string) => fetchApi<any>(`/providers/search?q=${encodeURIComponent(q)}`),
  providerAuthInit: (provider: string, redirectUri: string) =>
    fetchApi<any>(`/providers/${provider}/auth/init`, { method: 'POST', body: JSON.stringify({ redirectUri }) }),
  providerAuthCallback: (provider: string, code: string, redirectUri: string) =>
    fetchApi<any>(`/providers/${provider}/auth/callback`, { method: 'POST', body: JSON.stringify({ code, redirectUri }) }),
  providerAuthLogout: (provider: string) =>
    fetchApi<any>(`/providers/${provider}/auth/logout`, { method: 'POST' }),
  qobuzLogin: (username: string, password: string) =>
    fetchApi<any>('/providers/qobuz/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  // Tidal
  getTidalAlbum: (id: string) => fetchApi<any>(`/providers/tidal/albums/${id}`),
  getTidalAlbumTracks: (id: string) => fetchApi<any>(`/providers/tidal/albums/${id}/tracks`),
  getTidalStreamUrl: (trackId: string) => fetchApi<any>(`/providers/tidal/tracks/${trackId}/stream`),
  getTidalPlaylists: () => fetchApi<any>('/providers/tidal/playlists'),
  getTidalPlaylistTracks: (id: string) => fetchApi<any>(`/providers/tidal/playlists/${id}/tracks`),
  getTidalFavoriteAlbums: () => fetchApi<any>('/providers/tidal/favorites/albums'),
  getTidalFavoriteTracks: () => fetchApi<any>('/providers/tidal/favorites/tracks'),
  getTidalFavoriteArtists: () => fetchApi<any>('/providers/tidal/favorites/artists'),

  // Spotify
  getSpotifyAlbum: (id: string) => fetchApi<any>(`/providers/spotify/albums/${id}`),
  getSpotifyAlbumTracks: (id: string) => fetchApi<any>(`/providers/spotify/albums/${id}/tracks`),
  getQobuzAlbum: (id: string) => fetchApi<any>(`/providers/qobuz/albums/${id}`),
  getQobuzAlbumTracks: (id: string) => fetchApi<any>(`/providers/qobuz/albums/${id}/tracks`),
  getQobuzStreamUrl: (trackId: string) => fetchApi<any>(`/providers/qobuz/tracks/${trackId}/stream`),

  // Scrobbling
  getScrobbleConfig: () => fetchApi<any>('/scrobble/config'),
  getLastfmAuthUrl: () => fetchApi<any>('/scrobble/lastfm/auth-url'),
  authenticateLastfm: (token: string) =>
    fetchApi<any>('/scrobble/lastfm/auth', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnectLastfm: () => fetchApi<any>('/scrobble/lastfm/disconnect', { method: 'POST' }),
  authenticateListenbrainz: (token: string) =>
    fetchApi<any>('/scrobble/listenbrainz/auth', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnectListenbrainz: () => fetchApi<any>('/scrobble/listenbrainz/disconnect', { method: 'POST' }),

  // Cover art fetch
  fetchCovers: () => fetchApi<any>('/library/covers/fetch', { method: 'POST' }),
  getCoverFetchStatus: () => fetchApi<any>('/library/covers/fetch/status'),
  fetchArtistImages: () => fetchApi<any>('/library/artists/images/fetch', { method: 'POST' }),
  getArtistImageFetchStatus: () => fetchApi<any>('/library/artists/images/fetch/status'),

  // Librespot
  getLibrespotStatus: () => fetchApi<any>('/librespot/status'),

  // URLs (not fetched, used directly)
  getStreamUrl: (trackId: string) => `${API_BASE}/library/tracks/${trackId}/stream`,
  getAlbumCoverUrl: (albumId: string) => `${API_BASE}/library/albums/${albumId}/cover`,
  getArtistImageUrl: (artistId: string) => `${API_BASE}/library/artists/${artistId}/image`,
  getTrackCoverUrl: (trackId: string) => `${API_BASE}/library/tracks/${trackId}/cover`,
};

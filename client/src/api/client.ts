const API_BASE = '/api';

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || `API error: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Library
  getArtists: () => fetchApi<any>('/library/artists'),
  getArtist: (id: string) => fetchApi<any>(`/library/artists/${id}`),
  getArtistAlbums: (id: string) => fetchApi<any>(`/library/artists/${id}/albums`),
  getAlbums: () => fetchApi<any>('/library/albums'),
  getAlbum: (id: string) => fetchApi<any>(`/library/albums/${id}`),
  getAlbumTracks: (id: string) => fetchApi<any>(`/library/albums/${id}/tracks`),
  search: (q: string) => fetchApi<any>(`/library/search?q=${encodeURIComponent(q)}`),
  scanLibrary: () => fetchApi<any>('/library/scan', { method: 'POST' }),
  getScanStatus: () => fetchApi<any>('/library/scan/status'),

  // Devices
  getDevices: () => fetchApi<any>('/devices'),

  // Playback
  getNowPlaying: () => fetchApi<any>('/playback/now-playing'),
  getQueue: () => fetchApi<any>('/playback/queue'),
  addToQueue: (track: any) =>
    fetchApi<any>('/playback/queue/add', { method: 'POST', body: JSON.stringify({ track }) }),
  clearQueue: () => fetchApi<any>('/playback/queue/clear', { method: 'POST' }),
  play: (track: any, deviceId?: string) =>
    fetchApi<any>('/playback/play', { method: 'POST', body: JSON.stringify({ track, deviceId }) }),
  pause: () => fetchApi<any>('/playback/pause', { method: 'POST' }),
  stop: () => fetchApi<any>('/playback/stop', { method: 'POST' }),
  setVolume: (volume: number) =>
    fetchApi<any>('/playback/volume', { method: 'POST', body: JSON.stringify({ volume }) }),

  // URLs (not fetched, used directly)
  getStreamUrl: (trackId: string) => `${API_BASE}/library/tracks/${trackId}/stream`,
  getAlbumCoverUrl: (albumId: string) => `${API_BASE}/library/albums/${albumId}/cover`,
  getTrackCoverUrl: (trackId: string) => `${API_BASE}/library/tracks/${trackId}/cover`,
};

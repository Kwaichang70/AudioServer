// ─── Core Domain Types ───────────────────────────────────────────

export interface Artist {
  id: string;
  name: string;
  imageUrl?: string;
  source: ProviderType;
}

export interface Album {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  year?: number;
  coverUrl?: string;
  genre?: string;
  trackCount?: number;
  source: ProviderType;
}

export interface Track {
  id: string;
  title: string;
  albumId: string;
  albumTitle: string;
  artistId: string;
  artistName: string;
  trackNumber?: number;
  discNumber?: number;
  duration?: number; // seconds
  format?: string; // 'flac', 'mp3', etc.
  sampleRate?: number;
  bitDepth?: number;
  filePath?: string; // only for local tracks
  streamUrl?: string; // resolved at play time
  coverUrl?: string;
  source: ProviderType;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  trackCount: number;
  coverUrl?: string;
  source: ProviderType;
}

// ─── Enums & Utility Types ───────────────────────────────────────

export type ProviderType = 'local' | 'tidal' | 'spotify' | 'qobuz' | 'radio';

export interface RadioStation {
  id: string;              // 'radio:<uuid>' — full track-id form for playback
  uuid: string;            // raw identifier (radio-browser stationuuid or curated slug)
  name: string;
  streamUrl: string;
  genre?: string;
  country?: string;        // ISO code, 'NL' for Dutch
  language?: string;
  homepage?: string;
  faviconUrl?: string;
  bitrate?: number;
  codec?: string;          // 'mp3' | 'aac' | 'ogg'
  curated?: boolean;       // true for the hardcoded NL featured list
}

export type PlaybackState = 'stopped' | 'playing' | 'paused' | 'buffering';

export interface QueueItem {
  track: Track;
  addedAt: number; // timestamp
}

export interface NowPlaying {
  track: Track | null;
  state: PlaybackState;
  position: number; // seconds
  duration: number; // seconds
  volume: number; // 0-100
  deviceId: string | null;
}

// ─── Search ──────────────────────────────────────────────────────

export interface SearchResults {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
  playlists: Playlist[];
}

// ─── API Response Wrappers ───────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: {
    total?: number;
    page?: number;
    pageSize?: number;
  };
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}

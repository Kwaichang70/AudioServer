// ─── Core Domain Types ───────────────────────────────────────────

export interface Artist {
  id: string;
  name: string;
  imageUrl?: string;
  source: ProviderType;
  availableOn?: ProviderType[];
  alternatives?: SourceRef[];
}

/**
 * A concrete item at one source (V07.1). Search results keep one of these
 * per source, so "play from Qobuz" uses Qobuz's own id, not a name lookup.
 */
export interface SourceRef {
  source: ProviderType;
  id: string;
  albumId?: string;
  /** Edition label at that source ('Live', 'Remastered 2011'). */
  version?: string;
  duration?: number;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
}

/** What can be done with a search result right now (V07.2). */
export interface Playability {
  /** Can be started at all (some source can play it). */
  playable: boolean;
  /** This browser can play it itself. */
  browser: boolean;
  /** The server can hand it to a speaker. */
  server: boolean;
  /** Needs an external player (Spotify Connect). */
  external: boolean;
  /** Why not, when not playable ('missing-file', 'no-full-playback', 'not-authenticated'). */
  reason?: string;
}

export interface Album {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  year?: number;
  coverUrl?: string;
  genre?: string;
  isCompilation?: boolean;
  trackCount?: number;
  /** Edition label ('Deluxe', 'Remastered', 'Live'), when the source or the title says so. */
  version?: string;
  source: ProviderType;
  availableOn?: ProviderType[];
  alternatives?: SourceRef[];
}

export interface Track {
  id: string;
  title: string;
  albumId: string;
  albumTitle: string;
  artistId: string;
  artistName: string;
  artistNames?: string;
  composer?: string;
  conductor?: string;
  trackNumber?: number;
  discNumber?: number;
  duration?: number; // seconds
  format?: string; // 'flac', 'mp3', etc.
  sampleRate?: number;
  bitDepth?: number;
  filePath?: string; // only for local tracks
  streamUrl?: string; // resolved at play time
  coverUrl?: string;
  /** Edition label ('Live', 'Remastered 2011', 'Radio Edit'), from the source or parsed from the title. */
  version?: string;
  /** Local files: 'available' | 'missing' (V06). */
  availability?: 'available' | 'missing';
  source: ProviderType;
  availableOn?: ProviderType[];
  alternatives?: SourceRef[];
  playability?: Playability;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  trackCount: number;
  coverUrl?: string;
  source: ProviderType;
  availableOn?: ProviderType[];
  alternatives?: SourceRef[];
}

// ─── Enums & Utility Types ───────────────────────────────────────

export type ProviderType = 'local' | 'tidal' | 'spotify' | 'qobuz' | 'radio';

export interface RadioStation {
  id: string; // 'radio:<uuid>' — full track-id form for playback
  uuid: string; // raw identifier (radio-browser stationuuid or curated slug)
  name: string;
  streamUrl: string;
  genre?: string;
  country?: string; // ISO code, 'NL' for Dutch
  language?: string;
  homepage?: string;
  faviconUrl?: string;
  bitrate?: number;
  codec?: string; // 'mp3' | 'aac' | 'ogg'
  curated?: boolean; // true for the hardcoded NL featured list
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

/** Outcome of one source in a unified search (V07.4). */
export interface SearchSourceStatus {
  source: ProviderType;
  status: 'ok' | 'timeout' | 'error' | 'unavailable';
  ms: number;
  error?: string;
  counts?: { artists: number; albums: number; tracks: number; playlists: number };
}

export interface SearchResults {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
  playlists: Playlist[];
  /** Per-source outcome; a failed provider never hides the others' results. */
  sources?: SearchSourceStatus[];
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

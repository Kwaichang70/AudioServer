import type {
  Album,
  Artist,
  DevicePlaybackStatus,
  NowPlaying,
  OutputDevice,
  Playlist,
  ProviderType,
  RadioStation,
  SearchResults,
  Track,
} from '@audioserver/shared';

export interface ApiMeta {
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  matched?: number;
}

export interface ApiResponse<T, M extends ApiMeta = ApiMeta> {
  data: T;
  meta?: M;
  message?: string;
}

export interface PaginatedMeta extends ApiMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PaginatedResponse<T> extends ApiResponse<T[], PaginatedMeta> {
  meta: PaginatedMeta;
}

export type OkResponse = ApiResponse<{ ok: true }>;

export interface LibraryStats {
  artists: number;
  albums: number;
  tracks: number;
}

export interface LibraryArtist extends Artist {
  hasImage?: boolean;
}

export interface LibraryAlbum extends Album {
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
  hasCover?: boolean;
  replayGainAlbum?: number | null;
  replayGainAlbumPeak?: number | null;
}

export interface LibraryTrack extends Track {
  replayGainTrack?: number | null;
  replayGainTrackPeak?: number | null;
  replayGainAlbum?: number | null;
  replayGainAlbumPeak?: number | null;
  playlistPosition?: number;
}

export interface SimilarArtist {
  name: string;
  match: number;
  localArtistId: string | null;
}

export interface SimilarArtistsResult {
  available: boolean;
  similar: SimilarArtist[];
}

export interface LocalSearchResults {
  artists: Artist[];
  albums: Album[];
  tracks: Track[];
  playlists?: Playlist[];
}

export interface ScanStatus {
  isScanning: boolean;
  phase: 'idle' | 'discovering' | 'scanning' | 'cleaning' | 'done';
  processedFiles: number;
  totalFiles: number;
  newTracks: number;
  updatedTracks: number;
  removedTracks: number;
  artists: number;
  albums: number;
  tracks: number;
  errors: number;
  currentDir?: string;
  currentFile?: string;
  successfulRoots: string[];
  failedRoots: Array<{ path: string; error: string; failedDirs: string[] }>;
  orphanCleanupSkipped: boolean;
}

export type DevicesResponse = ApiResponse<OutputDevice[]>;
export type DeviceStatusResponse = ApiResponse<DevicePlaybackStatus>;

export interface UserAccount {
  id: string;
  username: string;
  role: string;
  created_at?: number | string | null;
}

export interface AuthResult {
  token: string;
  user: Omit<UserAccount, 'role'> & { role?: string };
}

export interface PlaybackQueueEntry {
  trackId: string;
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
  position: number;
}

export type PlaybackStateResponse = ApiResponse<NowPlaying>;
export type PlaybackQueueResponse = ApiResponse<PlaybackQueueEntry[]>;

export interface RecentAlbum {
  album_id: string;
  title: string;
  artist_name: string;
  year?: number;
  track_count?: number;
  last_played?: string | number;
}

export interface TopArtist {
  id: string;
  name: string;
  play_count: number;
}

export interface HistoryEntry {
  id: number;
  track_id: string;
  album_id: string;
  artist_id: string;
  played_at: string;
  track_title: string;
  album_title: string;
  artist_name: string;
  duration: number;
  track_number?: number;
}

export type FavoriteType = 'album' | 'artist' | 'track' | 'station';

export interface FavoriteAlbum extends LibraryAlbum {
  favorited: true;
}

export interface FavoriteArtist extends LibraryArtist {
  favorited: true;
}

export interface FavoriteTrack extends LibraryTrack {
  favorited: true;
}

export interface FavoriteStation extends RadioStation {
  favorited: true;
}

export interface FavoriteResponseMap {
  album: FavoriteAlbum;
  artist: FavoriteArtist;
  track: FavoriteTrack;
  station: FavoriteStation;
}

export interface SpotifyToken {
  accessToken: string;
  expiresAt: number;
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

export interface SpotifyPlaybackState {
  is_playing?: boolean;
  progress_ms?: number;
  item?: {
    id?: string;
    uri?: string;
    name?: string;
    duration_ms?: number;
    artists?: Array<{ name?: string }>;
    album?: { name?: string; uri?: string };
  } | null;
  device?: SpotifyConnectDevice;
}

export interface LibrespotStatus {
  isRunning: boolean;
  isStreaming: boolean;
  currentTrackId: string | null;
  librespotInstalled: boolean;
  ffmpegInstalled: boolean;
}

export interface StoredPlaylist extends Omit<Playlist, 'description' | 'source'> {
  description?: string | null;
  source?: ProviderType;
}

export interface PlaylistImportMeta extends ApiMeta {
  total: number;
  matched: number;
}

export interface SmartPlaylist {
  id: string;
  name: string;
  rules: string;
  trackCount: number;
}

export interface ProviderStatus {
  available: boolean;
  authenticated: boolean;
  configured?: boolean;
  streamingAvailable?: boolean;
  reason?: string;
  formatId?: string;
  accountName?: string;
}

export interface ProviderStatuses {
  tidal: ProviderStatus;
  spotify: ProviderStatus;
  qobuz: ProviderStatus;
}

export interface ProviderAuthResult {
  authenticated: boolean;
}

export interface QobuzStreamInfo {
  url: string;
  formatId: string;
  expiresAt?: number;
}

export interface RadioStreamInfo {
  url: string;
  name: string;
  genre?: string;
}

export interface LyricsResult {
  plain: string | null;
  synced: Array<{ time: number; text: string }> | null;
  source: string;
}

export interface ScrobbleConfig {
  lastfm: {
    enabled: boolean;
    configured: boolean;
    username: string | null;
  };
  listenbrainz: {
    enabled: boolean;
    configured: boolean;
  };
}

export interface LastfmAuthUrl {
  token: string;
  url: string;
}

export interface ListenBrainzStats {
  configured: boolean;
  userName: string | null;
  range: string;
  artists: Array<{ name: string; listenCount: number; localArtistId: string | null }>;
  releases: Array<{
    title: string;
    artist: string;
    listenCount: number;
    localAlbumId: string | null;
  }>;
  recordings: Array<{
    title: string;
    artist: string;
    release: string | null;
    listenCount: number;
    localTrackId: string | null;
    localAlbumId: string | null;
  }>;
}

export interface ListenBrainzDiscover {
  configured: boolean;
  freshReleases: Array<{
    title: string;
    artist: string;
    releaseDate: string | null;
    localAlbumId: string | null;
  }>;
  playlists: Array<{
    title: string;
    tracks: Array<{
      title: string;
      artist: string;
      localTrackId: string | null;
      localAlbumId: string | null;
    }>;
  }>;
}

export interface FetchStatus {
  isRunning: boolean;
  total: number;
  processed: number;
  found: number;
  notFound: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptime: number;
  timestamp: string;
  lanAddress: string | null;
  port: number;
  environment: string;
  db: { status: 'ok' | 'down' };
  library: LibraryStats & { lastScanAt: number | null };
  libraryStats: {
    totalDuration: number;
    formats: Array<{ format: string; count: number }>;
    sampleRates: Array<{ sampleRate: number; count: number }>;
    bitDepths: Array<{ bitDepth: number; count: number }>;
    genres: Array<{ genre: string; count: number }>;
  } | null;
  providers: ProviderStatuses & { local: ProviderStatus };
  librespot: Pick<LibrespotStatus, 'isRunning' | 'isStreaming' | 'currentTrackId'>;
  memory: { rss: number; heapUsed: number };
}

export type ProviderSearchResponse = ApiResponse<SearchResults>;

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
  // V06: files are marked missing instead of deleted; moved files keep their id.
  relinkedTracks?: number;
  missingTracks?: number;
  recoveredTracks?: number;
  doubtfulTracks?: number;
  runId?: string | null;
  forced?: boolean;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface ScanRun {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'done' | 'failed';
  trigger: string;
  forced: boolean;
  roots: string[];
  successfulRoots: string[];
  failedRoots: Array<{ path: string; error: string; failedDirs: string[] }>;
  totalFiles: number;
  newTracks: number;
  updatedTracks: number;
  relinkedTracks: number;
  missingTracks: number;
  recoveredTracks: number;
  errors: number;
  message: string | null;
}

export interface ScanStatusResponse extends ApiResponse<ScanStatus> {
  lastSuccessfulRun?: ScanRun | null;
  configuredRoots?: string[];
}

export interface MissingTrackCandidate {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  filePath: string | null;
  duration: number | null;
  strength: 'strong' | 'weak';
}

export interface MissingTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId: string;
  filePath: string | null;
  duration: number | null;
  missingSince: number | null;
  candidates: MissingTrackCandidate[];
}

export type DevicesResponse = ApiResponse<OutputDevice[]>;
export type DeviceStatusResponse = ApiResponse<DevicePlaybackStatus>;

export interface UserAccount {
  id: string;
  username: string;
  role: string;
  created_at?: number | string | null;
  /** Present on GET /auth/me: the caller's own session id. */
  sessionId?: string;
}

export interface SetupStatus {
  needsSetup: boolean;
  setupCodeSource?: 'env' | 'generated';
}

export interface SessionInfo {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  userAgent: string | null;
  current: boolean;
}

export interface AuthResult {
  token: string;
  expiresAt?: number;
  user: Omit<UserAccount, 'role'> & { role?: string };
}

export interface PlaybackQueueEntry {
  itemId: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
  metadata?: Record<string, unknown>;
  position: number;
}

export interface PlaybackOrigin {
  clientId: string | null;
  sessionId: string | null;
  server?: boolean;
}

/** What the server-side player is doing with the current item on the active device. */
export interface DispatchStatus {
  state: 'idle' | 'loading' | 'playing' | 'client' | 'skipped' | 'error';
  /** The room this dispatch belongs to (V10). */
  zoneId?: string;
  deviceId: string | null;
  itemId: string | null;
  trackId: string | null;
  code?: string;
  message?: string;
  attempts: number;
  updatedAt: number;
}

export interface SourceCapabilities {
  source: 'local' | 'qobuz' | 'spotify' | 'tidal' | 'radio';
  serverDispatch: boolean;
  browser: boolean;
  externalPlayer: 'spotify-connect' | null;
  ephemeralUrl: boolean;
  reason?: string;
}

/** What an output can really do, asked of the device itself (V11.1). */
export interface OutputCapabilities {
  deviceId: string;
  deviceName: string;
  type: 'dlna' | 'sonos' | 'volumio' | 'browser';
  formats: string[];
  seek: 'supported' | 'unsupported' | 'unknown';
  nextUri: 'supported' | 'unsupported' | 'unknown';
  replayGain: 'browser' | 'none' | 'unknown';
  gapless: 'verified' | 'unsupported' | 'unknown';
  measuredGapMs?: number;
  limits: string[];
  probedAt?: number;
}

/** One step between the file and the speaker, with how sure we are of it. */
export interface AudioPathStep {
  stage: 'source' | 'transfer' | 'renderer' | 'output';
  title: string;
  detail: string;
  certainty: 'known' | 'reported' | 'unknown';
}

export interface AudioPath {
  zoneId: string;
  deviceId: string;
  trackId: string | null;
  steps: AudioPathStep[];
  summary: string;
  caveats: string[];
}

/** One track boundary; observed and measured numbers stay separate (V11.4). */
export interface TransitionRecord {
  id: number;
  zoneId: string | null;
  deviceId: string;
  fromTrackId: string | null;
  toTrackId: string | null;
  handover: 'next-uri' | 'dispatch' | 'client';
  armedAt: number | null;
  observedGapMs: number | null;
  measuredGapMs: number | null;
  method: string | null;
  note: string | null;
  createdAt: number | null;
}

/** A room with its own queue, transport and volume (V10). */
export interface ZoneSummary {
  id: string;
  name: string;
  deviceId: string;
  isDefault: boolean;
}

/** A room plus what it is playing right now (GET /playback/zones). */
export interface ZoneOverview extends ZoneSummary {
  state: 'playing' | 'paused' | 'stopped';
  track: NowPlaying['track'];
  queueLength: number;
  queueIndex: number;
  volume: number;
}

/** Authoritative session state returned by every queue command and pushed on connect. */
export interface PlaybackSnapshot {
  /** The room this snapshot describes (V10). */
  zoneId?: string;
  revision: number;
  queue: PlaybackQueueEntry[];
  currentItemId: string | null;
  queueIndex: number;
  state: NowPlaying;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  controller: { clientId: string | null; deviceId: string; serverManaged?: boolean };
  dispatch?: DispatchStatus;
}

export interface PlaybackQueueEvent {
  zoneId?: string;
  revision: number;
  queue: PlaybackQueueEntry[];
  currentItemId: string | null;
  queueIndex: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  origin: PlaybackOrigin;
}

export interface PlaybackStateEvent extends NowPlaying {
  zoneId?: string;
  revision: number;
  currentItemId: string | null;
  origin: PlaybackOrigin;
}

export interface PlaybackTrackChangedEvent {
  zoneId?: string;
  track: {
    id: string;
    title: string;
    artistName: string;
    albumTitle: string;
    albumId?: string;
    duration?: number;
    source?: string;
    metadata?: Record<string, unknown>;
  };
  itemId: string | null;
  revision: number;
  deviceId: string;
  controllerClientId: string | null;
  origin: PlaybackOrigin;
}

export interface QueueCommandOptions {
  commandId?: string;
  expectedRevision?: number;
}

export type PlaybackStateResponse = ApiResponse<NowPlaying>;
export type PlaybackQueueResponse = ApiResponse<PlaybackQueueEntry[]>;
export type PlaybackSnapshotResponse = ApiResponse<PlaybackSnapshot>;

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
  id: string;
  track_id: string;
  album_id: string | null;
  artist_id: string | null;
  /** ISO-8601 UTC, or null for an old listen whose time was never recorded. */
  played_at: string | null;
  /** Milliseconds actually heard (V05). */
  listened_ms: number;
  source: string;
  track_title: string;
  album_title: string | null;
  artist_name: string;
  duration: number | null;
  track_number?: number | null;
}

export interface HistoryStats {
  days: number;
  listens: number;
  listenedMs: number;
  distinctTracks: number;
  topTracks: Array<{
    track_id: string | null;
    title: string;
    artist_name: string;
    album_title: string | null;
    album_id: string | null;
    source: string;
    play_count: number;
    listened_ms: number;
  }>;
  topArtists: Array<{ id: string | null; name: string; play_count: number; listened_ms: number }>;
  bySource: Array<{ source: string; play_count: number; listened_ms: number }>;
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
  version?: string;
  buildId?: string;
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

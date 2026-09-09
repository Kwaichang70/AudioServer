import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Timestamp default (V05.1). Drizzle fills every column it knows about on an
 * insert and writes an explicit NULL for the ones you omit, so a SQL
 * `DEFAULT (unixepoch())` never fires through these schema inserts. The
 * default function below makes omitted timestamps the current UTC time.
 */
const now = () => new Date();

export const artists = sqliteTable('artists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  imageUrl: text('image_url'),
  source: text('source').notNull().default('local'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(now),
});

export const albums = sqliteTable('albums', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  artistId: text('artist_id')
    .notNull()
    .references(() => artists.id),
  artistName: text('artist_name').notNull(),
  year: integer('year'),
  coverUrl: text('cover_url'),
  genre: text('genre'),
  isCompilation: integer('is_compilation', { mode: 'boolean' }).default(false),
  trackCount: integer('track_count').default(0),
  // ReplayGain album-mode gain (dB) + peak (0..1 ratio). Computed from per-track
  // metadata at scan time. NULL means "no replay-gain metadata available".
  replayGainAlbum: real('replay_gain_album'),
  replayGainAlbumPeak: real('replay_gain_album_peak'),
  // Folder of this album's files (informational).
  dirPath: text('dir_path'),
  // Album identity discriminator: folder + quality (format/sample-rate/bit-depth).
  // The same album at multiple qualities — even side by side in ONE folder —
  // becomes separate album entries instead of one with every track duplicated.
  editionKey: text('edition_key'),
  // Audio quality of the album (from a representative track) so the UI can tell
  // those quality editions apart.
  format: text('format'),
  sampleRate: integer('sample_rate'),
  bitDepth: integer('bit_depth'),
  source: text('source').notNull().default('local'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(now),
});

export const tracks = sqliteTable('tracks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  albumId: text('album_id')
    .notNull()
    .references(() => albums.id),
  albumTitle: text('album_title').notNull(),
  artistId: text('artist_id')
    .notNull()
    .references(() => artists.id),
  artistName: text('artist_name').notNull(),
  artistNames: text('artist_names'),
  composer: text('composer'),
  conductor: text('conductor'),
  trackNumber: integer('track_number'),
  discNumber: integer('disc_number').default(1),
  duration: real('duration'),
  format: text('format'),
  sampleRate: integer('sample_rate'),
  bitDepth: integer('bit_depth'),
  filePath: text('file_path'),
  coverUrl: text('cover_url'),
  // ReplayGain track-mode gain (dB) + peak (0..1 ratio). Read straight from
  // ID3v2/Vorbis/MP4 tags by the scanner. NULL means the file has no RG tag.
  replayGainTrack: real('replay_gain_track'),
  replayGainTrackPeak: real('replay_gain_track_peak'),
  source: text('source').notNull().default('local'),
  // ── Source location vs identity (V06.1) ──
  // The row id is the track's identity (playlists, favorites, history point
  // at it); file_path is only where it currently lives. Size + mtime say
  // whether the file changed; the fingerprint (size, duration, tags) says
  // whether a file at a new path is the same recording, so a move keeps the id.
  fileSize: integer('file_size'),
  fileMtime: integer('file_mtime'),
  fingerprint: text('fingerprint'),
  /** Scanner rule version that last processed this file; a bump reprocesses everything once. */
  scanVersion: integer('scan_version'),
  /** 'available' | 'missing': a missing file keeps its row until an explicit purge. */
  availability: text('availability').notNull().default('available'),
  missingSince: integer('missing_since'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(now),
});

/** One row per library scan (V06.3): what was scanned, what happened, when. */
export const scanRuns = sqliteTable('scan_runs', {
  id: text('id').primaryKey(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  /** 'running' | 'done' | 'failed' */
  status: text('status').notNull().default('running'),
  trigger: text('trigger').notNull().default('manual'),
  forced: integer('forced', { mode: 'boolean' }).notNull().default(false),
  /** JSON string[] */
  roots: text('roots').notNull(),
  /** JSON string[] */
  successfulRoots: text('successful_roots'),
  /** JSON {path, error, failedDirs[]}[] */
  failedRoots: text('failed_roots'),
  totalFiles: integer('total_files').notNull().default(0),
  newTracks: integer('new_tracks').notNull().default(0),
  updatedTracks: integer('updated_tracks').notNull().default(0),
  relinkedTracks: integer('relinked_tracks').notNull().default(0),
  missingTracks: integer('missing_tracks').notNull().default(0),
  recoveredTracks: integer('recovered_tracks').notNull().default(0),
  errors: integer('errors').notNull().default(0),
  message: text('message'),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(now),
});

/**
 * Login sessions (V02.3). A JWT carries the session id; the session row is
 * the revocable part: logout, "sign out everywhere", an admin password reset
 * or deleting the user marks or removes rows here, and every later request,
 * socket handshake or stream token that references the session is refused.
 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  revokedAt: integer('revoked_at'),
  userAgent: text('user_agent'),
});

export const providerTokens = sqliteTable('provider_tokens', {
  provider: text('provider').primaryKey(),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const playlists = sqliteTable('playlists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  trackCount: integer('track_count').default(0),
  /** Owner (V09.1). Only the owner edits or deletes; NULL only until migrated. */
  userId: text('user_id'),
  /** Visible to the whole household, read-only for everyone but the owner. */
  shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(now),
});

export const playlistTracks = sqliteTable(
  'playlist_tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: text('playlist_id')
      .notNull()
      .references(() => playlists.id),
    trackId: text('track_id')
      .notNull()
      .references(() => tracks.id),
    position: integer('position').notNull(),
    addedAt: integer('added_at', { mode: 'timestamp' }).$defaultFn(now),
  },
  (table) => ({
    playlistPositionIdx: index('idx_playlist_tracks_playlist').on(table.playlistId, table.position),
  }),
);

export const playHistory = sqliteTable('play_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackId: text('track_id')
    .notNull()
    .references(() => tracks.id),
  albumId: text('album_id').notNull(),
  artistId: text('artist_id').notNull(),
  playedAt: integer('played_at', { mode: 'timestamp' }).$defaultFn(now),
});

export const playbackState = sqliteTable('playback_state', {
  id: integer('id').primaryKey().default(1), // singleton row
  deviceId: text('device_id').default('browser'),
  trackId: text('track_id'),
  /** Which queue OCCURRENCE is current (V03.1); track_id alone is ambiguous when a track repeats. */
  queueItemId: text('queue_item_id'),
  /** Monotonic counter, bumped on every queue/transport mutation; clients use it to detect stale edits. */
  revision: integer('revision').default(0),
  state: text('state').default('stopped'), // playing, paused, stopped
  position: real('position').default(0),
  volume: integer('volume').default(50),
  shuffle: integer('shuffle', { mode: 'boolean' }).default(false),
  repeat: text('repeat').default('off'), // off, all, one
  /** Account that handed the queue to the server (V04.3); informational, dispatch uses a system token. */
  ownerUserId: text('owner_user_id'),
  /** True while the NAS itself drives the active device (DLNA/Sonos/Volumio). */
  serverManaged: integer('server_managed', { mode: 'boolean' }).default(false),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(now),
});

export const queueItems = sqliteTable(
  'queue_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Stable identity of this queue position (V03.1); survives reorders and restarts. */
    itemId: text('item_id'),
    trackId: text('track_id').notNull(),
    trackTitle: text('track_title').notNull(),
    artistName: text('artist_name').notNull(),
    albumTitle: text('album_title').notNull(),
    albumId: text('album_id'),
    duration: real('duration'),
    source: text('source').default('local'),
    /** JSON with the extra track fields a client needs to play it (ReplayGain, format). */
    metadata: text('metadata'),
    position: integer('position').notNull(),
    addedAt: integer('added_at', { mode: 'timestamp' }).$defaultFn(now),
  },
  (table) => ({
    positionIdx: index('idx_queue_position').on(table.position),
  }),
);

export const smartPlaylists = sqliteTable('smart_playlists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rules: text('rules').notNull(), // JSON: array of rule objects
  trackCount: integer('track_count').default(0),
  /** Owner (V09.1); a smart playlist reads that user's own favourites and history. */
  userId: text('user_id'),
  shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(now),
});

/**
 * Scrobble accounts, one row per user (V09.3). Before V09 this was a single
 * household row; the migration hands that row to the first admin, because a
 * Last.fm session key belongs to one person, not to a household.
 */
export const scrobbleConfig = sqliteTable('scrobble_config', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id'),
  lastfmEnabled: integer('lastfm_enabled', { mode: 'boolean' }).default(false),
  lastfmSessionKey: text('lastfm_session_key'),
  lastfmUsername: text('lastfm_username'),
  listenbrainzEnabled: integer('listenbrainz_enabled', { mode: 'boolean' }).default(false),
  listenbrainzToken: text('listenbrainz_token'),
});

export const scrobbleQueue = sqliteTable('scrobble_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  service: text('service').notNull(), // 'lastfm' | 'listenbrainz'
  trackTitle: text('track_title').notNull(),
  artistName: text('artist_name').notNull(),
  albumTitle: text('album_title'),
  duration: integer('duration'),
  timestamp: integer('timestamp').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'sent' | 'failed'
  retries: integer('retries').default(0),
  /** Listening session this submission belongs to (V05.3); unique per service. */
  sessionId: text('session_id'),
  /** Whose listen this is (V09.3): submitted with that user's own credentials. */
  userId: text('user_id'),
});

/**
 * One listening session per track start (V05.2): what was played, from
 * which source, when it started and how much of it was actually heard.
 * Metadata is a snapshot, so provider tracks and files that later disappear
 * keep their history. `startedAt` is NULL only for rows copied from the old
 * play_history table whose time was never recorded.
 */
export const listeningSessions = sqliteTable(
  'listening_sessions',
  {
    id: text('id').primaryKey(),
    queueItemId: text('queue_item_id'),
    trackId: text('track_id'),
    source: text('source').notNull().default('local'),
    title: text('title').notNull(),
    artistName: text('artist_name').notNull(),
    albumTitle: text('album_title'),
    albumId: text('album_id'),
    artistId: text('artist_id'),
    /** Track length in seconds when known. */
    duration: integer('duration'),
    /** Unix seconds (UTC); NULL = unknown historical time. */
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    /** Milliseconds actually spent in the playing state. */
    listenedMs: integer('listened_ms').notNull().default(0),
    /** 'active' | 'ended' | 'failed' */
    status: text('status').notNull().default('active'),
    /** Counts as a listen (Last.fm rule) and feeds history, stats and scrobbles. */
    qualified: integer('qualified', { mode: 'boolean' }).notNull().default(false),
    deviceId: text('device_id'),
    userId: text('user_id'),
  },
  (table) => ({
    startedIdx: index('idx_listening_started').on(table.startedAt),
    trackIdx: index('idx_listening_track').on(table.trackId),
    artistIdx: index('idx_listening_artist').on(table.artistId),
    albumIdx: index('idx_listening_album').on(table.albumId),
    statusIdx: index('idx_listening_status').on(table.status),
  }),
);

export const favorites = sqliteTable(
  'favorites',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    itemType: text('item_type').notNull(), // 'track', 'album', 'artist', 'station'
    itemId: text('item_id').notNull(),
    /** Whose favourite this is (V09.1); one row per user and item. */
    userId: text('user_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(now),
  },
  (table) => ({
    itemIdx: index('idx_favorites_type').on(table.itemType, table.itemId),
    itemUniqueIdx: uniqueIndex('idx_favorites_unique_owner_item').on(
      table.userId,
      table.itemType,
      table.itemId,
    ),
  }),
);

export const radioStations = sqliteTable('radio_stations', {
  uuid: text('uuid').primaryKey(), // raw station uuid / curated slug
  name: text('name').notNull(),
  streamUrl: text('stream_url').notNull(),
  genre: text('genre'),
  country: text('country'),
  language: text('language'),
  homepage: text('homepage'),
  faviconUrl: text('favicon_url'),
  bitrate: integer('bitrate'),
  codec: text('codec'),
  addedAt: integer('added_at', { mode: 'timestamp' }).$defaultFn(now),
});

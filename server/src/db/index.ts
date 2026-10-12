import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';
import { searchText } from '../utils/search-text.js';
import { legacyDefinition, rulesSchema } from '../services/focus-rules.js';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Schema version this build writes into `PRAGMA user_version` once all
 * migrations (Drizzle files + the lightweight ALTER TABLE backfills below)
 * have run. Bump it whenever a migration is added.
 *
 * It exists for rollback safety: an older build refuses to open a database
 * that a newer build has already migrated, instead of running against tables
 * it does not understand. Databases from before this check carry version 0,
 * which every build accepts and upgrades.
 */
export const SCHEMA_VERSION = 18;

export class DatabaseVersionError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `Database schema version ${found} is newer than this build supports (${supported}). ` +
        'Start the build that created it, or restore a backup taken before the upgrade ' +
        '(see docs/backup-restore.md).',
    );
    this.name = 'DatabaseVersionError';
  }
}

let db: ReturnType<typeof drizzle> | undefined;
let rawDb: InstanceType<typeof Database> | undefined;

export function getSchemaVersion(): number {
  return readUserVersion(getRawDb());
}

export function readUserVersion(sqlite: InstanceType<typeof Database>): number {
  const v = sqlite.pragma('user_version', { simple: true });
  return typeof v === 'number' ? v : 0;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function getRawDb(): InstanceType<typeof Database> {
  if (!rawDb) throw new Error('Database not initialized');
  return rawDb;
}

export function closeDatabase(): void {
  if (rawDb?.open) rawDb.close();
  rawDb = undefined;
  db = undefined;
}

/**
 * Initialise the database. Accepts an optional path override for tests so they
 * can spin up a throwaway sqlite file per suite without mutating process.env.
 */
export async function initDatabase(overridePath?: string) {
  const dbPath = overridePath ?? config.databasePath;
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  const found = readUserVersion(sqlite);
  if (found > SCHEMA_VERSION) {
    sqlite.close();
    throw new DatabaseVersionError(found, SCHEMA_VERSION);
  }
  rawDb = sqlite;
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // R05.4: the search fold, available to SQL. Triggers below call it, so it
  // must be registered on every connection that writes library rows — which
  // is this one: the app is the only writer.
  sqlite.function('search_text', { deterministic: true }, (value: unknown) =>
    searchText(typeof value === 'string' ? value : value == null ? '' : String(value)),
  );

  db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder: resolveMigrationsFolder() });

  // ─── Lightweight migrations ──────────────────────────────────────
  // Drizzle migrations create fresh databases. For older AudioServer databases
  // that predate a migration file, keep column-level backfills idempotent.
  runMigration(sqlite, 'tracks', 'replay_gain_track', 'REAL');
  runMigration(sqlite, 'tracks', 'replay_gain_track_peak', 'REAL');
  runMigration(sqlite, 'tracks', 'artist_names', 'TEXT');
  runMigration(sqlite, 'tracks', 'composer', 'TEXT');
  runMigration(sqlite, 'tracks', 'conductor', 'TEXT');
  runMigration(sqlite, 'albums', 'is_compilation', 'INTEGER DEFAULT 0');
  runMigration(sqlite, 'albums', 'replay_gain_album', 'REAL');
  runMigration(sqlite, 'albums', 'replay_gain_album_peak', 'REAL');
  runMigration(sqlite, 'albums', 'dir_path', 'TEXT');
  runMigration(sqlite, 'albums', 'edition_key', 'TEXT');
  runMigration(sqlite, 'albums', 'format', 'TEXT');
  runMigration(sqlite, 'albums', 'sample_rate', 'INTEGER');
  runMigration(sqlite, 'albums', 'bit_depth', 'INTEGER');
  backfillUserRoles(sqlite);
  // V06.1: file identity columns are ALTER backfills so every database shape
  // (including ones whose tracks table predates the Drizzle files) gets them.
  runMigration(sqlite, 'tracks', 'file_size', 'INTEGER');
  runMigration(sqlite, 'tracks', 'file_mtime', 'INTEGER');
  runMigration(sqlite, 'tracks', 'fingerprint', 'TEXT');
  runMigration(sqlite, 'tracks', 'scan_version', 'INTEGER');
  runMigration(sqlite, 'tracks', 'availability', "TEXT NOT NULL DEFAULT 'available'");
  runMigration(sqlite, 'tracks', 'missing_since', 'INTEGER');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tracks_fingerprint ON tracks (fingerprint)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tracks_availability ON tracks (availability)');
  // V07.3: prefix searches on artist and album names use these.
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_tracks_artist_name ON tracks (artist_name COLLATE NOCASE)',
  );
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_tracks_album_title ON tracks (album_title COLLATE NOCASE)',
  );
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_albums_artist_name ON albums (artist_name COLLATE NOCASE)',
  );
  // V09.1: personal ownership. ALTER backfills so every database shape gets
  // the columns; migration 0006 assigns the existing rows to one owner.
  runMigration(sqlite, 'playlists', 'user_id', 'TEXT');
  runMigration(sqlite, 'playlists', 'shared', 'INTEGER NOT NULL DEFAULT 0');
  runMigration(sqlite, 'smart_playlists', 'user_id', 'TEXT');
  runMigration(sqlite, 'smart_playlists', 'shared', 'INTEGER NOT NULL DEFAULT 0');
  runMigration(sqlite, 'favorites', 'user_id', 'TEXT');
  runMigration(sqlite, 'scrobble_config', 'user_id', 'TEXT');
  runMigration(sqlite, 'scrobble_queue', 'user_id', 'TEXT');
  assignPersonalOwnership(sqlite);
  // V10.1: zones. Each room gets its own queue and transport row.
  runMigration(sqlite, 'queue_items', 'zone_id', 'TEXT');
  createZones(sqlite);
  // V11.4: the transition log. Created here (not in a Drizzle file) so every
  // database shape gets it, including ones that never ran the newer files.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS transition_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id TEXT,
      device_id TEXT NOT NULL,
      from_track_id TEXT,
      to_track_id TEXT,
      handover TEXT NOT NULL,
      armed_at INTEGER,
      observed_gap_ms INTEGER,
      measured_gap_ms INTEGER,
      method TEXT,
      note TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_transition_device ON transition_log (device_id, id)');
  // V12.1: playlist items carry their own source reference and snapshot, so a
  // playlist can hold local and provider tracks side by side.
  migratePlaylistItems(sqlite);
  // V12.2: per-user preferences. Small key/value rows so a preference can be
  // added without another migration; today it carries what a listener's
  // recommendations may be built from.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, key)
    )
  `);
  // E01: sleep timers, one per zone. Stored so a restart does not lose them;
  // a timer that ran out while the server was down is dropped at startup.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sleep_timers (
      zone_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      stop_at INTEGER,
      item_id TEXT,
      album_id TEXT,
      created_by TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);
  // R03.1: identity instead of names. MusicBrainz ids on artist, album and
  // track, the release data an album actually has, and the classical work
  // fields — all ALTER backfills, so every database shape gets them.
  runMigration(sqlite, 'artists', 'mbid', 'TEXT');
  runMigration(sqlite, 'albums', 'mbid', 'TEXT');
  runMigration(sqlite, 'albums', 'release_group_mbid', 'TEXT');
  runMigration(sqlite, 'albums', 'label', 'TEXT');
  runMigration(sqlite, 'albums', 'catalog_number', 'TEXT');
  runMigration(sqlite, 'albums', 'release_date', 'TEXT');
  runMigration(sqlite, 'albums', 'original_year', 'INTEGER');
  runMigration(sqlite, 'tracks', 'mbid', 'TEXT');
  runMigration(sqlite, 'tracks', 'isrc', 'TEXT');
  runMigration(sqlite, 'tracks', 'bpm', 'REAL');
  runMigration(sqlite, 'tracks', 'work', 'TEXT');
  runMigration(sqlite, 'tracks', 'movement', 'TEXT');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_artists_mbid ON artists (mbid)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_albums_mbid ON albums (mbid)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_albums_release_group ON albums (release_group_mbid)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tracks_mbid ON tracks (mbid)');
  // Who is on a track, and the genres as a set. ON DELETE CASCADE is what
  // makes a purge (V06.2) clean up after itself instead of leaving rows that
  // point at a track nobody has any more.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS track_artists (
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'main',
      position INTEGER NOT NULL DEFAULT 0
    )
  `);
  sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_track_artists_pk ON track_artists (track_id, artist_id, role)',
  );
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_track_artists_artist ON track_artists (artist_id, role)',
  );
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS album_genres (
      album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      genre TEXT NOT NULL
    )
  `);
  sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_album_genres_pk ON album_genres (album_id, genre)',
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_album_genres_genre ON album_genres (genre)');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS track_genres (
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      genre TEXT NOT NULL
    )
  `);
  sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_track_genres_pk ON track_genres (track_id, genre)',
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_track_genres_genre ON track_genres (genre)');
  backfillTrackArtists(sqlite);
  // R03.3: what the identification job found for an album it could not link
  // on its own. These rows are a question for an admin, not an answer, so
  // they are deleted the moment the album gets an identity.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS album_identity_candidates (
      album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      mbid TEXT NOT NULL,
      title TEXT,
      artist TEXT,
      release_group_mbid TEXT,
      label TEXT,
      catalog_number TEXT,
      date TEXT,
      track_count INTEGER,
      score INTEGER,
      found_at INTEGER DEFAULT (unixepoch())
    )
  `);
  sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_album_candidates_pk ON album_identity_candidates (album_id, mbid)',
  );
  // R04.1: artist biographies, cached with an expiry. A miss is a row too
  // (summary NULL), with a shorter expiry, so an artist without a Wikipedia
  // page does not cost three external requests on every visit.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS artist_bios (
      artist_id TEXT PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
      summary TEXT,
      source TEXT,
      language TEXT,
      url TEXT,
      license TEXT,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `);
  // R05.3: bookmarks are stored Focus questions, one person's own.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      query TEXT NOT NULL,
      created_at INTEGER
    )
  `);
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_bookmarks_owner ON bookmarks (user_id)');
  // R05.3: a smart playlist is a stored Focus question too. Old six-field
  // rules become one group with the same conditions, order and limit.
  runMigration(sqlite, 'smart_playlists', 'definition', 'TEXT');
  migrateSmartPlaylistDefinitions(sqlite);
  addSearchColumns(sqlite);
  // R07.1: where a non-local row comes from — "qobuz:album:123" — so the
  // library knows what to ask the provider, and the scanner knows to keep out.
  runMigration(sqlite, 'artists', 'source_ref', 'TEXT');
  runMigration(sqlite, 'albums', 'source_ref', 'TEXT');
  runMigration(sqlite, 'tracks', 'source_ref', 'TEXT');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_albums_source ON albums (source)');
  // R07.3: a playlist item names its source explicitly — 'qobuz:track:123' —
  // beside the snapshot that makes it readable when the source is away.
  runMigration(sqlite, 'playlist_tracks', 'source_ref', 'TEXT');
  sqlite.exec(`
    UPDATE playlist_tracks
       SET source_ref = COALESCE(source, 'local') || ':track:' ||
           CASE WHEN instr(track_id, ':') > 0 THEN substr(track_id, instr(track_id, ':') + 1) ELSE track_id END
     WHERE source_ref IS NULL
  `);
  // R07.2: what the last sync with the Qobuz favourites agreed on, so the next
  // one knows which side changed. 'synced' = in both; 'removed_on_qobuz' =
  // still in the library, waiting for you to decide; 'library_only' = you
  // chose to keep it without it being a Qobuz favourite.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS qobuz_album_sync (
      album_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      updated_at INTEGER
    )
  `);
  // R06.1: the listener's own order, apart from metadata. A tag belongs to one
  // person; `shared` makes it readable (never editable) for the household.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_owner_name ON tags (user_id, name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS tag_items (
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      added_at INTEGER,
      PRIMARY KEY (tag_id, item_type, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tag_items_item ON tag_items (item_type, item_id);
  `);
  // R06.4: a rating of 1–5 per person, for a track or an album.
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ratings (
      user_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      updated_at INTEGER,
      PRIMARY KEY (user_id, item_type, item_id)
    );
  `);
  // V05.3: one submission per listening session and service.
  runMigration(sqlite, 'scrobble_queue', 'session_id', 'TEXT');
  sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_scrobble_session_service ON scrobble_queue (session_id, service) WHERE session_id IS NOT NULL',
  );

  if (found !== SCHEMA_VERSION) {
    sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
    logger.info(`Database schema version ${found} -> ${SCHEMA_VERSION}`);
  }

  logger.info(`Database initialized at ${dbPath} (schema v${SCHEMA_VERSION})`);
}

/** The zone every installation has: the browser the app itself plays in. */
export const DEFAULT_ZONE_ID = 'zone-browser';

/**
 * Zones (V10.1). Until now the household had exactly one queue and one
 * transport row (`playback_state` id 1). A zone is a room: its own queue,
 * its own play/pause and volume, bound to exactly one output device.
 *
 * The existing session is not thrown away — it becomes the zone of the
 * device it was last playing on, keeping its queue, position and volume. As
 * with `favorites`, the singleton rule (`id INTEGER PRIMARY KEY DEFAULT 1`)
 * lives inside the CREATE TABLE where no ALTER reaches it, so the table is
 * rebuilt once, keyed by zone.
 */
function createZones(sqlite: InstanceType<typeof Database>): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      device_id TEXT NOT NULL UNIQUE,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  const stateSql =
    (
      sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'playback_state'")
        .get() as { sql: string | null } | undefined
    )?.sql ?? '';
  const singleton = /id\s+INTEGER\s+PRIMARY\s+KEY/i.test(stateSql);

  // Which device was the household playing on? That session becomes a zone.
  const previous = singleton
    ? (sqlite.prepare('SELECT * FROM playback_state WHERE id = 1').get() as
        | Record<string, unknown>
        | undefined)
    : undefined;
  const previousDevice =
    typeof previous?.device_id === 'string' && previous.device_id ? previous.device_id : 'browser';

  const ensureZone = (id: string, name: string, deviceId: string, isDefault: boolean): void => {
    sqlite
      .prepare('INSERT OR IGNORE INTO zones (id, name, device_id, is_default) VALUES (?, ?, ?, ?)')
      .run(id, name, deviceId, isDefault ? 1 : 0);
  };
  ensureZone(DEFAULT_ZONE_ID, 'Browser', 'browser', true);
  const restoredZoneId =
    previousDevice === 'browser' ? DEFAULT_ZONE_ID : `zone-${slugForZone(previousDevice)}`;
  if (restoredZoneId !== DEFAULT_ZONE_ID) {
    ensureZone(restoredZoneId, previousDevice, previousDevice, false);
  }

  if (singleton) {
    sqlite.exec(`
      DROP TABLE IF EXISTS playback_state_v10;
      CREATE TABLE playback_state_v10 (
        zone_id TEXT PRIMARY KEY,
        device_id TEXT DEFAULT 'browser',
        track_id TEXT,
        queue_item_id TEXT,
        revision INTEGER DEFAULT 0,
        state TEXT DEFAULT 'stopped',
        position REAL DEFAULT 0,
        volume INTEGER DEFAULT 50,
        shuffle INTEGER DEFAULT 0,
        repeat TEXT DEFAULT 'off',
        owner_user_id TEXT,
        server_managed INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (unixepoch())
      );
    `);
    sqlite
      .prepare(
        `INSERT INTO playback_state_v10
           (zone_id, device_id, track_id, queue_item_id, revision, state, position, volume,
            shuffle, repeat, owner_user_id, server_managed, updated_at)
         SELECT ?, device_id, track_id, queue_item_id, revision, state, position, volume,
                shuffle, repeat, owner_user_id, server_managed, updated_at
         FROM playback_state WHERE id = 1`,
      )
      .run(restoredZoneId);
    sqlite.exec(`
      DROP TABLE playback_state;
      ALTER TABLE playback_state_v10 RENAME TO playback_state;
    `);
    logger.info(`Migration: playback state is per zone now, kept as "${restoredZoneId}" (V10)`);
  }

  // The queue that was on disk belongs to the zone that inherited the session.
  const claimed = sqlite
    .prepare('UPDATE queue_items SET zone_id = ? WHERE zone_id IS NULL')
    .run(restoredZoneId).changes;
  if (claimed > 0) {
    logger.info(`Migration: moved ${claimed} queue item(s) into zone "${restoredZoneId}" (V10)`);
  }
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_queue_zone_position ON queue_items (zone_id, position)',
  );
}

/**
 * Mixed playlists (V12.1).
 *
 * `playlist_tracks` was a foreign key into the local `tracks` table: a row
 * was nothing but a pointer at a local file. That made two things impossible.
 * A Qobuz track could not be inserted at all (the foreign key refused it),
 * and a local file that left the library took its own name with it, so the
 * item silently disappeared from the playlist instead of saying it was
 * temporarily unavailable.
 *
 * The rule lives inside the CREATE TABLE, where no ALTER reaches it, so the
 * table is rebuilt once — keeping every row, its id, its position and its
 * timestamp — and the snapshot columns are filled from the library as it is
 * now. Detection is on the stored CREATE statement, so this runs once and is
 * a no-op on every later start.
 *
 * No stream URL is stored: those expire, and are resolved at playback.
 */
function migratePlaylistItems(sqlite: InstanceType<typeof Database>): void {
  const createSql =
    (
      sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'playlist_tracks'")
        .get() as { sql: string | null } | undefined
    )?.sql ?? '';
  if (!createSql) return;

  const boundToLocalTracks = /REFERENCES\s+["`']?tracks["`']?/i.test(createSql);
  if (boundToLocalTracks) {
    sqlite.exec(`
      DROP TABLE IF EXISTS playlist_tracks_v12;
      CREATE TABLE playlist_tracks_v12 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        item_id TEXT,
        track_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        track_title TEXT,
        artist_name TEXT,
        album_title TEXT,
        album_id TEXT,
        duration REAL,
        metadata TEXT,
        position INTEGER NOT NULL,
        added_at INTEGER
      );
      INSERT INTO playlist_tracks_v12 (id, playlist_id, track_id, position, added_at)
        SELECT id, playlist_id, track_id, position, added_at FROM playlist_tracks;
      DROP TABLE playlist_tracks;
      ALTER TABLE playlist_tracks_v12 RENAME TO playlist_tracks;
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist
        ON playlist_tracks (playlist_id, position);
    `);
    logger.info('Migration: playlist items can hold any source now (V12)');
  }

  // Databases whose playlist_tracks never carried the foreign key still need
  // the columns; every one of these is a no-op once it exists.
  runMigration(sqlite, 'playlist_tracks', 'item_id', 'TEXT');
  runMigration(sqlite, 'playlist_tracks', 'source', "TEXT NOT NULL DEFAULT 'local'");
  runMigration(sqlite, 'playlist_tracks', 'track_title', 'TEXT');
  runMigration(sqlite, 'playlist_tracks', 'artist_name', 'TEXT');
  runMigration(sqlite, 'playlist_tracks', 'album_title', 'TEXT');
  runMigration(sqlite, 'playlist_tracks', 'album_id', 'TEXT');
  runMigration(sqlite, 'playlist_tracks', 'duration', 'REAL');
  runMigration(sqlite, 'playlist_tracks', 'metadata', 'TEXT');
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks (playlist_id, position)',
  );

  // Every item needs a stable identity of its own: two copies of the same
  // track in one playlist are two items, and remove/reorder must be able to
  // tell them apart.
  const withoutItemId = sqlite
    .prepare("SELECT id FROM playlist_tracks WHERE item_id IS NULL OR item_id = ''")
    .all() as Array<{ id: number }>;
  if (withoutItemId.length > 0) {
    const setId = sqlite.prepare('UPDATE playlist_tracks SET item_id = ? WHERE id = ?');
    sqlite.transaction(() => {
      for (const row of withoutItemId) setId.run(`pli-${randomUUID()}`, row.id);
    })();
    logger.info(`Migration: gave ${withoutItemId.length} playlist item(s) a stable id (V12)`);
  }

  // Fill the snapshot from the library as it is now. Only rows that have no
  // snapshot yet are touched, so a snapshot taken when the item was added is
  // never overwritten by a later scan.
  const filled = sqlite
    .prepare(
      `UPDATE playlist_tracks
          SET track_title = (SELECT title FROM tracks WHERE tracks.id = playlist_tracks.track_id),
              artist_name = (SELECT artist_name FROM tracks WHERE tracks.id = playlist_tracks.track_id),
              album_title = (SELECT album_title FROM tracks WHERE tracks.id = playlist_tracks.track_id),
              album_id    = (SELECT album_id FROM tracks WHERE tracks.id = playlist_tracks.track_id),
              duration    = (SELECT duration FROM tracks WHERE tracks.id = playlist_tracks.track_id)
        WHERE track_title IS NULL
          AND EXISTS (SELECT 1 FROM tracks WHERE tracks.id = playlist_tracks.track_id)`,
    )
    .run().changes;
  if (filled > 0) {
    logger.info(`Migration: snapshotted ${filled} playlist item(s) from the library (V12)`);
  }
}

/**
 * Every track that already exists gets its main artist as a relation (R03.1).
 *
 * Without this, "appears on" would be empty for the whole library until a
 * forced rescan has run, and the first thing R04 builds on it would look
 * broken rather than unscanned. Only the main artist is inferred — the one
 * `tracks.artist_id` already names. Guests, composers and conductors come
 * from the tags during the scan, because splitting a display string into
 * people is a scanner decision, not a migration's guess.
 */
function backfillTrackArtists(sqlite: InstanceType<typeof Database>): void {
  const inserted = sqlite
    .prepare(
      `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role, position)
         SELECT id, artist_id, 'main', 0 FROM tracks WHERE artist_id IS NOT NULL`,
    )
    .run().changes;
  if (inserted > 0) {
    logger.info(`Migration: gave ${inserted} track(s) their main artist as a relation (R03)`);
  }
}

/** A device id turned into something readable inside a zone id. */
export function slugForZone(deviceId: string): string {
  const slug = deviceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'device';
}

/**
 * Accent-free search (R05.4): "Dvorak" finds "Dvořák".
 *
 * Folded copies of the searched text live next to the originals and are kept
 * current by triggers, whatever writes the row — the scanner, the identify
 * job, a provider sync. Genres and composer/conductor credits live in their
 * own tables, so those tables have triggers too. Rows from before this
 * version are filled once, here.
 */
function addSearchColumns(sqlite: Database.Database): void {
  const nocase = 'TEXT COLLATE NOCASE';
  runMigration(sqlite, 'artists', 'name_norm', nocase);
  runMigration(sqlite, 'albums', 'title_norm', nocase);
  runMigration(sqlite, 'albums', 'artist_norm', nocase);
  runMigration(sqlite, 'albums', 'genre_norm', nocase);
  runMigration(sqlite, 'tracks', 'title_norm', nocase);
  runMigration(sqlite, 'tracks', 'artist_norm', nocase);
  runMigration(sqlite, 'tracks', 'album_norm', nocase);
  runMigration(sqlite, 'tracks', 'credits_norm', nocase);
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_artists_name_norm ON artists (name_norm)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_albums_title_norm ON albums (title_norm)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_tracks_title_norm ON tracks (title_norm)');

  const artistSet = `name_norm = search_text(NEW.name)`;
  const albumSet = (id: string) => `
      title_norm = search_text(NEW.title),
      artist_norm = search_text(NEW.artist_name),
      genre_norm = search_text(COALESCE(NEW.genre, '') || ' ' || COALESCE(
        (SELECT group_concat(genre, ' ') FROM album_genres WHERE album_id = ${id}), ''))`;
  // Composer and conductor: the tag text plus the credited artists' names.
  const credits = (composer: string, conductor: string, id: string) => `credits_norm = search_text(
        COALESCE(${composer}, '') || ' ' || COALESCE(${conductor}, '') || ' ' ||
        COALESCE((SELECT group_concat(ar.name, ' ') FROM track_artists ta JOIN artists ar ON ar.id = ta.artist_id
                   WHERE ta.track_id = ${id} AND ta.role IN ('composer', 'conductor')), ''))`;
  const creditsOf = (id: string) =>
    credits(
      `(SELECT t2.composer FROM tracks t2 WHERE t2.id = ${id})`,
      `(SELECT t2.conductor FROM tracks t2 WHERE t2.id = ${id})`,
      id,
    );
  const trackSet = `
      title_norm = search_text(NEW.title),
      artist_norm = search_text(COALESCE(NEW.artist_name, '') || ' ' || COALESCE(NEW.artist_names, '')),
      album_norm = search_text(NEW.album_title),
      ${credits('NEW.composer', 'NEW.conductor', 'NEW.id')}`;
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_artists_norm_ins AFTER INSERT ON artists BEGIN
      UPDATE artists SET ${artistSet} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_artists_norm_upd AFTER UPDATE OF name ON artists BEGIN
      UPDATE artists SET ${artistSet} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_albums_norm_ins AFTER INSERT ON albums BEGIN
      UPDATE albums SET ${albumSet('NEW.id')} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_albums_norm_upd AFTER UPDATE OF title, artist_name, genre ON albums BEGIN
      UPDATE albums SET ${albumSet('NEW.id')} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_album_genres_norm_ins AFTER INSERT ON album_genres BEGIN
      UPDATE albums SET genre_norm = search_text(COALESCE(genre, '') || ' ' || COALESCE(
        (SELECT group_concat(genre, ' ') FROM album_genres WHERE album_id = NEW.album_id), ''))
       WHERE id = NEW.album_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_album_genres_norm_del AFTER DELETE ON album_genres BEGIN
      UPDATE albums SET genre_norm = search_text(COALESCE(genre, '') || ' ' || COALESCE(
        (SELECT group_concat(genre, ' ') FROM album_genres WHERE album_id = OLD.album_id), ''))
       WHERE id = OLD.album_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_tracks_norm_ins AFTER INSERT ON tracks BEGIN
      UPDATE tracks SET ${trackSet} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_tracks_norm_upd
      AFTER UPDATE OF title, artist_name, artist_names, album_title, composer, conductor ON tracks BEGIN
      UPDATE tracks SET ${trackSet} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_track_artists_norm_ins AFTER INSERT ON track_artists BEGIN
      UPDATE tracks SET ${creditsOf('NEW.track_id')} WHERE id = NEW.track_id; END;
    CREATE TRIGGER IF NOT EXISTS trg_track_artists_norm_del AFTER DELETE ON track_artists BEGIN
      UPDATE tracks SET ${creditsOf('OLD.track_id')} WHERE id = OLD.track_id; END;
  `);

  // Fill what existed before the triggers (one pass; NULL means "never folded").
  const filled =
    sqlite
      .prepare(`UPDATE artists SET ${artistSet.replaceAll('NEW.', '')} WHERE name_norm IS NULL`)
      .run().changes +
    sqlite
      .prepare(
        `UPDATE albums SET ${albumSet('albums.id').replaceAll('NEW.', '')} WHERE title_norm IS NULL`,
      )
      .run().changes +
    sqlite
      .prepare(
        `UPDATE tracks SET ${trackSet
          .replace(
            credits('NEW.composer', 'NEW.conductor', 'NEW.id'),
            credits('composer', 'conductor', 'tracks.id'),
          )
          .replaceAll('NEW.', '')}
          WHERE title_norm IS NULL`,
      )
      .run().changes;
  if (filled > 0) logger.info(`Migration: ${filled} rows made searchable without accents (R05.4)`);
}

/**
 * Give every smart playlist without a definition one made from its rules.
 * Unreadable rules are left alone: the route already reports those, and a
 * guess would silently change what the playlist plays.
 */
function migrateSmartPlaylistDefinitions(sqlite: Database.Database): void {
  const rows = sqlite
    .prepare('SELECT id, rules FROM smart_playlists WHERE definition IS NULL')
    .all() as Array<{ id: string; rules: string }>;
  if (rows.length === 0) return;
  const update = sqlite.prepare('UPDATE smart_playlists SET definition = ? WHERE id = ?');
  let migrated = 0;
  for (const row of rows) {
    let rules: unknown;
    try {
      rules = JSON.parse(row.rules);
    } catch {
      continue;
    }
    const parsed = rulesSchema.safeParse(rules);
    if (!parsed.success) continue;
    update.run(JSON.stringify(legacyDefinition(parsed.data)), row.id);
    migrated += 1;
  }
  if (migrated > 0) {
    logger.info(`Migration: ${migrated} smart playlist(s) are Focus questions now (R05.3)`);
  }
}

function runMigration(
  sqlite: InstanceType<typeof Database>,
  table: string,
  column: string,
  type: string,
): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  logger.info(`Migration: added ${table}.${column}`);
}

/**
 * Databases created before roles existed have a `users` table without `role`
 * (seen on the Synology, 9 Sept 2026: `CREATE TABLE IF NOT EXISTS` in the
 * initial migration keeps such a table as it is, and the first registration
 * then failed with "table users has no column named role"). Add the column;
 * when accounts already exist but none is an admin, the oldest account
 * becomes admin so the installation stays administrable.
 */
function backfillUserRoles(sqlite: InstanceType<typeof Database>): void {
  const cols = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === 'role')) return;
  sqlite.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  logger.info('Migration: added users.role');
  const oldest = sqlite
    .prepare('SELECT id, username FROM users ORDER BY created_at ASC, rowid ASC LIMIT 1')
    .get() as { id: string; username: string } | undefined;
  if (!oldest) return;
  sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(oldest.id);
  logger.warn(`Migration: no admin existed; promoted oldest account "${oldest.username}" to admin`);
}

/**
 * Two tables were built for a household with one listener, and SQLite keeps
 * such rules inside the CREATE TABLE where no ALTER can reach them — so they
 * are rebuilt once (V09):
 *
 * - `favorites` carried UNIQUE(item_type, item_id), so the second person to
 *   like an album hit "UNIQUE constraint failed" instead of getting their own
 *   favourite.
 * - `scrobble_config` had `id INTEGER PRIMARY KEY DEFAULT 1` — the singleton
 *   row — so a second account connecting Last.fm collided on id 1.
 *
 * Both keep every row, their ids and their timestamps; only the table rule
 * changes. Detection is on the stored CREATE statement, so this runs once and
 * is a no-op on every later start.
 */
function rebuildHouseholdSingletons(sqlite: InstanceType<typeof Database>): void {
  const createSqlOf = (table: string): string =>
    (
      sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string | null } | undefined
    )?.sql ?? '';

  if (/UNIQUE\s*\(\s*item_type/i.test(createSqlOf('favorites'))) {
    sqlite.exec(`
      DROP TABLE IF EXISTS favorites_v09;
      CREATE TABLE favorites_v09 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      );
      INSERT INTO favorites_v09 (id, user_id, item_type, item_id, created_at)
        SELECT id, user_id, item_type, item_id, created_at FROM favorites;
      DROP TABLE favorites;
      ALTER TABLE favorites_v09 RENAME TO favorites;
      CREATE INDEX IF NOT EXISTS idx_favorites_type ON favorites (item_type, item_id);
    `);
    logger.info('Migration: favorites rebuilt, a favourite is now per user (V09)');
  }

  if (/id\s+INTEGER\s+PRIMARY\s+KEY\s+DEFAULT\s+1/i.test(createSqlOf('scrobble_config'))) {
    sqlite.exec(`
      DROP TABLE IF EXISTS scrobble_config_v09;
      CREATE TABLE scrobble_config_v09 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        lastfm_enabled INTEGER DEFAULT 0,
        lastfm_session_key TEXT,
        lastfm_username TEXT,
        listenbrainz_enabled INTEGER DEFAULT 0,
        listenbrainz_token TEXT
      );
      INSERT INTO scrobble_config_v09
        (id, user_id, lastfm_enabled, lastfm_session_key, lastfm_username,
         listenbrainz_enabled, listenbrainz_token)
        SELECT id, user_id, lastfm_enabled, lastfm_session_key, lastfm_username,
               listenbrainz_enabled, listenbrainz_token FROM scrobble_config;
      DROP TABLE scrobble_config;
      ALTER TABLE scrobble_config_v09 RENAME TO scrobble_config;
    `);
    logger.info('Migration: scrobble_config rebuilt, one account per user (V09)');
  }
}

/**
 * Personal profiles (V09.1). Playlists, favourites, smart playlists and the
 * single scrobble account used to belong to the household. They are handed
 * to one owner — the oldest admin, or the oldest account when no admin
 * exists — so an installation with one user keeps exactly what it had, now
 * with an owner on it. Nothing is deleted and no ownership is guessed per
 * row: rows that already have an owner are left alone, which makes this
 * safe to run on every start.
 */
function assignPersonalOwnership(sqlite: InstanceType<typeof Database>): void {
  rebuildHouseholdSingletons(sqlite);
  const owner = sqlite
    .prepare(
      "SELECT id FROM users ORDER BY (role = 'admin') DESC, created_at ASC, rowid ASC LIMIT 1",
    )
    .get() as { id: string } | undefined;

  if (owner) {
    let claimed = 0;
    for (const table of [
      'playlists',
      'smart_playlists',
      'favorites',
      'scrobble_config',
      'scrobble_queue',
      'listening_sessions',
    ]) {
      claimed += sqlite
        .prepare(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`)
        .run(owner.id).changes;
    }
    if (claimed > 0) {
      logger.info(`Migration: assigned ${claimed} personal row(s) to "${owner.id}" (V09)`);
    }
  }

  // A favourite is now one per user and item, not one per item for everyone.
  sqlite.exec('DROP INDEX IF EXISTS idx_favorites_unique_item');
  sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_unique_owner_item ON favorites (user_id, item_type, item_id)',
  );
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_playlists_owner ON playlists (user_id)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_smart_playlists_owner ON smart_playlists (user_id)');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_listening_user ON listening_sessions (user_id)');
  // Focus (R05.1): "played by me", "unplayed", plays and last played all read
  // one listener's qualified plays per track — answered from the index alone.
  sqlite.exec(
    'CREATE INDEX IF NOT EXISTS idx_listening_user_track ON listening_sessions (user_id, qualified, track_id, started_at)',
  );
  // One scrobble account per user; the pre-V09 singleton keeps its row.
  sqlite.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_scrobble_config_owner ON scrobble_config (user_id)',
  );
}

export { schema };

function resolveMigrationsFolder(): string {
  const local = fileURLToPath(new URL('./migrations', import.meta.url));
  if (hasJournal(local)) return local;

  const candidates = [
    join(process.cwd(), 'src', 'db', 'migrations'),
    join(process.cwd(), 'server', 'src', 'db', 'migrations'),
  ];
  const found = candidates.find(hasJournal);
  if (found) return found;

  return local;
}

function hasJournal(folder: string): boolean {
  return existsSync(join(folder, 'meta', '_journal.json'));
}

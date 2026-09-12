import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';
import { existsSync, mkdirSync } from 'fs';
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
export const SCHEMA_VERSION = 9;

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

/** A device id turned into something readable inside a zone id. */
export function slugForZone(deviceId: string): string {
  const slug = deviceId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'device';
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

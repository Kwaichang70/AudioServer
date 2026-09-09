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
export const SCHEMA_VERSION = 7;

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
 * Personal profiles (V09.1). Playlists, favourites, smart playlists and the
 * single scrobble account used to belong to the household. They are handed
 * to one owner — the oldest admin, or the oldest account when no admin
 * exists — so an installation with one user keeps exactly what it had, now
 * with an owner on it. Nothing is deleted and no ownership is guessed per
 * row: rows that already have an owner are left alone, which makes this
 * safe to run on every start.
 */
function assignPersonalOwnership(sqlite: InstanceType<typeof Database>): void {
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

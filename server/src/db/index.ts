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
export const SCHEMA_VERSION = 4;

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

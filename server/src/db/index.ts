import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

let db: ReturnType<typeof drizzle>;
let rawDb: InstanceType<typeof Database>;

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function getRawDb(): InstanceType<typeof Database> {
  if (!rawDb) throw new Error('Database not initialized');
  return rawDb;
}

/**
 * Initialise the database. Accepts an optional path override for tests so they
 * can spin up a throwaway sqlite file per suite without mutating process.env.
 */
export async function initDatabase(overridePath?: string) {
  const dbPath = overridePath ?? config.databasePath;
  mkdirSync(dirname(dbPath), { recursive: true });

  rawDb = new Database(dbPath);
  const sqlite = rawDb;
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

  logger.info(`Database initialized at ${dbPath}`);
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

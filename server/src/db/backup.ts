import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs';
import { dirname } from 'path';
import { DatabaseVersionError, getRawDb, readUserVersion, SCHEMA_VERSION } from './index.js';

/**
 * Consistent SQLite backup + restore (V01.4).
 *
 * Why not `cp audioserver.db`? The database runs in WAL mode, so committed
 * data can still live in `audioserver.db-wal`. Copying only the main file
 * silently loses the most recent writes and can produce a corrupt copy while
 * a transaction is in flight. SQLite's online backup API copies a consistent
 * snapshot through the open connection, and the result is a plain single-file
 * database that any SQLite tool can open.
 */

export interface BackupResult {
  path: string;
  bytes: number;
  schemaVersion: number;
  counts: TableCounts;
}

export interface TableCounts {
  users: number;
  artists: number;
  albums: number;
  tracks: number;
  playlists: number;
  playlistTracks: number;
  playHistory: number;
  listeningSessions: number;
  favorites: number;
  queueItems: number;
  providerTokens: number;
}

export interface DatabaseReport {
  path: string;
  bytes: number;
  schemaVersion: number;
  supportedSchemaVersion: number;
  compatible: boolean;
  integrity: 'ok' | string;
  counts: TableCounts;
}

const COUNTED_TABLES: Array<[keyof TableCounts, string]> = [
  ['users', 'users'],
  ['artists', 'artists'],
  ['albums', 'albums'],
  ['tracks', 'tracks'],
  ['playlists', 'playlists'],
  ['playlistTracks', 'playlist_tracks'],
  ['playHistory', 'play_history'],
  ['listeningSessions', 'listening_sessions'],
  ['favorites', 'favorites'],
  ['queueItems', 'queue_items'],
  ['providerTokens', 'provider_tokens'],
];

function countTables(sqlite: InstanceType<typeof Database>): TableCounts {
  const counts = {} as TableCounts;
  for (const [key, table] of COUNTED_TABLES) {
    try {
      counts[key] = (sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    } catch {
      // Older databases may predate a table; report 0 rather than failing the
      // whole report, the schema version tells the operator why.
      counts[key] = 0;
    }
  }
  return counts;
}

/**
 * Write a consistent snapshot of the open application database to `destPath`
 * using SQLite's online backup API. Safe to call while the server is running
 * and serving requests; the snapshot reflects one point in time.
 */
export async function backupDatabase(
  destPath: string,
  sqlite: InstanceType<typeof Database> = getRawDb(),
): Promise<BackupResult> {
  mkdirSync(dirname(destPath), { recursive: true });
  if (existsSync(destPath)) {
    throw new Error(`Refusing to overwrite existing backup: ${destPath}`);
  }
  // Force any pending WAL frames into the main file first so the snapshot is
  // as compact as possible; the backup API would include them anyway.
  try {
    sqlite.pragma('wal_checkpoint(PASSIVE)');
  } catch {
    // read-only connections cannot checkpoint; the backup is still consistent
  }
  await sqlite.backup(destPath);
  // The page copy inherits the WAL journal flag from the live database. Switch
  // the snapshot to a rollback journal so it is one self-contained file: no
  // -wal/-shm side files appear when something opens it, and `cp`/`scp` of the
  // single file is enough to move it around.
  const copy = new Database(destPath, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
    return {
      path: destPath,
      bytes: statSync(destPath).size,
      schemaVersion: readUserVersion(copy),
      counts: countTables(copy),
    };
  } finally {
    copy.close();
    for (const suffix of ['-wal', '-shm']) rmSync(destPath + suffix, { force: true });
  }
}

/**
 * Open a database file read-only and report what a restore would give you:
 * integrity, schema version vs. this build, and row counts of the tables an
 * operator cares about (accounts, library, playlists, history).
 */
export function inspectDatabase(path: string): DatabaseReport {
  if (!existsSync(path)) throw new Error(`Database file not found: ${path}`);
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrityRows = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const integrity =
      integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok'
        ? 'ok'
        : integrityRows.map((r) => r.integrity_check).join('; ');
    const schemaVersion = readUserVersion(sqlite);
    return {
      path,
      bytes: statSync(path).size,
      schemaVersion,
      supportedSchemaVersion: SCHEMA_VERSION,
      compatible: schemaVersion <= SCHEMA_VERSION,
      integrity,
      counts: countTables(sqlite),
    };
  } finally {
    sqlite.close();
  }
}

/**
 * True when another process holds the database open. SQLite cannot tell us
 * this directly; taking an exclusive lock on a throwaway connection fails
 * with SQLITE_BUSY while the server (or any other client) is connected.
 */
export function isDatabaseInUse(path: string): boolean {
  if (!existsSync(path)) return false;
  let probe: InstanceType<typeof Database> | undefined;
  try {
    probe = new Database(path, { fileMustExist: true, timeout: 0 });
    probe.pragma('locking_mode = EXCLUSIVE');
    probe.exec('BEGIN IMMEDIATE');
    probe.exec('COMMIT');
    return false;
  } catch {
    return true;
  } finally {
    probe?.close();
  }
}

export interface RestoreResult {
  targetPath: string;
  safetyCopy: string | null;
  report: DatabaseReport;
}

/**
 * Replace the database at `targetPath` with the backup at `backupPath`.
 *
 * Refuses when the backup is corrupt, was written by a newer build (schema
 * version above this build's), or when the target is still open by another
 * process. The previous database (main file + WAL/SHM) is moved aside as a
 * safety copy instead of deleted, so a wrong restore is itself reversible.
 */
export function restoreDatabase(backupPath: string, targetPath: string): RestoreResult {
  const report = inspectDatabase(backupPath);
  if (report.integrity !== 'ok') {
    throw new Error(`Backup failed integrity check: ${report.integrity}`);
  }
  if (!report.compatible) {
    throw new DatabaseVersionError(report.schemaVersion, SCHEMA_VERSION);
  }
  if (isDatabaseInUse(targetPath)) {
    throw new Error(
      `Database ${targetPath} is in use (is the server still running?). Stop it, then retry.`,
    );
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  let safetyCopy: string | null = null;
  if (existsSync(targetPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    safetyCopy = `${targetPath}.pre-restore-${stamp}`;
    renameSync(targetPath, safetyCopy);
  }
  // Stale WAL/SHM files belong to the old main file; with them gone SQLite
  // opens the restored file as a clean single-file database.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    rmSync(targetPath + suffix, { force: true });
  }
  copyFileSync(backupPath, targetPath);

  return { targetPath, safetyCopy, report: inspectDatabase(targetPath) };
}

/**
 * Consistent backup of the application database.
 *
 *   npm run db:backup --workspace=server -- [destination]
 *
 * Destination defaults to `<DATABASE_PATH dir>/backups/audioserver-<timestamp>.db`.
 * Works while the server is running (SQLite online backup API).
 */
import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'path';
import { config } from '../config.js';
import { backupDatabase } from '../db/backup.js';

async function main() {
  const source = resolve(config.databasePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const dest = resolve(
    process.argv[2] ?? join(dirname(source), 'backups', `audioserver-${stamp}.db`),
  );

  const sqlite = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const result = await backupDatabase(dest, sqlite);
    console.log(`Backup written: ${result.path}`);
    console.log(
      `  size: ${(result.bytes / 1024 / 1024).toFixed(2)} MB, schema v${result.schemaVersion}`,
    );
    console.log(
      `  users=${result.counts.users} tracks=${result.counts.tracks} albums=${result.counts.albums} ` +
        `playlists=${result.counts.playlists} history=${result.counts.playHistory} favorites=${result.counts.favorites}`,
    );
  } finally {
    sqlite.close();
  }
}

main().catch((err) => {
  console.error(`Backup failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

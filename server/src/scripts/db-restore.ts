/**
 * Restore a backup over the application database.
 *
 *   npm run db:restore --workspace=server -- <backup-file> [--yes]
 *
 * The server must be STOPPED first; the script refuses while the database is
 * open elsewhere. The current database is moved aside as
 * `<DATABASE_PATH>.pre-restore-<timestamp>` (not deleted). Without `--yes`
 * the script only prints what it would do.
 */
import { resolve } from 'path';
import { config } from '../config.js';
import { inspectDatabase, restoreDatabase } from '../db/backup.js';

const args = process.argv.slice(2);
const confirm = args.includes('--yes');
const backupArg = args.find((a) => !a.startsWith('--'));
if (!backupArg) {
  console.error('Usage: db-restore <backup-file> [--yes]');
  process.exit(2);
}
const backup = resolve(backupArg);
const target = resolve(config.databasePath);

try {
  const report = inspectDatabase(backup);
  console.log(`Backup:  ${backup}`);
  console.log(`Target:  ${target}`);
  console.log(
    `  schema v${report.schemaVersion} (this build supports <= v${report.supportedSchemaVersion}), integrity: ${report.integrity}`,
  );
  console.log(
    `  users=${report.counts.users} tracks=${report.counts.tracks} playlists=${report.counts.playlists} history=${report.counts.playHistory}`,
  );
  if (!confirm) {
    console.log('\nDry run. Re-run with --yes to restore (stop the server first).');
    process.exit(0);
  }
  const result = restoreDatabase(backup, target);
  console.log(`\nRestored ${result.targetPath}`);
  if (result.safetyCopy) console.log(`Previous database kept at ${result.safetyCopy}`);
  console.log('Start the server and check GET /api/health/ready.');
} catch (err) {
  console.error(`Restore failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

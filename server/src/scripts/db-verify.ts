/**
 * Inspect a database file (a backup or the live database) without changing it.
 *
 *   npm run db:verify --workspace=server -- [file]
 *
 * Exit code 0 = integrity ok and schema compatible with this build; 1 otherwise.
 * Use it before a restore, after an update (is the live DB what we expect?),
 * and before a rollback (does the old build accept this schema version?).
 */
import { resolve } from 'path';
import { config } from '../config.js';
import { inspectDatabase } from '../db/backup.js';

const file = resolve(process.argv[2] ?? config.databasePath);
try {
  const r = inspectDatabase(file);
  console.log(JSON.stringify(r, null, 2));
  const ok = r.integrity === 'ok' && r.compatible;
  if (!ok) {
    console.error(
      r.integrity !== 'ok'
        ? 'Integrity check FAILED'
        : `Schema version ${r.schemaVersion} is newer than this build supports (${r.supportedSchemaVersion})`,
    );
  }
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(`Verify failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, getDb, getRawDb, initDatabase } from '../db/index.js';
import { tracks } from '../db/schema.js';
import { EQUIVALENT_PATH_SQL } from '../services/scanner.js';

/**
 * Plan §6 (large libraries): the scanner looks each file up by its path, and
 * each new file also by the same path with other slashes (B14). Both were a
 * full table scan per file, so a 50 000-track first scan did 50 000 scans of a
 * growing table. They must stay index lookups.
 */
describe('scanner path lookups', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-scan-idx-'));
    initDatabase(join(dir, 'test.db'));
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  const plan = (sql: string, params: unknown[]) =>
    (
      getRawDb()
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...params) as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join('; ');

  it('finds a file by its exact path through an index', () => {
    const q = getDb().select().from(tracks).where(eq(tracks.filePath, '/m/a.flac')).toSQL();
    const detail = plan(q.sql, q.params);
    expect(detail).toMatch(/USING (COVERING )?INDEX idx_tracks_file_path\b/);
    expect(detail).not.toMatch(/^SCAN tracks$/);
  });

  it('finds the same file with other slashes through an index', () => {
    const detail = plan(EQUIVALENT_PATH_SQL, ['C:\\m\\a.flac', 'C:/m/a.flac']);
    expect(detail).toMatch(/USING INDEX idx_tracks_file_path_slashes/);
  });
});

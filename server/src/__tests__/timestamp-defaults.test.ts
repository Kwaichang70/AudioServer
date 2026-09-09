import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getDb, getRawDb, initDatabase } from '../db/index.js';
import { favorites, playlists } from '../db/schema.js';

/**
 * V05.1: Drizzle writes an explicit NULL for a column an insert omits, so the
 * SQL DEFAULT never fired and favorites/playlists/history rows had no time.
 * The schema now supplies the current UTC time for every omitted timestamp.
 */
describe('timestamp defaults on Drizzle inserts', () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-ts-'));
    await initDatabase(join(dir, 'ts.db'));
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fills created_at / updated_at when the insert omits them', () => {
    const before = Math.floor(Date.now() / 1000) - 1;
    const db = getDb();
    db.insert(favorites).values({ itemType: 'album', itemId: 'album-1' }).run();
    db.insert(playlists).values({ id: 'pl-1', name: 'Untimed' }).run();

    const fav = getRawDb()
      .prepare("SELECT created_at FROM favorites WHERE item_id = 'album-1'")
      .get() as { created_at: number | null };
    const pl = getRawDb()
      .prepare("SELECT created_at, updated_at FROM playlists WHERE id = 'pl-1'")
      .get() as { created_at: number | null; updated_at: number | null };

    expect(fav.created_at).not.toBeNull();
    expect(fav.created_at!).toBeGreaterThanOrEqual(before);
    expect(pl.created_at).not.toBeNull();
    expect(pl.updated_at).not.toBeNull();
  });
});

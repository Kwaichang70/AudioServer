import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/testApp.js';
import {
  closeDatabase,
  DatabaseVersionError,
  getRawDb,
  initDatabase,
  SCHEMA_VERSION,
} from '../db/index.js';
import { backupDatabase, inspectDatabase, isDatabaseInUse, restoreDatabase } from '../db/backup.js';

/**
 * V01.4: a backup is only a backup once it has been restored somewhere and the
 * data checked. This suite takes an online backup of a live database with an
 * account, library rows, a playlist and history, restores it onto an "empty
 * test installation" and verifies the rows through the normal startup path.
 */
describe('database backup and restore', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'audioserver-backup-'));
  let teardown: () => void;
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  let liveDbPath: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    liveDbPath = ctx.dbPath;

    // An account through the real registration route (bcrypt hash and all).
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'admin', password: 'changeme123' });
    expect(reg.status).toBe(200);
    const token = reg.body.data.token as string;

    // Library rows + playlist + history straight into the schema.
    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar1', 'Backup Artist');
      INSERT INTO albums (id, title, artist_id, artist_name)
        VALUES ('al1', 'Backup Album', 'ar1', 'Backup Artist');
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path, duration)
        VALUES ('tr1', 'Track One', 'al1', 'Backup Album', 'ar1', 'Backup Artist', '/music/one.flac', 200),
               ('tr2', 'Track Two', 'al1', 'Backup Album', 'ar1', 'Backup Artist', '/music/two.flac', 180);
    `);
    const pl = await request(app)
      .post('/api/playlists')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Restore me' });
    expect(pl.status).toBe(201);
    for (const trackId of ['tr1', 'tr2']) {
      const add = await request(app)
        .post(`/api/playlists/${pl.body.data.id}/tracks`)
        .set('Authorization', `Bearer ${token}`)
        .send({ trackId });
      expect([200, 201]).toContain(add.status);
    }
    db.prepare(
      'INSERT INTO play_history (track_id, album_id, artist_id, played_at) VALUES (?, ?, ?, ?)',
    ).run('tr1', 'al1', 'ar1', Math.floor(Date.now() / 1000));
  });

  afterAll(() => {
    teardown();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes a consistent snapshot while the database is open and busy', async () => {
    const dest = join(tmp, 'backups', 'snapshot.db');
    const result = await backupDatabase(dest);
    expect(existsSync(dest)).toBe(true);
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.counts).toMatchObject({
      users: 1,
      artists: 1,
      albums: 1,
      tracks: 2,
      playlists: 1,
      playlistTracks: 2,
      playHistory: 1,
    });

    // The snapshot must not depend on the live WAL file.
    expect(existsSync(dest + '-wal')).toBe(false);
    const report = inspectDatabase(dest);
    expect(report.integrity).toBe('ok');
    expect(report.compatible).toBe(true);

    await expect(backupDatabase(dest)).rejects.toThrow(/Refusing to overwrite/);
  });

  it('detects that the live database is still in use', () => {
    expect(isDatabaseInUse(liveDbPath)).toBe(true);
    expect(isDatabaseInUse(join(tmp, 'does-not-exist.db'))).toBe(false);
  });

  it('restores onto an empty installation and the data survives a normal startup', async () => {
    const backup = join(tmp, 'backups', 'snapshot.db');
    const target = join(tmp, 'fresh-install', 'audioserver.db');

    const restored = restoreDatabase(backup, target);
    expect(restored.safetyCopy).toBeNull();
    expect(restored.report.integrity).toBe('ok');

    // Detach the suite's live DB, boot the restored one through initDatabase
    // (migrations + version check) and read it back the way the app would.
    closeDatabase();
    await initDatabase(target);
    const db = getRawDb();
    expect(db.prepare('SELECT username, role FROM users').all()).toEqual([
      { username: 'admin', role: 'admin' },
    ]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM tracks').get() as { c: number }).c).toBe(2);
    expect(db.prepare('SELECT track_id FROM playlist_tracks ORDER BY position').all()).toEqual([
      { track_id: 'tr1' },
      { track_id: 'tr2' },
    ]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM play_history').get() as { c: number }).c).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    closeDatabase();

    // Restoring over an existing database keeps the old one as a safety copy
    // and refuses while it is in use.
    const busy = new Database(target);
    busy.pragma('journal_mode = WAL');
    busy.exec('CREATE TABLE IF NOT EXISTS scratch (x)');
    expect(() => restoreDatabase(backup, target)).toThrow(/in use/);
    busy.close();

    const again = restoreDatabase(backup, target);
    expect(again.safetyCopy).toMatch(/pre-restore-/);
    expect(existsSync(again.safetyCopy!)).toBe(true);
    expect(existsSync(target + '-wal')).toBe(false);

    // Hand the suite its live DB back so teardown closes the right handle.
    await initDatabase(liveDbPath);
  });

  it('refuses a backup that is corrupt or from a newer build', () => {
    const corrupt = join(tmp, 'corrupt.db');
    writeFileSync(corrupt, 'this is not a database');
    expect(() => inspectDatabase(corrupt)).toThrow();

    const newer = join(tmp, 'newer.db');
    const db = new Database(newer);
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const report = inspectDatabase(newer);
    expect(report.compatible).toBe(false);
    expect(() => restoreDatabase(newer, join(tmp, 'x', 'target.db'))).toThrow(DatabaseVersionError);
  });
});

describe('schema version guard (rollback safety)', () => {
  it('refuses to open a database migrated by a newer build, upgrades older ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audioserver-version-'));
    try {
      const path = join(dir, 'future.db');
      const db = new Database(path);
      db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
      db.close();
      await expect(initDatabase(path)).rejects.toThrow(DatabaseVersionError);
      await expect(initDatabase(path)).rejects.toThrow(/newer than this build supports/);

      const legacy = join(dir, 'legacy.db');
      await initDatabase(legacy);
      expect(getRawDb().pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
      closeDatabase();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

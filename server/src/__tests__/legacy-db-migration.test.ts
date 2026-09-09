import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getRawDb, initDatabase, SCHEMA_VERSION } from '../db/index.js';

/**
 * V06.4: a database shaped like the very first AudioServer releases (no
 * Drizzle journal, tracks without file identity columns, users without
 * role, history without time) goes through every migration and keeps its
 * data. This is the shape the Synology carried until September 2026.
 */
describe('migrating an early-release database', () => {
  let dir: string;
  let path: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-legacy-db-'));
    path = join(dir, 'old.db');
    const db = new Database(path);
    db.exec(`
      CREATE TABLE artists (id TEXT PRIMARY KEY, name TEXT NOT NULL, image_url TEXT, source TEXT NOT NULL DEFAULT 'local', created_at INTEGER, updated_at INTEGER);
      CREATE TABLE albums (id TEXT PRIMARY KEY, title TEXT NOT NULL, artist_id TEXT NOT NULL, artist_name TEXT NOT NULL, year INTEGER, genre TEXT, cover_url TEXT, track_count INTEGER DEFAULT 0, source TEXT NOT NULL DEFAULT 'local', created_at INTEGER, updated_at INTEGER);
      CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT NOT NULL, album_id TEXT NOT NULL, album_title TEXT NOT NULL, artist_id TEXT NOT NULL, artist_name TEXT NOT NULL, track_number INTEGER, disc_number INTEGER DEFAULT 1, duration REAL, format TEXT, sample_rate INTEGER, bit_depth INTEGER, file_path TEXT, cover_url TEXT, source TEXT NOT NULL DEFAULT 'local', created_at INTEGER, updated_at INTEGER);
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()));
      CREATE TABLE play_history (id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, album_id TEXT NOT NULL, artist_id TEXT NOT NULL, played_at INTEGER);
      CREATE TABLE favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, item_type TEXT NOT NULL, item_id TEXT NOT NULL, created_at INTEGER);
      CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, track_count INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER);
      CREATE TABLE playlist_tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, position INTEGER NOT NULL, added_at INTEGER);
      INSERT INTO artists (id, name) VALUES ('ar', 'Old Artist');
      INSERT INTO albums (id, title, artist_id, artist_name, track_count) VALUES ('al', 'Old Album', 'ar', 'Old Artist', 1);
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration, file_path) VALUES ('t', 'Old Track', 'al', 'Old Album', 'ar', 'Old Artist', 200, '//diskstation/Music/old.flac');
      INSERT INTO users (id, username, password_hash) VALUES ('u', 'danny', 'hash');
      INSERT INTO play_history (track_id, album_id, artist_id, played_at) VALUES ('t', 'al', 'ar', NULL);
      INSERT INTO play_history (track_id, album_id, artist_id, played_at) VALUES ('t', '', '', 1700000000);
      INSERT INTO favorites (item_type, item_id) VALUES ('track', 't');
      INSERT INTO playlists (id, name) VALUES ('pl', 'Old Playlist');
      INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('pl', 't', 0);
    `);
    db.close();
    await initDatabase(path);
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  const columns = (table: string) =>
    (getRawDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );

  it('reaches the current schema version with every new table and column', () => {
    expect(getRawDb().pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(columns('users')).toContain('role');
    for (const col of [
      'file_size',
      'file_mtime',
      'fingerprint',
      'scan_version',
      'availability',
      'missing_since',
      'replay_gain_track',
      'artist_names',
    ]) {
      expect(columns('tracks')).toContain(col);
    }
    const tables = (
      getRawDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    for (const t of [
      'sessions',
      'queue_items',
      'listening_sessions',
      'scan_runs',
      'scrobble_queue',
    ]) {
      expect(tables).toContain(t);
    }
  });

  it('keeps the library, account and user data', () => {
    const db = getRawDb();
    expect(db.prepare('SELECT COUNT(*) as c FROM tracks').get()).toEqual({ c: 1 });
    expect(
      db.prepare("SELECT availability, scan_version FROM tracks WHERE id = 't'").get(),
    ).toEqual({ availability: 'available', scan_version: null });
    expect(db.prepare("SELECT role FROM users WHERE id = 'u'").get()).toEqual({ role: 'admin' });
    expect(db.prepare('SELECT COUNT(*) as c FROM favorites').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) as c FROM playlist_tracks').get()).toEqual({ c: 1 });
  });

  it('copies the old history without inventing times, and resolves ids from the track', () => {
    const rows = getRawDb()
      .prepare(
        'SELECT id, track_id, title, artist_name, album_id, artist_id, started_at, source, qualified FROM listening_sessions ORDER BY id',
      )
      .all();
    expect(rows).toEqual([
      {
        id: 'legacy-1',
        track_id: 't',
        title: 'Old Track',
        artist_name: 'Old Artist',
        album_id: 'al',
        artist_id: 'ar',
        started_at: null,
        source: 'legacy',
        qualified: 1,
      },
      {
        id: 'legacy-2',
        track_id: 't',
        title: 'Old Track',
        artist_name: 'Old Artist',
        album_id: 'al',
        artist_id: 'ar',
        started_at: 1700000000,
        source: 'legacy',
        qualified: 1,
      },
    ]);
  });

  it('opens a second time without re-running anything', async () => {
    closeDatabase();
    await expect(initDatabase(path)).resolves.toBeUndefined();
    expect(getRawDb().prepare('SELECT COUNT(*) as c FROM listening_sessions').get()).toEqual({
      c: 2,
    });
  });
});

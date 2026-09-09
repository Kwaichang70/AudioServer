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

/**
 * V09: `favorites` and `scrobble_config` were created for a household with a
 * single listener — UNIQUE(item_type, item_id) and `id INTEGER PRIMARY KEY
 * DEFAULT 1` — and SQLite keeps both rules inside the CREATE TABLE, out of
 * reach of ALTER. This is the shape every installation carries, the Synology
 * included, so the rebuild has to keep every row.
 */
describe('rebuilding the household-singleton tables', () => {
  let dir: string;
  let path: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-v09-db-'));
    path = join(dir, 'household.db');
    const db = new Database(path);
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at INTEGER DEFAULT (unixepoch()));
      CREATE TABLE favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(item_type, item_id)
      );
      CREATE TABLE scrobble_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        lastfm_enabled INTEGER DEFAULT 0,
        lastfm_session_key TEXT,
        lastfm_username TEXT,
        listenbrainz_enabled INTEGER DEFAULT 0,
        listenbrainz_token TEXT
      );
      INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'danny', 'h', 'admin');
      INSERT INTO users (id, username, password_hash) VALUES ('u2', 'guest', 'h');
      INSERT INTO favorites (id, item_type, item_id, created_at) VALUES (7, 'album', 'al', 1700000000);
      INSERT INTO scrobble_config (id, listenbrainz_enabled, listenbrainz_token) VALUES (1, 1, 'household-token');
    `);
    db.close();
    await initDatabase(path);
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the existing rows, ids included, and hands them to the admin', () => {
    const fav = getRawDb().prepare('SELECT * FROM favorites').get() as {
      id: number;
      user_id: string;
      item_id: string;
      created_at: number;
    };
    expect(fav).toMatchObject({ id: 7, user_id: 'u1', item_id: 'al', created_at: 1700000000 });

    const config = getRawDb().prepare('SELECT * FROM scrobble_config').get() as {
      id: number;
      user_id: string;
      listenbrainz_token: string;
    };
    expect(config).toMatchObject({ id: 1, user_id: 'u1', listenbrainz_token: 'household-token' });
  });

  it('lets the second account like the same album and keep its own scrobble account', () => {
    const db = getRawDb();
    expect(() =>
      db
        .prepare("INSERT INTO favorites (user_id, item_type, item_id) VALUES ('u2', 'album', 'al')")
        .run(),
    ).not.toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO scrobble_config (user_id, listenbrainz_token) VALUES ('u2', 'own')")
        .run(),
    ).not.toThrow();

    // The same person still cannot like the same album twice.
    expect(() =>
      db
        .prepare("INSERT INTO favorites (user_id, item_type, item_id) VALUES ('u2', 'album', 'al')")
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('is a no-op on a second start', async () => {
    closeDatabase();
    await initDatabase(path);
    expect(getRawDb().prepare('SELECT COUNT(*) as n FROM favorites').get()).toEqual({ n: 2 });
    expect(getRawDb().prepare('SELECT COUNT(*) as n FROM scrobble_config').get()).toEqual({ n: 2 });
  });
});

/**
 * V10.1: the household's single queue becomes the queue of a zone. Whatever
 * was playing keeps playing — it is now the zone of the device it was on.
 */
describe('turning the household session into zones', () => {
  let dir: string;
  let path: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-v10-db-'));
    path = join(dir, 'zones.db');
    const db = new Database(path);
    // The shape of the very first release: one session row, one queue, no
    // item ids yet. Every later migration runs on top of it.
    db.exec(`
      CREATE TABLE playback_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        device_id TEXT DEFAULT 'browser',
        track_id TEXT,
        state TEXT DEFAULT 'stopped',
        position REAL DEFAULT 0,
        volume INTEGER DEFAULT 50,
        shuffle INTEGER DEFAULT 0,
        repeat TEXT DEFAULT 'off',
        updated_at INTEGER DEFAULT (unixepoch())
      );
      CREATE TABLE queue_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL,
        track_title TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        album_title TEXT NOT NULL,
        album_id TEXT,
        duration REAL,
        source TEXT DEFAULT 'local',
        position INTEGER NOT NULL,
        added_at INTEGER DEFAULT (unixepoch())
      );
      INSERT INTO playback_state (id, device_id, track_id, state, position, volume)
        VALUES (1, 'sonos-office', 't1', 'playing', 61.5, 30);
      INSERT INTO queue_items (track_id, track_title, artist_name, album_title, position)
        VALUES ('t1', 'Song', 'Band', 'Album', 0),
               ('t2', 'Song 2', 'Band', 'Album', 1);
    `);
    db.close();
    await initDatabase(path);
  });

  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the session as the zone of the device it was playing on', () => {
    const zone = getRawDb()
      .prepare("SELECT id, name, device_id, is_default FROM zones WHERE device_id = 'sonos-office'")
      .get() as { id: string; device_id: string; is_default: number };
    expect(zone).toMatchObject({ id: 'zone-sonos-office', device_id: 'sonos-office' });
    expect(zone.is_default).toBe(0);

    const state = getRawDb()
      .prepare('SELECT * FROM playback_state WHERE zone_id = ?')
      .get(zone.id) as { track_id: string; position: number; volume: number; state: string };
    expect(state).toMatchObject({
      track_id: 't1',
      position: 61.5,
      volume: 30,
      state: 'playing',
    });

    const items = getRawDb()
      .prepare('SELECT track_id FROM queue_items WHERE zone_id = ? ORDER BY position')
      .all(zone.id) as Array<{ track_id: string }>;
    expect(items.map((i) => i.track_id)).toEqual(['t1', 't2']);
  });

  it('always has a default browser zone, and only one zone per device', () => {
    const db = getRawDb();
    const browser = db.prepare("SELECT * FROM zones WHERE id = 'zone-browser'").get() as {
      device_id: string;
      is_default: number;
    };
    expect(browser).toMatchObject({ device_id: 'browser', is_default: 1 });

    expect(() =>
      db
        .prepare(
          "INSERT INTO zones (id, name, device_id) VALUES ('zone-other', 'Other', 'sonos-office')",
        )
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('is a no-op on a second start', async () => {
    closeDatabase();
    await initDatabase(path);
    const db = getRawDb();
    expect(db.prepare('SELECT COUNT(*) as n FROM zones').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) as n FROM playback_state').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) as n FROM queue_items').get()).toEqual({ n: 2 });
  });
});

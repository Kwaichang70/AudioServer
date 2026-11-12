import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { atomically, closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import {
  albumFolderOf,
  EMPTY_ROOT_GUARD_MIN_TRACKS,
  purgeMissingTracks,
  scanLibrary,
} from '../services/scanner.js';

/**
 * Phase 10 (D01–D10): what a scan and a schema change leave behind when
 * something goes wrong halfway, and what they must not conclude from a
 * share that is not there.
 *
 * Tags come from the file name: every file is on the album "Box Set" unless
 * its name starts with another album ("<album>__<title>.flac").
 */
vi.mock('music-metadata', () => ({
  selectCover: vi.fn(() => null),
  parseFile: vi.fn(async (filePath: string) => {
    const name = String(filePath)
      .split(/[\\/]/)
      .pop()!
      .replace(/\.[^.]+$/, '');
    const [album, title] = name.includes('__') ? name.split('__') : ['Box Set', name];
    return {
      common: {
        artist: 'The Band',
        artists: ['The Band'],
        album,
        title,
        genre: ['Rock'],
        track: { no: Number(title.match(/\d+/)?.[0] ?? 1) },
        disk: { no: 1 },
      },
      format: { duration: 200, sampleRate: 44100, bitsPerSample: 16 },
    };
  }),
}));

let tmp: string;
const slash = (p: string) => p.replace(/\\/g, '/');
const makeRoot = (name: string) => {
  const dir = slash(join(tmp, name));
  mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (dir: string, file: string, content = 'audio') => {
  mkdirSync(slash(join(dir, file, '..')), { recursive: true });
  writeFileSync(join(dir, file), content);
};
const count = (sql: string, ...args: unknown[]) =>
  (
    getRawDb()
      .prepare(sql)
      .get(...args) as { n: number }
  ).n;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'audioserver-phase10-'));
  await initDatabase(join(tmp, 'test.db'));
});

afterEach(() => {
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('a file that fails halfway (D01)', () => {
  it('leaves nothing behind, and is read again by the next scan', async () => {
    const root = makeRoot('music');
    put(root, '01.flac');
    // The credits cannot be written: the scan of this file stops there.
    getRawDb().exec(
      "CREATE TRIGGER fail_credits BEFORE INSERT ON track_artists BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const failed = await scanLibrary([root], { trigger: 'test' });
    expect(failed.errors).toBe(1);
    // Without the transaction the track stayed, looking complete and current.
    expect(count('SELECT COUNT(*) AS n FROM tracks')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM albums')).toBe(0);

    getRawDb().exec('DROP TRIGGER fail_credits');
    const ok = await scanLibrary([root], { trigger: 'test' });
    expect(ok.newTracks).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM track_artists')).toBeGreaterThan(0);
  });
});

describe('a schema rebuild that fails halfway (D02)', () => {
  it('keeps the table it was rebuilding', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(
      "CREATE TABLE favorites (id INTEGER PRIMARY KEY, item TEXT); INSERT INTO favorites (item) VALUES ('a')",
    );
    expect(() =>
      atomically(sqlite, () => {
        sqlite.exec(`
          CREATE TABLE favorites_new (id INTEGER PRIMARY KEY, item TEXT);
          INSERT INTO favorites_new SELECT id, item FROM favorites;
          DROP TABLE favorites;
        `);
        throw new Error('power cut before the rename');
      }),
    ).toThrow('power cut');
    const rows = sqlite.prepare('SELECT item FROM favorites').all();
    expect(rows).toEqual([{ item: 'a' }]);
    const leftovers = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE name = 'favorites_new'")
      .all();
    expect(leftovers).toEqual([]);
    sqlite.close();
  });
});

describe('a share that is not mounted (D03)', () => {
  const fill = (root: string, n: number) => {
    for (let i = 1; i <= n; i++) put(root, `track-${i}.flac`, `audio-${i}`);
  };
  const empty = (root: string) => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true }); // the empty mount point
  };

  it('does not mark a whole library missing when its root comes up empty', async () => {
    const root = makeRoot('nas');
    fill(root, EMPTY_ROOT_GUARD_MIN_TRACKS);
    await scanLibrary([root], { trigger: 'test' });
    empty(root);

    const status = await scanLibrary([root], { trigger: 'test' });
    expect(status.successfulRoots).toEqual([]);
    expect(status.failedRoots[0]?.error).toMatch(/is the share mounted/);
    expect(status.orphanCleanupSkipped).toBe(true);
    expect(count("SELECT COUNT(*) AS n FROM tracks WHERE availability = 'missing'")).toBe(0);
  });

  it('still marks the last few files of a folder missing when they are removed', async () => {
    const root = makeRoot('small');
    fill(root, 3);
    await scanLibrary([root], { trigger: 'test' });
    empty(root);
    const status = await scanLibrary([root], { trigger: 'test' });
    expect(status.successfulRoots).toEqual([root]);
    expect(count("SELECT COUNT(*) AS n FROM tracks WHERE availability = 'missing'")).toBe(3);
  });
});

describe('a copy on another root while the first root is away (D10)', () => {
  it('is a new track; the original keeps its identity', async () => {
    const rootA = makeRoot('a');
    const rootB = makeRoot('b');
    put(rootA, 'song.flac', 'same-bytes');
    await scanLibrary([rootA, rootB], { trigger: 'test' });
    const original = getRawDb().prepare('SELECT id, file_path FROM tracks').get() as {
      id: string;
      file_path: string;
    };

    // Root A is gone (an empty mount point); the same file exists on B.
    rmSync(rootA, { recursive: true, force: true });
    mkdirSync(rootA, { recursive: true });
    put(rootB, 'song.flac', 'same-bytes');
    const status = await scanLibrary([rootA, rootB], { trigger: 'test' });

    expect(status.relinkedTracks).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM tracks')).toBe(2);
    const still = getRawDb().prepare('SELECT file_path FROM tracks WHERE id = ?').get(original.id);
    expect(still).toEqual({ file_path: original.file_path });
  });
});

describe('disc folders (D07)', () => {
  it('reads "Album/CD1" and "Album/CD2" as one album', async () => {
    const root = makeRoot('discs');
    put(root, 'Box Set/CD1/01.flac', 'a');
    put(root, 'Box Set/CD1/02.flac', 'b');
    put(root, 'Box Set/CD2/03.flac', 'c');
    put(root, 'Other/Other__01.flac', 'd');
    await scanLibrary([root], { trigger: 'test' });

    const albums = getRawDb().prepare('SELECT title, track_count FROM albums ORDER BY title').all();
    expect(albums).toEqual([
      { title: 'Box Set', track_count: 3 },
      { title: 'Other', track_count: 1 },
    ]);
  });

  it('knows a disc folder from an album that happens to be called CD', () => {
    expect(albumFolderOf('/m/Album/CD1/01.flac')).toBe('/m/Album');
    expect(albumFolderOf('/m/Album/Disc 2/01.flac')).toBe('/m/Album');
    expect(albumFolderOf('/m/Album/disk_03/01.flac')).toBe('/m/Album');
    expect(albumFolderOf('/m/CD Collection/01.flac')).toBe('/m/CD Collection');
    expect(albumFolderOf('/m/Album/CD1 Bonus/01.flac')).toBe('/m/Album/CD1 Bonus');
  });

  it('keeps a library scanned per disc as it is until a full rescan merges it', async () => {
    const root = makeRoot('legacy');
    put(root, 'Box Set/CD1/01.flac', 'a');
    put(root, 'Box Set/CD2/02.flac', 'b');
    await scanLibrary([root], { trigger: 'test' });
    // Make it look like a pre-D07 library: one album per disc folder.
    const db = getRawDb();
    const merged = db.prepare('SELECT * FROM albums').get() as Record<string, unknown>;
    const perDisc = (disc: string, id: string) => {
      const key = String(merged.edition_key).replace('/box set|', `/box set/${disc}|`);
      db.prepare(
        `INSERT INTO albums (id, title, artist_id, artist_name, source, edition_key, track_count)
         VALUES (?, ?, ?, ?, 'local', ?, 1)`,
      ).run(id, merged.title, merged.artist_id, merged.artist_name, key);
    };
    perDisc('cd1', 'old-cd1');
    perDisc('cd2', 'old-cd2');
    db.prepare("UPDATE tracks SET album_id = 'old-cd1' WHERE file_path LIKE '%CD1%'").run();
    db.prepare("UPDATE tracks SET album_id = 'old-cd2' WHERE file_path LIKE '%CD2%'").run();
    db.prepare('DELETE FROM albums WHERE id = ?').run(merged.id);
    db.prepare(
      "INSERT INTO favorites (user_id, item_type, item_id) VALUES ('u1', 'album', 'old-cd1')",
    ).run();

    // One file changes: it stays on its disc's album.
    put(root, 'Box Set/CD1/01.flac', 'a-retagged');
    await scanLibrary([root], { trigger: 'test' });
    expect(count('SELECT COUNT(*) AS n FROM albums')).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM tracks WHERE album_id = 'old-cd1'")).toBe(1);

    // A full rescan merges the discs and takes the favourite along.
    await scanLibrary([root], { trigger: 'test', force: true });
    const albums = db.prepare('SELECT id, track_count FROM albums').all() as Array<{
      id: string;
      track_count: number;
    }>;
    expect(albums).toHaveLength(1);
    expect(albums[0].track_count).toBe(2);
    expect(db.prepare("SELECT item_id FROM favorites WHERE item_type = 'album'").all()).toEqual([
      { item_id: albums[0].id },
    ]);
  });
});

describe('cleaning up missing tracks (D06)', () => {
  it('takes their ratings and tags along', async () => {
    const root = makeRoot('purge');
    put(root, 'keep.flac', 'k');
    put(root, 'Gone__01.flac', 'g');
    await scanLibrary([root], { trigger: 'test' });
    const db = getRawDb();
    const gone = db.prepare("SELECT id, album_id FROM tracks WHERE title = '01'").get() as {
      id: string;
      album_id: string;
    };
    db.prepare(
      "INSERT INTO ratings (user_id, item_type, item_id, rating) VALUES ('u1', 'track', ?, 5)",
    ).run(gone.id);
    db.prepare(
      "INSERT INTO ratings (user_id, item_type, item_id, rating) VALUES ('u1', 'album', ?, 4)",
    ).run(gone.album_id);
    db.prepare("INSERT INTO tags (id, user_id, name) VALUES ('t1', 'u1', 'Late')").run();
    db.prepare("INSERT INTO tag_items (tag_id, item_type, item_id) VALUES ('t1', 'track', ?)").run(
      gone.id,
    );

    rmSync(join(root, 'Gone__01.flac'));
    await scanLibrary([root], { trigger: 'test' });
    expect(purgeMissingTracks()).toBe(1);

    expect(count('SELECT COUNT(*) AS n FROM ratings')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM tag_items')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM tracks')).toBe(1);
  });
});

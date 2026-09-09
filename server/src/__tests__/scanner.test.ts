import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import {
  fingerprintOf,
  listMissingTracks,
  listScanRuns,
  purgeMissingTracks,
  relinkMissingTrack,
  SCAN_VERSION,
  scanLibrary,
} from '../services/scanner.js';

interface TrackRow {
  id: string;
  title: string;
  artist_name: string;
  artist_names: string | null;
  composer: string | null;
  conductor: string | null;
  file_path: string | null;
  file_size: number | null;
  file_mtime: number | null;
  fingerprint: string | null;
  scan_version: number | null;
  availability: string;
  missing_since: number | null;
  album_id: string;
}

/**
 * Tag stand-in: the title comes from the file name, except files called
 * `song-*.mp3`, which all carry the same tags ("the same recording at a
 * different path"), and `alt-*.mp3`, a different recording with the same
 * title (only the duration differs).
 */
vi.mock('music-metadata', () => ({
  selectCover: vi.fn(
    (pictures?: Array<{ data: Uint8Array; format: string }>) => pictures?.[0] ?? null,
  ),
  parseFile: vi.fn(async (filePath: string) => {
    const fileName = String(filePath).split(/[\\/]/).pop() ?? 'track.mp3';
    const sameRecording = fileName.startsWith('song-');
    const altRecording = fileName.startsWith('alt-');
    const title = sameRecording || altRecording ? 'Same Song' : fileName.replace(/\.[^.]+$/, '');
    return {
      common: {
        artist: 'Scanned Artist',
        album: 'Scanned Album',
        title,
        artists: ['Scanned Artist', 'Guest Artist'],
        composer: ['Composer One'],
        conductor: ['Conductor One'],
        track: { no: 1 },
        disk: { no: 1 },
      },
      format: {
        duration: altRecording ? 200 : 180,
        sampleRate: 44100,
        bitsPerSample: 16,
      },
    };
  }),
}));

describe('scanner: library preservation (V06)', () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-scanner-test-'));
    await initDatabase(join(tmp, 'test.db'));
  });

  afterEach(() => {
    try {
      getRawDb().close();
    } catch {
      // ignore
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('keeps every track when all configured roots are unreachable', async () => {
    const missingRoot = join(tmp!, 'offline-share');
    const trackPath = `${missingRoot}/still-present-on-nas.mp3`;
    insertLocalTrack('offline-track', trackPath);

    const status = await scanLibrary([missingRoot], { trigger: 'test' });

    expect(getTrack('offline-track')?.availability).toBe('available');
    expect(status.orphanCleanupSkipped).toBe(true);
    expect(status.failedRoots).toHaveLength(1);
    expect(status.failedRoots[0].path).toBe(missingRoot);
    expect(status.missingTracks).toBe(0);
  });

  it('marks files missing only under roots that scanned successfully, and deletes nothing', async () => {
    const onlineRoot = join(tmp!, 'online-share');
    const offlineRoot = join(tmp!, 'offline-share');
    mkdirSync(onlineRoot);

    insertLocalTrack('online-orphan', `${onlineRoot}/deleted.mp3`);
    insertLocalTrack('offline-preserved', `${offlineRoot}/temporarily-unreachable.mp3`);

    const status = await scanLibrary([onlineRoot, offlineRoot], { trigger: 'test' });

    expect(getTrack('online-orphan')).toMatchObject({ availability: 'missing' });
    expect(getTrack('online-orphan')?.missing_since).not.toBeNull();
    expect(getTrack('offline-preserved')?.availability).toBe('available');
    expect(status.orphanCleanupSkipped).toBe(false);
    expect(status.successfulRoots).toEqual([onlineRoot]);
    expect(status.missingTracks).toBe(1);
    expect(status.removedTracks).toBe(1);
  });

  it('an unreadable subdirectory keeps its items and marks the root as failed', async () => {
    if (process.getuid?.() === 0) return; // root ignores permission bits
    const root = join(tmp!, 'music');
    const locked = join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(root, 'open.mp3'), '');
    insertLocalTrack('locked-track', `${locked}/inside.mp3`);
    chmodSync(locked, 0o000);
    try {
      const status = await scanLibrary([root], { trigger: 'test' });
      expect(getTrack('locked-track')?.availability).toBe('available');
      expect(status.failedRoots).toHaveLength(1);
      expect(status.failedRoots[0].failedDirs).toEqual([locked]);
      expect(getTrackByPath(`${root}/open.mp3`)).toBeTruthy();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('a deleted file stays as a missing row until an explicit purge', async () => {
    const root = join(tmp!, 'music');
    mkdirSync(root);
    insertLocalTrack('deleted-track', `${root}/deleted.mp3`);
    addUserData('deleted-track');

    await scanLibrary([root], { trigger: 'test' });
    expect(getTrack('deleted-track')?.availability).toBe('missing');
    expect(userData('deleted-track')).toEqual({ playlist: 1, favorite: 1, sessions: 1 });

    // A second scan does not count it again.
    const again = await scanLibrary([root], { trigger: 'test' });
    expect(again.missingTracks).toBe(0);

    expect(purgeMissingTracks()).toBe(1);
    expect(getTrack('deleted-track')).toBeUndefined();
    expect(userData('deleted-track')).toEqual({ playlist: 0, favorite: 0, sessions: 1 });
  });

  it('a moved file keeps its identity: playlist, favorite and history follow', async () => {
    const root = join(tmp!, 'music');
    mkdirSync(root);
    const oldPath = `${root}/song-a.mp3`;
    writeFileSync(oldPath, 'bytes');
    const first = await scanLibrary([root], { trigger: 'test' });
    expect(first.newTracks).toBe(1);
    const original = getTrackByPath(oldPath)!;
    expect(original.fingerprint).not.toBeNull();
    expect(original.file_size).toBe(5);
    expect(original.scan_version).toBe(SCAN_VERSION);
    addUserData(original.id);

    mkdirSync(join(root, 'moved'));
    renameSync(oldPath, `${root}/moved/song-b.mp3`);
    const second = await scanLibrary([root], { trigger: 'test' });

    expect(second.relinkedTracks).toBe(1);
    expect(second.newTracks).toBe(0);
    expect(second.missingTracks).toBe(0);
    const moved = getTrack(original.id);
    expect(moved).toMatchObject({
      file_path: `${root}/moved/song-b.mp3`,
      availability: 'available',
    });
    expect(userData(original.id)).toEqual({ playlist: 1, favorite: 1, sessions: 1 });
  });

  it('never merges a doubtful match: same title but a different recording is new', async () => {
    const root = join(tmp!, 'music');
    mkdirSync(root);
    writeFileSync(`${root}/song-a.mp3`, 'bytes');
    await scanLibrary([root], { trigger: 'test' });
    const original = getTrackByPath(`${root}/song-a.mp3`)!;

    rmSync(`${root}/song-a.mp3`);
    writeFileSync(`${root}/alt-a.mp3`, 'bytes'); // same title, other duration
    const status = await scanLibrary([root], { trigger: 'test' });

    expect(status.newTracks).toBe(1);
    expect(status.relinkedTracks).toBe(0);
    expect(getTrack(original.id)?.availability).toBe('missing');
    const missing = listMissingTracks();
    expect(missing).toHaveLength(1);
    expect(missing[0].candidates.map((c) => c.strength)).toEqual(['weak']);
  });

  it('two identical candidates for one new file are left to the admin', async () => {
    const root = join(tmp!, 'music');
    mkdirSync(root);
    writeFileSync(`${root}/song-a.mp3`, 'bytes');
    writeFileSync(`${root}/song-b.mp3`, 'bytes'); // same fingerprint: same bytes and tags
    await scanLibrary([root], { trigger: 'test' });
    rmSync(`${root}/song-a.mp3`);
    rmSync(`${root}/song-b.mp3`);
    writeFileSync(`${root}/song-c.mp3`, 'bytes');

    const status = await scanLibrary([root], { trigger: 'test' });

    expect(status.doubtfulTracks).toBe(1);
    expect(status.newTracks).toBe(1);
    expect(status.missingTracks).toBe(2);
    const missing = listMissingTracks();
    expect(missing).toHaveLength(2);
    expect(missing[0].candidates[0]).toMatchObject({ strength: 'strong' });
  });

  it('relink moves a missing track’s user data to the chosen available track', async () => {
    const root = join(tmp!, 'music');
    mkdirSync(root);
    insertLocalTrack('gone', `${root}/gone.mp3`);
    addUserData('gone');
    writeFileSync(`${root}/kept.mp3`, '');
    await scanLibrary([root], { trigger: 'test' });
    const kept = getTrackByPath(`${root}/kept.mp3`)!;

    expect(relinkMissingTrack('gone', kept.id)).toEqual({
      playlistRefs: 1,
      favorites: 1,
      sessions: 1,
    });
    expect(getTrack('gone')).toBeUndefined();
    expect(userData(kept.id)).toEqual({ playlist: 1, favorite: 1, sessions: 1 });
    expect(relinkMissingTrack('gone', kept.id)).toBeNull();
  });

  it('a missing file that comes back is recovered, unchanged files are skipped, force re-reads', async () => {
    const root = join(tmp!, 'music');
    mkdirSync(root);
    const path = `${root}/back.mp3`;
    writeFileSync(path, 'x');
    await scanLibrary([root], { trigger: 'test' });
    const id = getTrackByPath(path)!.id;

    renameSync(path, `${tmp}/parked.mp3`);
    await scanLibrary([root], { trigger: 'test' });
    expect(getTrack(id)?.availability).toBe('missing');

    renameSync(`${tmp}/parked.mp3`, path);
    const back = await scanLibrary([root], { trigger: 'test' });
    expect(getTrack(id)?.availability).toBe('available');
    expect(back.recoveredTracks).toBe(1);
    expect(back.updatedTracks).toBe(0);

    const skip = await scanLibrary([root], { trigger: 'test' });
    expect(skip.updatedTracks).toBe(0);
    expect(skip.newTracks).toBe(0);

    const forced = await scanLibrary([root], { force: true, trigger: 'test' });
    expect(forced.updatedTracks).toBe(1);
    expect(forced.forced).toBe(true);

    // A row from an older scanner version is re-read once even when unchanged.
    getRawDb().prepare('UPDATE tracks SET scan_version = 1 WHERE id = ?').run(id);
    const upgraded = await scanLibrary([root], { trigger: 'test' });
    expect(upgraded.updatedTracks).toBe(1);
    expect(getTrack(id)?.scan_version).toBe(SCAN_VERSION);
  });

  it('records every scan as a run with roots, counts and outcome', async () => {
    const root = join(tmp!, 'music');
    const offline = join(tmp!, 'offline');
    mkdirSync(root);
    writeFileSync(`${root}/first.mp3`, '');
    const status = await scanLibrary([root, offline], { trigger: 'test' });

    const runs = listScanRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: status.runId,
      status: 'done',
      trigger: 'test',
      forced: false,
      roots: [root, offline],
      successfulRoots: [root],
      newTracks: 1,
      totalFiles: 1,
    });
    expect(runs[0].failedRoots[0].path).toBe(offline);
    expect(runs[0].finishedAt).not.toBeNull();
  });

  it('discovers total files before scanning and stores richer metadata', async () => {
    const root = join(tmp!, 'music');
    const nested = join(root, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'first.mp3'), '');
    writeFileSync(join(nested, 'second.flac'), '');

    const status = await scanLibrary([root], { trigger: 'test' });
    const track = getTrackByPath(`${root}/first.mp3`);

    expect(status.phase).toBe('done');
    expect(status.totalFiles).toBe(2);
    expect(status.processedFiles).toBe(2);
    expect(track).toMatchObject({
      title: 'first',
      artist_name: 'Scanned Artist, Guest Artist',
      artist_names: 'Scanned Artist, Guest Artist',
      composer: 'Composer One',
      conductor: 'Conductor One',
      availability: 'available',
    });
  });

  it('fingerprint depends on bytes and tags, not on the path', () => {
    const base = {
      size: 100,
      duration: 180.004,
      title: 'Song',
      artistName: 'Band',
      albumTitle: 'Album',
      trackNumber: 1,
      discNumber: 1,
    };
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, title: ' song ' }));
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, size: 101 }));
    expect(fingerprintOf(base)).not.toBe(fingerprintOf({ ...base, duration: 181 }));
  });
});

function insertLocalTrack(id: string, filePath: string): void {
  const db = getRawDb();
  const artistId = `${id}-artist`;
  const albumId = `${id}-album`;

  db.prepare(
    `INSERT INTO artists (id, name, source)
     VALUES (?, ?, 'local')`,
  ).run(artistId, `${id} Artist`);
  db.prepare(
    `INSERT INTO albums (id, title, artist_id, artist_name, track_count, source)
     VALUES (?, ?, ?, ?, 1, 'local')`,
  ).run(albumId, `${id} Album`, artistId, `${id} Artist`);
  db.prepare(
    `INSERT INTO tracks (
      id, title, album_id, album_title, artist_id, artist_name, file_path, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'local')`,
  ).run(id, `${id} Track`, albumId, `${id} Album`, artistId, `${id} Artist`, filePath);
}

/** A playlist position, a favorite and a listening session pointing at the track. */
function addUserData(trackId: string): void {
  const db = getRawDb();
  db.prepare("INSERT OR IGNORE INTO playlists (id, name) VALUES ('pl', 'Keep me')").run();
  db.prepare(
    "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('pl', ?, 0)",
  ).run(trackId);
  db.prepare("INSERT INTO favorites (item_type, item_id) VALUES ('track', ?)").run(trackId);
  db.prepare(
    `INSERT INTO listening_sessions (id, track_id, source, title, artist_name, started_at, listened_ms, status, qualified)
     VALUES (?, ?, 'local', 'T', 'A', 1700000000, 120000, 'ended', 1)`,
  ).run(`${trackId}-session`, trackId);
}

function userData(trackId: string): { playlist: number; favorite: number; sessions: number } {
  const db = getRawDb();
  const count = (sql: string) => (db.prepare(sql).get(trackId) as { c: number }).c;
  return {
    playlist: count('SELECT COUNT(*) as c FROM playlist_tracks WHERE track_id = ?'),
    favorite: count(
      "SELECT COUNT(*) as c FROM favorites WHERE item_type = 'track' AND item_id = ?",
    ),
    sessions: count('SELECT COUNT(*) as c FROM listening_sessions WHERE track_id = ?'),
  };
}

function getTrack(id: string): TrackRow | undefined {
  return getRawDb().prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined;
}

function getTrackByPath(filePath: string): TrackRow | undefined {
  return getRawDb().prepare('SELECT * FROM tracks WHERE file_path = ?').get(filePath) as
    | TrackRow
    | undefined;
}

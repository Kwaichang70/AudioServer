import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import { scanLibrary } from '../services/scanner.js';

interface TrackRow {
  id: string;
  title: string;
  artist_name: string;
  artist_names: string | null;
  composer: string | null;
  conductor: string | null;
  file_path: string | null;
}

vi.mock('music-metadata', () => ({
  selectCover: vi.fn(
    (pictures?: Array<{ data: Uint8Array; format: string }>) => pictures?.[0] ?? null,
  ),
  parseFile: vi.fn(async (filePath: string) => {
    const fileName = String(filePath).split(/[\\/]/).pop() ?? 'track.mp3';
    const title = fileName.replace(/\.[^.]+$/, '');
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
        duration: 180,
        sampleRate: 44100,
        bitsPerSample: 16,
      },
    };
  }),
}));

describe('scanner orphan cleanup safety', () => {
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

  it('does not delete existing tracks when every configured root is unreachable', async () => {
    const missingRoot = join(tmp!, 'offline-share');
    const trackPath = `${missingRoot}/still-present-on-nas.mp3`;
    insertLocalTrack('offline-track', trackPath);

    const status = await scanLibrary([missingRoot]);

    expect(getTrack('offline-track')).toBeTruthy();
    expect(status.orphanCleanupSkipped).toBe(true);
    expect(status.failedRoots).toHaveLength(1);
    expect(status.failedRoots[0].path).toBe(missingRoot);
    expect(status.removedTracks).toBe(0);
  });

  it('deletes orphans only under roots that scanned successfully', async () => {
    const onlineRoot = join(tmp!, 'online-share');
    const offlineRoot = join(tmp!, 'offline-share');
    mkdirSync(onlineRoot);

    insertLocalTrack('online-orphan', `${onlineRoot}/deleted.mp3`);
    insertLocalTrack('offline-preserved', `${offlineRoot}/temporarily-unreachable.mp3`);

    const status = await scanLibrary([onlineRoot, offlineRoot]);

    expect(getTrack('online-orphan')).toBeUndefined();
    expect(getTrack('offline-preserved')).toBeTruthy();
    expect(status.orphanCleanupSkipped).toBe(false);
    expect(status.successfulRoots).toEqual([onlineRoot]);
    expect(status.failedRoots).toHaveLength(1);
    expect(status.removedTracks).toBe(1);
  });

  it('removes a deleted file when its root scanned successfully', async () => {
    const root = join(tmp!, 'music');
    mkdirSync(root);
    insertLocalTrack('deleted-track', `${root}/deleted.mp3`);

    const status = await scanLibrary([root]);

    expect(getTrack('deleted-track')).toBeUndefined();
    expect(status.successfulRoots).toEqual([root]);
    expect(status.orphanCleanupSkipped).toBe(false);
    expect(status.removedTracks).toBe(1);
  });

  it('handles a moved or renamed file by adding the new path and removing the old path', async () => {
    const root = join(tmp!, 'music');
    mkdirSync(root);
    const oldPath = `${root}/old-name.mp3`;
    const newPath = `${root}/new-name.mp3`;
    writeFileSync(newPath, '');
    insertLocalTrack('old-track', oldPath);

    const status = await scanLibrary([root]);

    expect(getTrack('old-track')).toBeUndefined();
    expect(getTrackByPath(newPath)).toMatchObject({
      title: 'new-name',
      file_path: newPath,
    });
    expect(status.newTracks).toBe(1);
    expect(status.removedTracks).toBe(1);
  });

  it('discovers total files before scanning and stores richer metadata', async () => {
    const root = join(tmp!, 'music');
    const nested = join(root, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'first.mp3'), '');
    writeFileSync(join(nested, 'second.flac'), '');

    const status = await scanLibrary([root]);
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
    });
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

function getTrack(id: string): TrackRow | undefined {
  return getRawDb().prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined;
}

function getTrackByPath(filePath: string): TrackRow | undefined {
  return getRawDb().prepare('SELECT * FROM tracks WHERE file_path = ?').get(filePath) as
    | TrackRow
    | undefined;
}

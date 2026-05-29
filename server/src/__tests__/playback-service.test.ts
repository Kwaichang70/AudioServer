import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import { PlaybackService } from '../services/playback.js';

const trackOne = {
  id: 't1',
  title: 'Track One',
  artistName: 'Artist A',
  albumTitle: 'Album X',
  albumId: 'a1',
  duration: 180,
  source: 'local',
};

const trackTwo = {
  id: 't2',
  title: 'Track Two',
  artistName: 'Artist A',
  albumTitle: 'Album X',
  albumId: 'a1',
  duration: 210,
  source: 'local',
};

describe('PlaybackService persistence', () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-playback-test-'));
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

  it('restores playback state, current queue item, and queue after restart', () => {
    const service = new PlaybackService();
    service.initialize();
    service.setQueue([trackOne, trackTwo]);
    service.play(trackTwo, 'device-1');
    service.setVolume(83);
    service.setPosition(42);
    service.setRepeat('all');

    const restarted = new PlaybackService();
    restarted.initialize();

    expect(restarted.getState()).toMatchObject({
      state: 'playing',
      position: 42,
      volume: 83,
      deviceId: 'device-1',
      track: { id: 't2', title: 'Track Two' },
    });
    expect(restarted.getQueue()).toHaveLength(2);
    expect(restarted.getQueueIndex()).toBe(1);
    expect(restarted.advance()).toMatchObject({ id: 't1' });
  });

  it('restores a local current track from the library table when it is not in queue', () => {
    insertLocalTrack('db-track');
    const service = new PlaybackService();
    service.initialize();
    service.play({
      id: 'db-track',
      title: 'Temporary Title',
      artistName: 'Temporary Artist',
      albumTitle: 'Temporary Album',
      duration: 10,
    });
    service.setPosition(7);

    const restarted = new PlaybackService();
    restarted.initialize();

    expect(restarted.getState()).toMatchObject({
      state: 'playing',
      position: 7,
      track: {
        id: 'db-track',
        title: 'Persisted Track',
        artistName: 'Persisted Artist',
        albumTitle: 'Persisted Album',
      },
    });
  });

  it('auto-advances when stopped near the end of the current track', () => {
    const service = new PlaybackService();
    service.initialize();
    service.setQueue([trackOne, trackTwo]);
    service.play(trackOne);

    service.setState({ state: 'stopped', position: 179 });

    expect(service.getState()).toMatchObject({
      state: 'playing',
      position: 0,
      track: { id: 't2' },
    });
    expect(service.getQueueIndex()).toBe(1);
  });

  it('replays the same track in repeat-one mode', () => {
    const service = new PlaybackService();
    service.initialize();
    service.setQueue([trackOne, trackTwo]);
    service.play(trackOne);
    service.setRepeat('one');

    expect(service.advance()).toMatchObject({ id: 't1' });
    expect(service.getState()).toMatchObject({
      state: 'playing',
      position: 0,
      track: { id: 't1' },
    });
    expect(service.getQueueIndex()).toBe(0);
  });
});

function insertLocalTrack(id: string): void {
  const db = getRawDb();
  db.prepare(
    "INSERT INTO artists (id, name, source) VALUES ('artist-1', 'Persisted Artist', 'local')",
  ).run();
  db.prepare(
    `INSERT INTO albums (id, title, artist_id, artist_name, track_count, source)
     VALUES ('album-1', 'Persisted Album', 'artist-1', 'Persisted Artist', 1, 'local')`,
  ).run();
  db.prepare(
    `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration, source)
     VALUES (?, 'Persisted Track', 'album-1', 'Persisted Album', 'artist-1', 'Persisted Artist', 123, 'local')`,
  ).run(id);
}

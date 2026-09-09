import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import { PlaybackService, StaleRevisionError } from '../services/playback.js';

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

describe('PlaybackService session (V03)', () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-playback-session-'));
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

  const tabA = { clientId: 'tab-a', sessionId: 's-a' };
  const tabB = { clientId: 'tab-b', sessionId: 's-b' };

  it('gives every occurrence its own id and keeps playing position by identity', () => {
    const service = new PlaybackService();
    service.initialize();
    service.setQueue([trackOne, trackTwo, trackOne, trackTwo], 0, tabA, 'browser');
    const snap = service.getSnapshot();
    expect(new Set(snap.queue.map((i) => i.itemId)).size).toBe(4);

    // Jump straight to the second "trackOne" and remove the first one: the
    // current position follows the item, not the track id.
    service.playItem(snap.queue[2].itemId, tabA);
    expect(service.getQueueIndex()).toBe(2);
    expect(service.removeItem(snap.queue[0].itemId, tabB)).toBe(true);
    expect(service.getQueueIndex()).toBe(1);
    expect(service.getCurrentItemId()).toBe(snap.queue[2].itemId);
    expect(service.advance()).toMatchObject({ id: 't2' });
    expect(service.getQueueIndex()).toBe(2);
  });

  it('bumps the revision on every mutation and refuses stale edits', () => {
    const service = new PlaybackService();
    service.initialize();
    const r0 = service.getRevision();
    service.setQueue([trackOne, trackTwo], 0, tabA);
    const r1 = service.getRevision();
    expect(r1).toBeGreaterThan(r0);
    service.addToQueue(trackOne, tabB);
    expect(service.getRevision()).toBeGreaterThan(r1);
    expect(() => service.assertRevision(r1)).toThrow(StaleRevisionError);
    expect(() => service.assertRevision(service.getRevision())).not.toThrow();
    expect(() => service.assertRevision(undefined)).not.toThrow();
    // Position ticks from the device monitor do not count as edits.
    const r2 = service.getRevision();
    service.setPosition(12);
    expect(service.getRevision()).toBe(r2);
  });

  it('applies a repeated command id once', () => {
    const service = new PlaybackService();
    service.initialize();
    const a = service.withCommand('c1', () => service.addToQueue(trackOne, tabA));
    const b = service.withCommand('c1', () => service.addToQueue(trackOne, tabA));
    expect(b).toEqual(a);
    expect(service.getQueue()).toHaveLength(1);
  });

  it('only the active device may change the transport state', () => {
    const service = new PlaybackService();
    service.initialize();
    service.setQueue([trackOne, trackTwo], 0, tabA, 'living-room');
    service.play(trackOne, 'living-room', undefined, tabA);
    service.setState({ deviceId: 'kitchen', state: 'paused', position: 50 });
    expect(service.getState()).toMatchObject({ state: 'playing', deviceId: 'living-room' });
    service.setState({ deviceId: 'living-room', state: 'paused', position: 50 });
    expect(service.getState()).toMatchObject({ state: 'paused', position: 50 });
  });

  it('emits events with origin through the injected sink and survives without one', () => {
    const service = new PlaybackService();
    service.initialize();
    // No sink yet: must not throw.
    service.setQueue([trackOne], 0, tabA);
    const events: Array<{ event: string; payload: { origin?: { clientId: string | null } } }> = [];
    service.setEventSink({
      emit: (event, ...args) => {
        events.push({ event, payload: args[0] as never });
      },
    });
    service.addToQueue(trackTwo, tabB);
    service.advance(tabB);
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(['playback:queue', 'playback:state', 'playback:track-changed']),
    );
    expect(events.every((e) => e.payload.origin?.clientId === 'tab-b')).toBe(true);
  });

  it('remembers the controlling tab and restores the current occurrence after restart', () => {
    const service = new PlaybackService();
    service.initialize();
    service.setQueue([trackOne, trackTwo, trackOne], 0, tabA, 'browser');
    const items = service.getQueue();
    service.playItem(items[2].itemId, tabA);
    expect(service.getSnapshot().controller).toMatchObject({
      clientId: 'tab-a',
      deviceId: 'browser',
    });

    const restarted = new PlaybackService();
    restarted.initialize();
    const snap = restarted.getSnapshot();
    expect(snap.queueIndex).toBe(2);
    expect(snap.currentItemId).toBe(items[2].itemId);
    expect(snap.queue.map((i) => i.itemId)).toEqual(items.map((i) => i.itemId));
    expect(snap.controller.clientId).toBeNull(); // tabs do not survive a restart
  });

  it('keeps client metadata (ReplayGain etc.) on queue items across a restart', () => {
    const service = new PlaybackService();
    service.initialize();
    service.setQueue(
      [{ ...trackOne, metadata: { replayGainTrack: -6.5, format: 'flac' } }],
      0,
      tabA,
    );
    const restarted = new PlaybackService();
    restarted.initialize();
    expect(restarted.getQueue()[0].metadata).toEqual({ replayGainTrack: -6.5, format: 'flac' });
  });
});

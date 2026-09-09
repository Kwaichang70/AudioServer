import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { playbackService, SERVER_ORIGIN } from '../services/playback.js';
import { DeviceMonitor, deviceMonitor } from '../services/device-monitor.js';
import { PlaybackResolveError, type ResolvedStream } from '../services/playback-resolver.js';
import {
  configureServerPlayer,
  dispatch,
  getActiveServerDevice,
  initServerPlayer,
  onDeviceUnreachable,
  reconcileAfterRestart,
  resetServerPlayerForTests,
  startServerPlayback,
  stopServerPlayback,
} from '../services/server-player.js';
import type { DispatchStatus } from '../types/socket-events.js';
import type { DevicePlaybackStatus } from '@audioserver/shared';

const tabA = { clientId: 'tab-a', sessionId: 's-a' };
const local = (id: string, title = id) => ({
  id,
  title,
  artistName: 'Artist',
  albumTitle: 'Album',
  duration: 100,
});

function resolvedFor(track: { id: string; title: string }, n: number): ResolvedStream {
  return {
    source: track.id.includes(':') ? 'qobuz' : 'local',
    trackId: track.id,
    url: `http://nas/stream/${track.id}?n=${n}`,
    metadata: { title: track.title, artist: 'Artist', album: 'Album', duration: 100 },
  };
}

/**
 * V04.2/V04.3: the NAS hands each item to the speaker with a fresh url,
 * bounded retries, a visible dispatch status and an explicit policy for
 * tracks it cannot play.
 */
describe('server player dispatch', () => {
  let tmp: string;
  let events: DispatchStatus[];
  let played: Array<{ deviceId: string; url: string; title: string }>;
  let resolveCalls: number;
  let play: ReturnType<typeof vi.fn>;
  let resolve: ReturnType<typeof vi.fn>;
  let connected: boolean;

  const flush = () => new Promise((r) => setTimeout(r, 5));

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-server-player-'));
    await initDatabase(join(tmp, 'test.db'));
    playbackService.initialize();
    events = [];
    playbackService.setEventSink({
      emit: (event, ...args) => {
        if (event === 'playback:dispatch') events.push(args[0] as DispatchStatus);
      },
    });
    played = [];
    resolveCalls = 0;
    connected = false;
    play = vi.fn(async (deviceId: string, url: string, metadata: { title: string }) => {
      played.push({ deviceId, url, title: metadata.title });
    });
    resolve = vi.fn(async (track: { id: string; title: string }) => {
      if (track.id.startsWith('spotify:')) {
        throw new PlaybackResolveError('external_player_only', 'spotify is not a stream');
      }
      if (track.id.startsWith('tidal:')) {
        throw new PlaybackResolveError('unsupported_source', 'tidal is preview only');
      }
      return resolvedFor(track, ++resolveCalls);
    });
    configureServerPlayer({
      play: play as never,
      resolve: resolve as never,
      isClientConnected: () => connected,
      getDeviceState: async () => ({ state: 'stopped' }),
      discover: async () => [],
      timeoutMs: 200,
      maxAttempts: 2,
      maxConsecutiveSkips: 2,
      policy: 'skip',
      resumeOnRestart: false,
    });
    resetServerPlayerForTests();
    initServerPlayer();
  });

  afterEach(() => {
    stopServerPlayback();
    deviceMonitor.stopAll();
    resetServerPlayerForTests();
    playbackService.setEventSink(null);
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('dispatches with a fresh url and reports loading → playing', async () => {
    playbackService.setQueue([local('a'), local('b')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    expect(playbackService.getSnapshot().controller.serverManaged).toBe(true);

    await dispatch('speaker', local('a'), playbackService.getCurrentItemId());
    expect(played).toEqual([{ deviceId: 'speaker', url: 'http://nas/stream/a?n=1', title: 'a' }]);
    expect(events.map((e) => e.state)).toEqual(['loading', 'playing']);
    expect(playbackService.getSnapshot().dispatch).toMatchObject({
      state: 'playing',
      trackId: 'a',
      attempts: 1,
    });
  });

  it('re-resolves (new url) when the device rejects the first attempt', async () => {
    playbackService.setQueue([local('a')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    play.mockImplementationOnce(async () => {
      throw new Error('renderer rejected expired url');
    });

    await dispatch('speaker', local('a'), playbackService.getCurrentItemId());
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(played.map((p) => p.url)).toEqual(['http://nas/stream/a?n=2']);
    expect(playbackService.getSnapshot().dispatch).toMatchObject({ state: 'playing', attempts: 2 });
  });

  it('gives up after the attempt limit and a timeout, then skips to the next item', async () => {
    playbackService.setQueue([local('a'), local('b')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    play.mockImplementationOnce(() => new Promise(() => {})); // hangs → timeout
    play.mockImplementationOnce(async () => {
      throw new Error('still broken');
    });

    await dispatch('speaker', local('a'), playbackService.getCurrentItemId());
    await flush();
    // The skip advanced to "b", which the onAdvance hook dispatched.
    const states = events.map((e) => e.state);
    expect(states).toEqual(['loading', 'skipped', 'loading', 'playing']);
    expect(played.at(-1)?.title).toBe('b');
    expect(playbackService.getSnapshot().queueIndex).toBe(1);
    expect(playbackService.getState().state).toBe('playing');
  });

  it('stops with a visible error after too many unplayable tracks in a row', async () => {
    playbackService.setQueue(
      [
        { ...local('tidal:1', 'T1') },
        { ...local('tidal:2', 'T2') },
        { ...local('tidal:3', 'T3') },
        local('z'),
      ],
      0,
      tabA,
      'speaker',
    );
    startServerPlayback('user-1', 'speaker');

    await dispatch('speaker', local('tidal:1', 'T1'), playbackService.getCurrentItemId());
    await flush();
    const last = events.at(-1)!;
    expect(last.state).toBe('error');
    expect(last.message).toMatch(/2 unplayable tracks in a row/);
    expect(playbackService.getState().state).toBe('stopped');
    expect(playbackService.getSnapshot().controller.serverManaged).toBe(false);
    expect(getActiveServerDevice()).toBeNull();
    expect(played).toEqual([]);
  });

  it('applies the stop policy immediately when configured', async () => {
    configureServerPlayer({ policy: 'stop' });
    playbackService.setQueue([local('tidal:1', 'T1'), local('b')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    await dispatch('speaker', local('tidal:1', 'T1'), playbackService.getCurrentItemId());
    await flush();
    expect(events.map((e) => e.state)).toEqual(['loading', 'error']);
    expect(playbackService.getState().state).toBe('stopped');
    expect(playbackService.getSnapshot().queueIndex).toBe(0); // nothing advanced
  });

  it('leaves Spotify to a connected controlling tab, skips it when nobody is there', async () => {
    playbackService.setQueue([local('spotify:1', 'S'), local('b')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');

    connected = true;
    await dispatch('speaker', local('spotify:1', 'S'), playbackService.getCurrentItemId());
    await flush();
    expect(events.at(-1)).toMatchObject({ state: 'client', code: 'external_player_only' });
    expect(playbackService.getSnapshot().queueIndex).toBe(0);
    expect(played).toEqual([]);

    events.length = 0;
    connected = false;
    await dispatch('speaker', local('spotify:1', 'S'), playbackService.getCurrentItemId());
    await flush();
    expect(events.map((e) => e.state)).toEqual(['loading', 'skipped', 'loading', 'playing']);
    expect(played.at(-1)?.title).toBe('b');
  });

  it('ignores a dispatch that became stale (device changed or stopped meanwhile)', async () => {
    playbackService.setQueue([local('a')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    let release: () => void = () => {};
    play.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const pending = dispatch('speaker', local('a'), playbackService.getCurrentItemId());
    await flush();
    stopServerPlayback();
    release();
    await pending;
    expect(events.map((e) => e.state)).toEqual(['loading']); // no "playing" after release
  });

  it('marks the session stopped when the monitor reports the device unreachable', () => {
    playbackService.setQueue([local('a')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    playbackService.play(local('a'), 'speaker', playbackService.getCurrentItemId()!, SERVER_ORIGIN);
    onDeviceUnreachable('other-speaker', 10);
    expect(playbackService.getState().state).toBe('playing');

    onDeviceUnreachable('speaker', 10);
    expect(playbackService.getState().state).toBe('stopped');
    expect(events.at(-1)).toMatchObject({ state: 'error', code: 'device_unreachable' });
    expect(getActiveServerDevice()).toBeNull();
    expect(playbackService.getSnapshot().controller.serverManaged).toBe(false);
  });
});

describe('server player restart reconciliation', () => {
  let tmp: string;
  let played: string[];
  let deviceState: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-server-player-restart-'));
    await initDatabase(join(tmp, 'test.db'));
    played = [];
    deviceState = 'stopped';
    configureServerPlayer({
      play: (async (_d: string, url: string) => {
        played.push(url);
      }) as never,
      resolve: (async (track: { id: string; title: string }) => resolvedFor(track, 1)) as never,
      isClientConnected: () => false,
      getDeviceState: async () => ({ state: deviceState }),
      discover: async () => [],
      timeoutMs: 200,
      maxAttempts: 1,
      maxConsecutiveSkips: 2,
      policy: 'skip',
      resumeOnRestart: false,
    });
    resetServerPlayerForTests();
    initServerPlayer();
    // Persist a server-managed "playing" session, then simulate a restart.
    playbackService.initialize();
    playbackService.setQueue([local('a'), local('b')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    playbackService.play(local('a'), 'speaker', playbackService.getCurrentItemId()!, SERVER_ORIGIN);
    deviceMonitor.stopAll();
    resetServerPlayerForTests();
    playbackService.initialize(); // = restart: state comes from disk
  });

  afterEach(() => {
    stopServerPlayback();
    deviceMonitor.stopAll();
    resetServerPlayerForTests();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('restores ownership from disk', () => {
    const info = playbackService.getPersistedSessionInfo();
    expect(info).toMatchObject({
      deviceId: 'speaker',
      state: 'playing',
      trackId: 'a',
      ownerUserId: 'user-1',
      serverManaged: true,
    });
    const row = getRawDb()
      .prepare('SELECT owner_user_id, server_managed FROM playback_state WHERE id = 1')
      .get() as { owner_user_id: string; server_managed: number };
    expect(row).toEqual({ owner_user_id: 'user-1', server_managed: 1 });
  });

  it('keeps driving a speaker that is still playing', async () => {
    deviceState = 'playing';
    expect(await reconcileAfterRestart()).toBe('device-playing');
    expect(getActiveServerDevice()).toBe('speaker');
    expect(playbackService.getState().state).toBe('playing');
    expect(playbackService.getSnapshot().dispatch.state).toBe('playing');
    expect(played).toEqual([]); // nothing re-sent
  });

  it('stops the session (no autoplay) when the speaker is idle after the restart', async () => {
    deviceState = 'stopped';
    expect(await reconcileAfterRestart()).toBe('stopped');
    expect(playbackService.getState().state).toBe('stopped');
    expect(playbackService.getSnapshot().controller.serverManaged).toBe(false);
    expect(playbackService.getSnapshot().dispatch).toMatchObject({
      state: 'error',
      code: 'restart',
    });
    expect(played).toEqual([]);
    // The queue itself is intact for a manual play.
    expect(playbackService.getQueue().map((i) => i.trackId)).toEqual(['a', 'b']);
  });

  it('resumes the current item only with PLAYBACK_RESUME_ON_RESTART', async () => {
    configureServerPlayer({ resumeOnRestart: true });
    expect(await reconcileAfterRestart()).toBe('resumed');
    await new Promise((r) => setTimeout(r, 10));
    expect(played).toEqual(['http://nas/stream/a?n=1']);
    expect(getActiveServerDevice()).toBe('speaker');
  });

  it('does nothing for a browser session', async () => {
    playbackService.setQueue([local('a')], 0, tabA, 'browser');
    stopServerPlayback();
    playbackService.initialize();
    expect(await reconcileAfterRestart()).toBe('not-managed');
  });
});

/**
 * The whole chain that keeps an album going on a speaker: the device monitor
 * sees the track end, PlaybackService advances, the server player streams the
 * next item. Danny's album stopped after one song on 9 Sept 2026 because the
 * first link was too strict about what "the track ended" looks like.
 */
describe('an album keeps playing on an external device', () => {
  let tmp: string;
  let played: string[];
  let monitor: DeviceMonitor;
  let statuses: DevicePlaybackStatus[];

  const poll = async () => {
    await monitor.pollDeviceOnce('speaker');
    await new Promise((r) => setTimeout(r, 5));
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-album-'));
    await initDatabase(join(tmp, 'test.db'));
    playbackService.initialize();
    played = [];
    statuses = [];
    configureServerPlayer({
      play: (async (deviceId: string, url: string) => {
        played.push(url);
      }) as never,
      resolve: (async (track: { id: string; title: string }) =>
        resolvedFor(track, played.length + 1)) as never,
      isClientConnected: () => false,
      timeoutMs: 200,
      maxAttempts: 1,
      policy: 'stop',
    });
    resetServerPlayerForTests();
    initServerPlayer();
    monitor = new DeviceMonitor({
      getDevices: async () => [],
      getPlaybackState: async () => {
        const next = statuses.shift();
        if (!next) throw new Error('no status queued');
        return next;
      },
      getIO: () => ({ emit: () => true }),
      playback: playbackService,
      logger: { info: vi.fn(), debug: vi.fn() },
    });
  });

  afterEach(() => {
    monitor.stopAll();
    stopServerPlayback();
    resetServerPlayerForTests();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('advances to track 2 when the renderer stops with its counters reset', async () => {
    playbackService.setQueue([local('a'), local('b'), local('c')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    await dispatch('speaker', local('a'), playbackService.getCurrentItemId());
    expect(played).toEqual(['http://nas/stream/a?n=1']);

    // Duration 100; the last sample the monitor keeps can lag a few seconds
    // behind, and the speaker reports 0:00/0:00 the moment it stops.
    statuses = [
      { state: 'playing', position: 20, duration: 100, volume: 30 },
      { state: 'playing', position: 94, duration: 100, volume: 30 },
      { state: 'stopped', position: 0, duration: 0, volume: 30 },
    ];
    await poll();
    await poll();
    await poll();

    expect(played).toEqual(['http://nas/stream/a?n=1', 'http://nas/stream/b?n=2']);
    expect(playbackService.getState().state).toBe('playing');
    expect(playbackService.getCurrentTrack()?.id).toBe('b');
  });

  it('leaves the queue where it is when somebody stops the speaker mid-track', async () => {
    playbackService.setQueue([local('a'), local('b')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    await dispatch('speaker', local('a'), playbackService.getCurrentItemId());

    statuses = [
      { state: 'playing', position: 30, duration: 100, volume: 30 },
      { state: 'stopped', position: 0, duration: 0, volume: 30 },
    ];
    await poll();
    await poll();

    expect(played).toEqual(['http://nas/stream/a?n=1']);
    expect(playbackService.getState().state).toBe('stopped');
    expect(playbackService.getSnapshot().queueIndex).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, initDatabase } from '../db/index.js';
import { playbackService } from '../services/playback.js';
import { DeviceMonitor } from '../services/device-monitor.js';
import {
  configureServerPlayer,
  initServerPlayer,
  onDeviceAdvanced,
  resetServerPlayerForTests,
  revalidateNext,
  startServerPlayback,
  stopServerPlayback,
} from '../services/server-player.js';
import { listTransitions } from '../services/transitions.js';
import { noteSeek } from '../services/seek-log.js';
import { cancelSleepTimer, setSleepTimer } from '../services/sleep-timer.js';
import type { DevicePlaybackStatus } from '@audioserver/shared';

/**
 * V11.3: handing the next track to the renderer before the current one ends.
 *
 * The device then starts it itself, which is what makes the boundary gapless
 * — and exactly why the server must NOT dispatch that track again when the
 * queue follows. A restarted track is the "double dispatch" the sprint's
 * acceptance rules out, and it would be audible.
 */
describe('handing the next track over in advance', () => {
  let tmp: string;
  let played: string[];
  let armed: string[];
  let monitor: DeviceMonitor;
  let statuses: DevicePlaybackStatus[];
  let supports: boolean;
  let armFails: boolean;
  let cleared: number;
  let stopped: string[];

  const tabA = { clientId: 'tab-a', sessionId: 's-a' };
  const local = (id: string) => ({
    id,
    title: id,
    artistName: 'Artist',
    albumTitle: 'Album',
    duration: 100,
  });
  const status = (
    state: DevicePlaybackStatus['state'],
    position: number,
    trackUri?: string,
  ): DevicePlaybackStatus => ({
    state,
    position,
    duration: 100,
    volume: 30,
    ...(trackUri ? { trackUri } : {}),
  });

  const poll = async () => {
    await monitor.pollDeviceOnce('speaker');
    await new Promise((r) => setTimeout(r, 5));
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-gapless-'));
    await initDatabase(join(tmp, 'test.db'));
    playbackService.initialize();
    played = [];
    armed = [];
    statuses = [];
    supports = true;
    armFails = false;
    cleared = 0;
    stopped = [];

    configureServerPlayer({
      play: (async (_deviceId: string, url: string) => {
        played.push(url);
      }) as never,
      setNextUri: (async (_deviceId: string, url: string) => {
        if (armFails) throw new Error('renderer refuses SetNextAVTransportURI');
        armed.push(url);
      }) as never,
      clearNextUri: async () => {
        cleared++;
      },
      stopDevice: async (deviceId: string) => {
        stopped.push(deviceId);
      },
      supportsNextUri: async () => supports,
      noteNextUriFailed: vi.fn(),
      resolve: (async (track: { id: string; title: string }) => ({
        source: 'local',
        trackId: track.id,
        url: `http://nas/stream/${track.id}`,
        metadata: { title: track.title, artist: 'Artist', album: 'Album', duration: 100 },
      })) as never,
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
      // The production monitor gets this handler from initServerPlayer(); a
      // monitor built for a test has to be given it.
      onDeviceAdvanced,
    });
  });

  afterEach(() => {
    monitor.stopAll();
    stopServerPlayback();
    resetServerPlayerForTests();
    closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  const startAlbum = async () => {
    playbackService.setQueue([local('a'), local('b'), local('c')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    playbackService.playItem(playbackService.getCurrentItemId()!, tabA, 'speaker');
    await new Promise((r) => setTimeout(r, 10));
  };

  it('arms the next track as soon as this one is playing', async () => {
    await startAlbum();

    expect(played).toEqual(['http://nas/stream/a']);
    expect(armed).toEqual(['http://nas/stream/b']);
  });

  it('follows the device onto the armed track without dispatching it again', async () => {
    await startAlbum();

    // The device plays to the end and starts the armed track itself: still
    // "playing", but its position falls back to the beginning.
    statuses = [status('playing', 40), status('playing', 95), status('playing', 2)];
    await poll();
    await poll();
    await poll();

    expect(playbackService.getCurrentTrack()?.id).toBe('b');
    // Track b was never sent again — only a and, in advance, c.
    expect(played).toEqual(['http://nas/stream/a']);
    expect(armed).toEqual(['http://nas/stream/b', 'http://nas/stream/c']);

    const transitions = listTransitions({ deviceId: 'speaker' });
    expect(transitions[0]).toMatchObject({
      fromTrackId: 'a',
      toTrackId: 'b',
      handover: 'next-uri',
    });
    expect(transitions[0].armedAt).toBeTruthy();
    // Nothing was measured, so nothing may claim to be.
    expect(transitions[0].measuredGapMs).toBeNull();
  });

  it('ignores a listener seeking back to the start', async () => {
    await startAlbum();
    armed.length = 0;

    // Same shape as a device-side advance, but nothing was armed any more.
    stopServerPlayback();
    startServerPlayback('user-1', 'speaker');
    statuses = [status('playing', 60), status('playing', 1)];
    await poll();
    await poll();

    expect(playbackService.getCurrentTrack()?.id).toBe('a');
  });

  it('falls back to dispatching at the end when the renderer refuses the handover', async () => {
    armFails = true;
    await startAlbum();
    expect(armed).toEqual([]);

    statuses = [status('playing', 95), { state: 'stopped', position: 0, duration: 0, volume: 30 }];
    await poll();
    await poll();

    expect(playbackService.getCurrentTrack()?.id).toBe('b');
    expect(played).toEqual(['http://nas/stream/a', 'http://nas/stream/b']);
    expect(listTransitions({ deviceId: 'speaker' })[0]).toMatchObject({ handover: 'dispatch' });
  });

  it('promises nothing in shuffle: there is no fixed next track', async () => {
    playbackService.setQueue([local('a'), local('b'), local('c')], 0, tabA, 'speaker');
    playbackService.setShuffle(true, tabA);
    startServerPlayback('user-1', 'speaker');
    playbackService.playItem(playbackService.getCurrentItemId()!, tabA, 'speaker');
    await new Promise((r) => setTimeout(r, 10));

    expect(played).toEqual(['http://nas/stream/a']);
    expect(armed).toEqual([]);
  });

  // ─── ANALYSE_EN_VERBETERPLAN B02, B03, B09 ─────────────────────────

  it('B02: a seek back to 0:01 with the next track armed keeps the queue (URL says so)', async () => {
    await startAlbum();
    expect(armed).toEqual(['http://nas/stream/b']);
    statuses = [
      status('playing', 60, 'http://nas/stream/a'),
      status('playing', 1, 'http://nas/stream/a'),
    ];
    await poll();
    await poll();
    expect(playbackService.getCurrentTrack()?.id).toBe('a');
  });

  it('B02: the device playing the armed URL moves the queue on, once', async () => {
    await startAlbum();
    statuses = [
      status('playing', 95, 'http://nas/stream/a'),
      status('playing', 2, 'http://nas/stream/b'),
      status('playing', 4, 'http://nas/stream/b'),
    ];
    await poll();
    await poll();
    await poll();
    expect(playbackService.getCurrentTrack()?.id).toBe('b');
    expect(played).toEqual(['http://nas/stream/a']);
  });

  it('B02: without a URL from the device, a seek the server just sent keeps the queue', async () => {
    await startAlbum();
    noteSeek('speaker');
    statuses = [status('playing', 60), status('playing', 1)];
    await poll();
    await poll();
    expect(playbackService.getCurrentTrack()?.id).toBe('a');
  });

  it('B03: removing the armed track hands the right next one over', async () => {
    await startAlbum();
    const b = playbackService.getQueue().find((e) => e.trackId === 'b')!;
    playbackService.removeItem(b.itemId, tabA);
    await new Promise((r) => setTimeout(r, 20));
    expect(armed).toEqual(['http://nas/stream/b', 'http://nas/stream/c']);
  });

  it('B03: "play next" puts its track in the hand-over', async () => {
    await startAlbum();
    playbackService.insertNext([local('x')], tabA);
    await new Promise((r) => setTimeout(r, 20));
    expect(armed.at(-1)).toBe('http://nas/stream/x');
  });

  it('B03: a stop-after-this-track timer makes the device forget its next track', async () => {
    await startAlbum();
    const zoneId = playbackService.getZoneId();
    const current = playbackService.getQueue()[0];
    setSleepTimer(zoneId, {
      mode: 'endOfTrack',
      current: { itemId: current.itemId, albumId: current.albumId ?? null },
      userId: null,
    });
    revalidateNext(zoneId);
    await new Promise((r) => setTimeout(r, 10));
    expect(cleared).toBe(1);
    cancelSleepTimer(zoneId);
  });

  it('B03: when the room goes idle, the speaker itself is told to stop', async () => {
    await startAlbum();
    playbackService.stop(tabA);
    await new Promise((r) => setTimeout(r, 10));
    expect(stopped).toEqual(['speaker']);
  });

  it('B09: a provider that never answers does not keep the room loading', async () => {
    configureServerPlayer({ resolve: (() => new Promise(() => {})) as never });
    playbackService.setQueue([local('a'), local('b')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    playbackService.playItem(playbackService.getCurrentItemId()!, tabA, 'speaker');
    // timeoutMs is 200 here; policy "stop" ends the session after one attempt.
    await new Promise((r) => setTimeout(r, 400));
    expect(played).toEqual([]);
    expect(playbackService.getState().state).toBe('stopped');
  });
});

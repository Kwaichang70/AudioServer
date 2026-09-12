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
  startServerPlayback,
  stopServerPlayback,
} from '../services/server-player.js';
import { listTransitions } from '../services/transitions.js';
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
  ): DevicePlaybackStatus => ({
    state,
    position,
    duration: 100,
    volume: 30,
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

    configureServerPlayer({
      play: (async (_deviceId: string, url: string) => {
        played.push(url);
      }) as never,
      setNextUri: (async (_deviceId: string, url: string) => {
        if (armFails) throw new Error('renderer refuses SetNextAVTransportURI');
        armed.push(url);
      }) as never,
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
});

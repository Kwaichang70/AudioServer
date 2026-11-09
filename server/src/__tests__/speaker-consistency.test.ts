import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeDatabase, initDatabase } from '../db/index.js';
import { playbackService, SERVER_ORIGIN } from '../services/playback.js';
import { deviceMonitor } from '../services/device-monitor.js';
import {
  configureServerPlayer,
  getActiveServerDevice,
  initServerPlayer,
  onDeviceAdvanced,
  reconcileAfterRestart,
  resetServerPlayerForTests,
  startServerPlayback,
  stopServerPlayback,
  uriNamesTrack,
} from '../services/server-player.js';

/**
 * Phase 8 (P02, P03, P06): the queue and the speaker stay in step when a
 * hand-over is slow, when an attempt times out, and across a restart.
 */

const tabA = { clientId: 'tab-a', sessionId: 's-a' };
const local = (id: string) => ({
  id,
  title: id,
  artistName: 'Artist',
  albumTitle: 'Album',
  duration: 100,
});
const streamOf = (id: string) => `http://nas:3001/api/library/tracks/${id}/stream?t=tok`;
const resolveLocal = (async (track: { id: string; title: string }) => ({
  source: 'local',
  trackId: track.id,
  url: streamOf(track.id),
  metadata: { title: track.title, artist: 'Artist', album: 'Album', duration: 100 },
})) as never;
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'audioserver-speaker-consistency-'));
  await initDatabase(join(tmp, 'test.db'));
  playbackService.initialize();
});

afterEach(() => {
  stopServerPlayback();
  deviceMonitor.stopAll();
  resetServerPlayerForTests();
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('a hand-over that fails after a newer one replaced it (P02)', () => {
  it('leaves the newer hand-over in place and keeps gapless on', async () => {
    const played: string[] = [];
    const noteNextUriFailed = vi.fn();
    let armSignal: AbortSignal | undefined;
    let arms = 0;
    configureServerPlayer({
      play: (async (_d: string, url: string) => {
        played.push(url);
      }) as never,
      // The first hand-over (track b) hangs until the time limit; the second
      // (c, after b was removed from the queue) is accepted at once.
      setNextUri: ((_d: string, _url: string, _m: unknown, signal?: AbortSignal) => {
        arms++;
        if (arms === 1) {
          armSignal = signal;
          return new Promise(() => {});
        }
        return Promise.resolve();
      }) as never,
      clearNextUri: async () => {},
      stopDevice: async () => {},
      supportsNextUri: async () => true,
      noteNextUriFailed,
      resolve: resolveLocal,
      isClientConnected: () => false,
      timeoutMs: 100,
      maxAttempts: 1,
      policy: 'stop',
    });
    resetServerPlayerForTests();
    initServerPlayer();

    playbackService.setQueue([local('a'), local('b'), local('c')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    playbackService.playItem(playbackService.getCurrentItemId()!, tabA, 'speaker');
    await settle();
    expect(arms).toBe(1); // b is on its way

    playbackService.removeItem(playbackService.getQueue()[1].itemId, tabA);
    await settle();
    expect(arms).toBe(2); // c handed over

    await settle(150); // b's attempt times out now
    expect(armSignal?.aborted).toBe(true);
    expect(noteNextUriFailed).not.toHaveBeenCalled();

    // The speaker starts c by itself: the queue follows, nothing is sent again.
    onDeviceAdvanced('speaker', streamOf('c'));
    await settle();
    expect(playbackService.getCurrentTrack()?.id).toBe('c');
    expect(played).toEqual([streamOf('a')]);
  });
});

describe('an attempt that runs out of time (P06)', () => {
  it('is aborted before the next attempt starts', async () => {
    const signals: AbortSignal[] = [];
    configureServerPlayer({
      play: ((_d: string, _url: string, _m: unknown, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        // The first attempt never answers; the second does.
        return signals.length === 1 ? new Promise(() => {}) : Promise.resolve();
      }) as never,
      supportsNextUri: async () => false,
      resolve: resolveLocal,
      isClientConnected: () => false,
      timeoutMs: 80,
      maxAttempts: 2,
      policy: 'stop',
    });
    resetServerPlayerForTests();
    initServerPlayer();

    playbackService.setQueue([local('a')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    playbackService.playItem(playbackService.getCurrentItemId()!, tabA, 'speaker');
    await settle(250);

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(playbackService.getSnapshot().dispatch.state).toBe('playing');
  });
});

describe('a restart while the speaker crossed into the next track (P03)', () => {
  let played: string[];
  let reported: { state: string; trackUri?: string };

  beforeEach(() => {
    played = [];
    reported = { state: 'playing' };
    configureServerPlayer({
      play: (async (_d: string, url: string) => {
        played.push(url);
      }) as never,
      supportsNextUri: async () => false,
      resolve: resolveLocal,
      isClientConnected: () => false,
      getDeviceState: async () => reported,
      discover: async () => [],
      timeoutMs: 200,
      maxAttempts: 1,
      policy: 'skip',
      resumeOnRestart: false,
    });
    resetServerPlayerForTests();
    initServerPlayer();
    // A server-managed album on track a, persisted; then the "restart".
    playbackService.setQueue([local('a'), local('b'), local('c')], 0, tabA, 'speaker');
    startServerPlayback('user-1', 'speaker');
    playbackService.play(local('a'), 'speaker', playbackService.getCurrentItemId()!, SERVER_ORIGIN);
    deviceMonitor.stopAll();
    resetServerPlayerForTests();
    playbackService.initialize();
    played = [];
  });

  it('moves the queue to the track the speaker plays, without sending it again', async () => {
    reported = { state: 'playing', trackUri: streamOf('b') };
    expect(await reconcileAfterRestart()).toBe('device-playing');
    expect(getActiveServerDevice()).toBe('speaker');
    expect(playbackService.getCurrentTrack()?.id).toBe('b');
    expect(played).toEqual([]);
  });

  it('leaves the queue alone when the speaker still plays the saved track', async () => {
    reported = { state: 'playing', trackUri: streamOf('a') };
    expect(await reconcileAfterRestart()).toBe('device-playing');
    expect(playbackService.getCurrentTrack()?.id).toBe('a');
  });

  it('leaves the queue alone when the URL does not say which track it is', async () => {
    reported = { state: 'playing', trackUri: 'https://cdn.example/qobuz/123.flac?sig=x' };
    expect(await reconcileAfterRestart()).toBe('device-playing');
    expect(playbackService.getCurrentTrack()?.id).toBe('a');
  });
});

describe('uriNamesTrack', () => {
  it('reads the track from a library stream, converted or not, and nothing else', () => {
    expect(uriNamesTrack(streamOf('t1'), 't1')).toBe(true);
    expect(uriNamesTrack(`${streamOf('t1')}&format=mp3&zone=z`, 't1')).toBe(true);
    expect(uriNamesTrack(streamOf('t1'), 't10')).toBe(false);
    expect(uriNamesTrack('http://nas/api/library/tracks/t1/cover', 't1')).toBe(false);
    expect(uriNamesTrack('x-rincon:RINCON_1', 't1')).toBe(false);
    expect(uriNamesTrack('not a url', 't1')).toBe(false);
  });
});

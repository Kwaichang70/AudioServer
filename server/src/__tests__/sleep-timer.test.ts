import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestApp } from './helpers/testApp.js';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { PlaybackService, type TrackInfo } from '../services/playback.js';
import {
  cancelSleepTimer,
  configureSleepTimers,
  getSleepTimer,
  initializeSleepTimers,
  resetSleepTimersForTests,
  setSleepTimer,
} from '../services/sleep-timer.js';

/**
 * Sleep timers (E01).
 *
 * The feature exists for the case where nobody is watching, so the tests are
 * about exactly that: the timer belongs to the server, it survives a restart,
 * it stops one room without touching another, and it ends the music at the
 * boundary the listener named instead of one track later.
 */

const track = (id: string, albumId: string): TrackInfo => ({
  id,
  title: id,
  artistName: 'Artist',
  albumTitle: albumId,
  albumId,
});

describe('A timed sleep', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-sleep-'));
    await initDatabase(join(dir, 'sleep.db'));
    resetSleepTimersForTests();
  });

  afterEach(() => {
    resetSleepTimersForTests();
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops the room when the minutes run out', () => {
    vi.useFakeTimers();
    const stopped: string[] = [];
    configureSleepTimers({ stopZone: (zoneId) => stopped.push(zoneId) });

    setSleepTimer('zone-browser', { mode: 'in', minutes: 30 });
    expect(getSleepTimer('zone-browser')?.secondsRemaining).toBeGreaterThan(1700);

    vi.advanceTimersByTime(29 * 60_000);
    expect(stopped).toEqual([]);
    vi.advanceTimersByTime(2 * 60_000);
    expect(stopped).toEqual(['zone-browser']);
    // Firing forgets the timer: it must not stop the music again tomorrow.
    expect(getSleepTimer('zone-browser')).toBeNull();
    vi.useRealTimers();
  });

  it('stops only the room it was set for', () => {
    vi.useFakeTimers();
    const stopped: string[] = [];
    configureSleepTimers({ stopZone: (zoneId) => stopped.push(zoneId) });

    setSleepTimer('zone-bedroom', { mode: 'in', minutes: 10 });
    setSleepTimer('zone-kitchen', { mode: 'in', minutes: 120 });
    vi.advanceTimersByTime(11 * 60_000);

    expect(stopped).toEqual(['zone-bedroom']);
    expect(getSleepTimer('zone-kitchen')).not.toBeNull();
    vi.useRealTimers();
  });

  it('is cancelled without stopping anything', () => {
    vi.useFakeTimers();
    const stopped: string[] = [];
    configureSleepTimers({ stopZone: (zoneId) => stopped.push(zoneId) });
    setSleepTimer('zone-browser', { mode: 'in', minutes: 5 });
    expect(cancelSleepTimer('zone-browser')).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(stopped).toEqual([]);
    expect(cancelSleepTimer('zone-browser')).toBe(false);
    vi.useRealTimers();
  });

  it('survives a restart, and one that ran out while the server was down is dropped', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    getRawDb()
      .prepare(
        `INSERT INTO sleep_timers (zone_id, mode, stop_at, created_at)
         VALUES ('zone-late', 'in', ?, ?), ('zone-gone', 'in', ?, ?)`,
      )
      .run(nowSeconds + 3600, nowSeconds, nowSeconds - 60, nowSeconds - 7200);

    const stopped: string[] = [];
    configureSleepTimers({ stopZone: (zoneId) => stopped.push(zoneId) });
    initializeSleepTimers();

    expect(getSleepTimer('zone-late')?.secondsRemaining).toBeGreaterThan(3500);
    expect(getSleepTimer('zone-gone')).toBeNull();
    // Nothing is "fired late": the music already stopped when the server did.
    expect(stopped).toEqual([]);
  });
});

describe('Stopping at a boundary', () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'audioserver-sleep-boundary-'));
    await initDatabase(join(dir, 'boundary.db'));
  });

  afterAll(() => {
    resetSleepTimersForTests();
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetSleepTimersForTests();
    getRawDb().prepare('DELETE FROM sleep_timers').run();
  });

  function session(zoneId: string, tracks: TrackInfo[]): PlaybackService {
    const service = new PlaybackService(zoneId);
    service.setQueue(tracks, 0);
    return service;
  }

  const current = (service: PlaybackService) => {
    const snapshot = service.getSnapshot();
    const item = snapshot.queue.find((q) => q.itemId === snapshot.currentItemId);
    return item ? { itemId: item.itemId, albumId: item.albumId ?? null } : null;
  };

  it('ends the music when this track ends', () => {
    const service = session('zone-track', [track('a', 'al-1'), track('b', 'al-1')]);
    setSleepTimer('zone-track', { mode: 'endOfTrack', current: current(service) });

    expect(service.advance()).toBeNull();
    expect(service.getState().state).toBe('stopped');
    expect(getSleepTimer('zone-track')).toBeNull();
  });

  it('beats repeat one, which would otherwise never end', () => {
    const service = session('zone-repeat', [track('a', 'al-1')]);
    service.setRepeat('one');
    setSleepTimer('zone-repeat', { mode: 'endOfTrack', current: current(service) });
    expect(service.advance()).toBeNull();
    expect(service.getState().state).toBe('stopped');
  });

  it('plays the album out and stops when the next track is another album', () => {
    const service = session('zone-album', [
      track('a1', 'al-1'),
      track('a2', 'al-1'),
      track('b1', 'al-2'),
    ]);
    setSleepTimer('zone-album', { mode: 'endOfAlbum', current: current(service) });

    expect(service.advance()?.id).toBe('a2');
    expect(service.advance()).toBeNull();
    expect(service.getState().state).toBe('stopped');
    expect(getSleepTimer('zone-album')).toBeNull();
  });

  it('stops at the end of a repeating queue, which otherwise never runs out', () => {
    const service = session('zone-queue', [track('a', 'al-1'), track('b', 'al-1')]);
    service.setRepeat('all');
    setSleepTimer('zone-queue', { mode: 'endOfQueue', current: current(service) });

    expect(service.advance()?.id).toBe('b');
    expect(service.advance()).toBeNull();
    expect(service.getState().state).toBe('stopped');
  });

  it('hands nothing over in advance at a boundary where the music stops', () => {
    const service = session('zone-peek', [track('a', 'al-1'), track('b', 'al-1')]);
    expect(service.peekNext()?.itemId).toBeTruthy();
    setSleepTimer('zone-peek', { mode: 'endOfTrack', current: current(service) });
    // A renderer holding the next track would start it regardless of us.
    expect(service.peekNext()).toBeNull();
  });
});

describe('The sleep timer over HTTP', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    resetSleepTimersForTests();
  });

  afterAll(() => {
    resetSleepTimersForTests();
    teardown();
  });

  it('sets, reads and cancels a timed sleep', async () => {
    const set = await request(app)
      .post('/api/playback/sleep')
      .set('X-Client-Id', 'sleep-test')
      .send({ mode: 'in', minutes: 45 });
    expect(set.status).toBe(200);
    expect(set.body.data.mode).toBe('in');
    expect(set.body.data.description).toMatch(/45 minutes/);

    const read = await request(app).get('/api/playback/sleep');
    expect(read.body.data.secondsRemaining).toBeGreaterThan(2600);

    const cancelled = await request(app)
      .delete('/api/playback/sleep')
      .set('X-Client-Id', 'sleep-test');
    expect(cancelled.body.data.cancelled).toBe(true);
    const empty = await request(app).get('/api/playback/sleep');
    expect(empty.body.data).toBeNull();
  });

  it('refuses a boundary timer when the room is not playing anything', async () => {
    const res = await request(app)
      .post('/api/playback/sleep')
      .set('X-Client-Id', 'sleep-test')
      .send({ mode: 'endOfAlbum' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('nothing_playing');
  });

  it('refuses a timed sleep without minutes, and an absurd one', async () => {
    expect(
      (
        await request(app)
          .post('/api/playback/sleep')
          .set('X-Client-Id', 'sleep-test')
          .send({ mode: 'in' })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post('/api/playback/sleep')
          .set('X-Client-Id', 'sleep-test')
          .send({ mode: 'in', minutes: 5000 })
      ).status,
    ).toBe(400);
  });

  it('carries the timer in the playback snapshot', async () => {
    await request(app)
      .post('/api/playback/sleep')
      .set('X-Client-Id', 'sleep-test')
      .send({ mode: 'in', minutes: 20 });
    // Every queue command answers with the full snapshot; that is where a
    // reconnecting client reads the timer from.
    const res = await request(app)
      .post('/api/playback/queue/clear')
      .set('X-Client-Id', 'sleep-test')
      .send({});
    expect(res.body.data.sleep.mode).toBe('in');

    await request(app).delete('/api/playback/sleep').set('X-Client-Id', 'sleep-test');
    const after = await request(app)
      .post('/api/playback/queue/clear')
      .set('X-Client-Id', 'sleep-test')
      .send({});
    expect(after.body.data.sleep).toBeNull();
  });
});

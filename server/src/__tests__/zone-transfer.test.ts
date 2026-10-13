import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { zones } from '../services/zones.js';
import { stopServerPlayback } from '../services/server-player.js';
import { configureZoneTransfer, resetZoneTransfer } from '../services/zone-transfer.js';
import { getRadioState, setRadio } from '../services/library-radio.js';

/**
 * Move the music to another room (R09.2): queue, current item and position
 * go along, the old room stops. Works across protocols because it is a
 * hand-over, not synchronisation.
 */

const album = [1, 2, 3, 4].map((n) => ({
  id: `t${n}`,
  title: `Track ${n}`,
  artistName: 'Bill Evans',
  albumTitle: 'Sunday',
  albumId: 'al-1',
  duration: 300,
}));

describe('Zone transfer', () => {
  let app: Express;
  let teardown: () => void;
  let kitchen: string;
  let living: string;
  const seeks: Array<{ deviceId: string; position: number }> = [];
  let canSeek = true;
  let starts = true;

  const as = (zoneId: string) => ({
    post: (path: string) =>
      request(app).post(path).set('X-Client-Id', 'transfer-test').set('X-Zone-Id', zoneId),
  });

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    // Two rooms on two different kinds of speaker: a hand-over, not a sync.
    kitchen = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Kitchen', deviceId: 'sonos:kitchen' })
    ).body.data.id;
    living = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Living room', deviceId: 'dlna:living' })
    ).body.data.id;
    configureZoneTransfer({
      waitUntilPlaying: async () => starts,
      canSeek: async () => canSeek,
      seek: async (deviceId, position) => {
        seeks.push({ deviceId, position });
        return true;
      },
    });
  });

  beforeEach(async () => {
    seeks.length = 0;
    canSeek = true;
    starts = true;
    // The kitchen plays track 3 of the album, two minutes in, shuffle off, repeat all.
    await as(kitchen)
      .post('/api/playback/queue/set')
      .send({
        tracks: album,
        startIndex: 2,
        deviceId: 'sonos:kitchen',
        repeat: 'all',
        commandId: `set-${Math.random()}`,
      });
    zones.sessionFor(kitchen).seekTo(120);
    zones.sessionFor(living).setQueue([]);
  });

  afterAll(() => {
    resetZoneTransfer();
    stopServerPlayback(kitchen);
    stopServerPlayback(living);
    teardown();
  });

  it('moves the album from the kitchen to the living room, at the same place', async () => {
    const res = await as(kitchen).post('/api/playback/transfer').send({ toZoneId: living });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      trackId: 't3',
      position: 120,
      resumedAtPosition: true,
      from: { id: kitchen },
      to: { id: living },
    });
    const target = zones.sessionFor(living);
    expect(target.getQueue().map((e) => e.trackId)).toEqual(['t1', 't2', 't3', 't4']);
    expect(target.getCurrentTrack()?.id).toBe('t3');
    expect(target.getSnapshot().repeat).toBe('all');
    expect(target.getState().position).toBe(120);
    expect(seeks).toEqual([{ deviceId: 'dlna:living', position: 120 }]);
    // The kitchen stopped.
    expect(zones.sessionFor(kitchen).getState().state).toBe('stopped');
  });

  it('takes radio along to the new room', async () => {
    setRadio(kitchen, true, { type: 'artist', id: 'ar-1', label: 'Bill Evans' }, null);
    await as(kitchen).post('/api/playback/transfer').send({ toZoneId: living });
    expect(getRadioState(living)).toMatchObject({ enabled: true, seed: { label: 'Bill Evans' } });
    expect(getRadioState(kitchen).enabled).toBe(false);
  });

  it('says so when the speaker cannot jump inside a track, and plays from the start', async () => {
    canSeek = false;
    const res = await as(kitchen).post('/api/playback/transfer').send({ toZoneId: living });
    expect(res.body.data.resumedAtPosition).toBe(false);
    expect(res.body.data.note).toMatch(/cannot jump/);
    expect(seeks).toEqual([]);
  });

  it('says so when the speaker does not start in time', async () => {
    starts = false;
    const res = await as(kitchen).post('/api/playback/transfer').send({ toZoneId: living });
    expect(res.body.data.note).toMatch(/did not start in time/);
  });

  it('refuses what it cannot do, with a reason', async () => {
    const same = await as(kitchen).post('/api/playback/transfer').send({ toZoneId: kitchen });
    expect(same.status).toBe(409);
    const unknown = await as(kitchen)
      .post('/api/playback/transfer')
      .send({ toZoneId: 'zone-nope' });
    expect(unknown.status).toBe(404);
    // A browser room plays only while a tab is open there.
    const browser = await as(kitchen)
      .post('/api/playback/transfer')
      .send({ toZoneId: 'zone-browser' });
    expect(browser.status).toBe(409);
    expect(browser.body.error).toBe('target_not_server_playable');
    // Nothing to move.
    const empty = await as(living).post('/api/playback/transfer').send({ toZoneId: kitchen });
    expect(empty.status).toBe(409);
    expect(empty.body.error).toBe('nothing_playing');
  });
});

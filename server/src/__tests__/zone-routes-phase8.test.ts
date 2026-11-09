import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { zones } from '../services/zones.js';
import {
  configureServerPlayer,
  initServerPlayer,
  startServerPlayback,
  stopServerPlayback,
} from '../services/server-player.js';
import { configureZoneTransfer, resetZoneTransfer } from '../services/zone-transfer.js';
import { getSleepTimer, setSleepTimer } from '../services/sleep-timer.js';
import { getRadioState, setRadio } from '../services/library-radio.js';
import { deviceManager } from '../devices/manager.js';

/**
 * Phase 8 (P09, P11, P12, P13): rooms keep their own speaker, a removed room
 * leaves nothing running, a pause reaches the speaker, and moving the music
 * stops the old speaker once and never seeks inside the wrong track.
 */

const album = [1, 2, 3].map((n) => ({
  id: `t${n}`,
  title: `Track ${n}`,
  artistName: 'Band',
  albumTitle: 'Album',
  duration: 240,
}));

describe('rooms and their speakers', () => {
  let app: Express;
  let teardown: () => void;
  let kitchen: string;
  let living: string;
  const stoppedBySession: string[] = [];
  const stoppedByTransfer: string[] = [];
  const seeks: number[] = [];

  const post = (path: string, zoneId?: string) => {
    const r = request(app).post(path).set('X-Client-Id', 'phase8-test');
    return zoneId ? r.set('X-Zone-Id', zoneId) : r;
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    configureServerPlayer({
      play: async () => {},
      supportsNextUri: async () => false,
      resolve: (async (track: { id: string; title: string }) => ({
        source: 'local',
        trackId: track.id,
        url: `http://nas/api/library/tracks/${track.id}/stream?t=x`,
        metadata: { title: track.title, artist: 'Band', album: 'Album' },
      })) as never,
      stopDevice: async (deviceId) => {
        stoppedBySession.push(deviceId);
      },
      isClientConnected: () => false,
    });
    initServerPlayer();
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
  });

  beforeEach(() => {
    stoppedBySession.length = 0;
    stoppedByTransfer.length = 0;
    seeks.length = 0;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    resetZoneTransfer();
    stopServerPlayback(kitchen);
    stopServerPlayback(living);
    teardown();
  });

  it('refuses to bind one room to the speaker of another room (P09)', async () => {
    const res = await post('/api/playback/queue/set', kitchen).send({
      tracks: album,
      deviceId: 'dlna:living',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'DeviceInOtherZone', data: { zoneId: living } });
    expect(zones.sessionFor(kitchen).getState().deviceId).not.toBe('dlna:living');

    // The room that owns it, and a speaker no room owns, still work.
    expect(
      (
        await post('/api/playback/queue/set', living).send({
          tracks: album,
          deviceId: 'dlna:living',
        })
      ).status,
    ).toBe(200);
    expect(
      (await post('/api/playback/queue/set').send({ tracks: album, deviceId: 'dlna:spare' }))
        .status,
    ).toBe(200);
    stopServerPlayback(living);
    stopServerPlayback();
  });

  it('passes a pause and a resume on to the room’s speaker (P12)', async () => {
    const pause = vi.spyOn(deviceManager, 'pause').mockResolvedValue();
    const resume = vi.spyOn(deviceManager, 'resume').mockResolvedValue();
    await post('/api/playback/queue/set', kitchen).send({
      tracks: album,
      deviceId: 'sonos:kitchen',
    });

    expect((await post('/api/playback/pause', kitchen).send({})).status).toBe(200);
    expect(pause).toHaveBeenCalledWith('sonos:kitchen');
    expect((await post('/api/playback/play', kitchen).send({})).status).toBe(200);
    expect(resume).toHaveBeenCalledWith('sonos:kitchen');
    stopServerPlayback(kitchen);
  });

  it('stops the old speaker once when the music moves, and seeks only in the moved track (P13)', async () => {
    configureZoneTransfer({
      // While the living room starts, somebody there picks other music.
      waitUntilPlaying: async (zoneId) => {
        zones.sessionFor(zoneId).setQueue([{ ...album[0], id: 'other' }], 0);
        return true;
      },
      canSeek: async () => true,
      seek: async (_deviceId, position) => {
        seeks.push(position);
        return true;
      },
      stopDevice: async (deviceId) => {
        stoppedByTransfer.push(deviceId);
      },
    });
    await post('/api/playback/queue/set', kitchen).send({
      tracks: album,
      startIndex: 1,
      deviceId: 'sonos:kitchen',
    });
    startServerPlayback('user', 'sonos:kitchen', kitchen);
    zones.sessionFor(kitchen).seekTo(90);

    const res = await post('/api/playback/transfer', kitchen).send({ toZoneId: living });
    expect(res.status).toBe(200);
    expect(res.body.data.resumedAtPosition).toBe(false);
    expect(res.body.data.note).toMatch(/something else/);
    expect(seeks).toEqual([]);
    expect([...stoppedBySession, ...stoppedByTransfer]).toEqual(['sonos:kitchen']);
    stopServerPlayback(living);
  });

  it('silences a removed room and leaves no timer or radio behind (P11)', async () => {
    const attic = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Attic', deviceId: 'sonos:attic' })
    ).body.data.id;
    await post('/api/playback/queue/set', attic).send({ tracks: album, deviceId: 'sonos:attic' });
    setSleepTimer(attic, { mode: 'in', minutes: 30 });
    setRadio(attic, true, { type: 'artist', id: 'ar', label: 'Band' }, null);

    const res = await request(app).delete(`/api/playback/zones/${attic}`);
    expect(res.status).toBe(200);
    expect(zones.get(attic)).toBeNull();
    expect(getSleepTimer(attic)).toBeNull();
    expect(getRadioState(attic).enabled).toBe(false);
    expect(stoppedBySession).toEqual(['sonos:attic']);
  });
});

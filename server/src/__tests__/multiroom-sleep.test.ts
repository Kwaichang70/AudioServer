import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { zones } from '../services/zones.js';
import {
  configureServerPlayer,
  startServerPlayback,
  stopRoom,
  stopServerPlayback,
} from '../services/server-player.js';
import {
  configureSleepTimers,
  resetSleepTimersForTests,
  setSleepTimer,
} from '../services/sleep-timer.js';

/**
 * Two rooms on two speakers (R09.4): a sleep timer stops the bedroom — its
 * session and the speaker itself — while the kitchen plays on.
 */

const album = [1, 2, 3].map((n) => ({
  id: `t${n}`,
  title: `Track ${n}`,
  artistName: 'A',
  albumTitle: 'B',
  duration: 240,
}));

describe('A sleep timer in one of two playing rooms', () => {
  let app: Express;
  let teardown: () => void;
  let bedroom: string;
  let kitchen: string;
  const told: string[] = [];

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    const make = async (name: string, deviceId: string) =>
      (await request(app).post('/api/playback/zones').send({ name, deviceId })).body.data.id;
    bedroom = await make('Bedroom', 'sonos:bedroom');
    kitchen = await make('Kitchen', 'dlna:kitchen');
    configureServerPlayer({
      stopDevice: async (deviceId) => {
        told.push(deviceId);
      },
    });
    configureSleepTimers({ stopZone: (zoneId) => void stopRoom(zoneId) });
  });

  afterAll(() => {
    resetSleepTimersForTests();
    stopServerPlayback(bedroom);
    stopServerPlayback(kitchen);
    teardown();
  });

  it('stops the bedroom speaker and leaves the kitchen playing', async () => {
    for (const [zoneId, deviceId] of [
      [bedroom, 'sonos:bedroom'],
      [kitchen, 'dlna:kitchen'],
    ]) {
      zones.sessionFor(zoneId).setQueue(album, 0, undefined, deviceId);
      zones
        .sessionFor(zoneId)
        .playItem(
          zones.sessionFor(zoneId).getCurrentItemId()!,
          { clientId: null, sessionId: null },
          deviceId,
        );
      startServerPlayback('admin', deviceId, zoneId);
    }
    expect(zones.sessionFor(bedroom).getState().state).toBe('playing');

    vi.useFakeTimers();
    try {
      setSleepTimer(bedroom, { mode: 'in', minutes: 20 });
      vi.advanceTimersByTime(21 * 60_000);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(told).toEqual(['sonos:bedroom']));

    expect(zones.sessionFor(bedroom).getState().state).toBe('stopped');
    expect(zones.sessionFor(kitchen).getState().state).toBe('playing');
    expect(zones.sessionFor(kitchen).getCurrentTrack()?.id).toBe('t1');
  });
});

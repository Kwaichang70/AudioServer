import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, seedUser, type TestUser } from './helpers/testApp.js';
import { zones } from '../services/zones.js';
import { DEFAULT_ZONE_ID } from '../db/index.js';
import { stopServerPlayback } from '../services/server-player.js';

/**
 * Zones (V10): two rooms, two queues. The acceptance rules of the sprint —
 * pause/next/volume in one room leaves the other alone, a client gets the
 * snapshot of the room it steers, a device belongs to one room only, and a
 * failure stays inside its own room.
 */
describe('two rooms play their own music', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let member: TestUser;

  const kitchen = [1, 2, 3].map((n) => ({
    id: `kitchen-${n}`,
    title: `Kitchen ${n}`,
    artistName: 'Band',
    albumTitle: 'Album',
    duration: 180,
  }));
  const living = [1, 2].map((n) => ({
    id: `living-${n}`,
    title: `Living ${n}`,
    artistName: 'Other',
    albumTitle: 'Other album',
    duration: 200,
  }));

  const as = (user: TestUser, zoneId?: string) => ({
    get: (path: string) => {
      const r = request(app).get(path).set('Authorization', `Bearer ${user.token}`);
      return zoneId ? r.set('X-Zone-Id', zoneId) : r;
    },
    post: (path: string) => {
      const r = request(app)
        .post(path)
        .set('Authorization', `Bearer ${user.token}`)
        .set('X-Client-Id', `tab-${user.username}`);
      return zoneId ? r.set('X-Zone-Id', zoneId) : r;
    },
    patch: (path: string) => request(app).patch(path).set('Authorization', `Bearer ${user.token}`),
    delete: (path: string) =>
      request(app).delete(path).set('Authorization', `Bearer ${user.token}`),
  });

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    admin = await seedUser('boss', 'admin');
    member = await seedUser('listener', 'user');
    zones.resetForTests();
    zones.initialize();
  });

  afterAll(() => {
    stopServerPlayback();
    teardown();
  });

  let kitchenZone: string;

  beforeEach(async () => {
    const existing = zones.forDevice('speaker-kitchen');
    kitchenZone =
      existing?.id ??
      (
        await as(admin).post('/api/playback/zones').send({
          name: 'Kitchen',
          deviceId: 'speaker-kitchen',
        })
      ).body.data.id;
  });

  it('gives every room its own queue', async () => {
    const inKitchen = await as(member, kitchenZone)
      .post('/api/playback/queue/set')
      .send({ tracks: kitchen, deviceId: 'speaker-kitchen', commandId: 'k-1' });
    expect(inKitchen.status).toBe(200);
    expect(inKitchen.body.data.zoneId).toBe(kitchenZone);

    const inBrowser = await as(member, DEFAULT_ZONE_ID)
      .post('/api/playback/queue/set')
      .send({ tracks: living, deviceId: 'browser', commandId: 'b-1' });
    expect(inBrowser.body.data.zoneId).toBe(DEFAULT_ZONE_ID);

    const kitchenNow = await as(member, kitchenZone).get('/api/playback/session');
    const browserNow = await as(member, DEFAULT_ZONE_ID).get('/api/playback/session');
    expect(kitchenNow.body.data.queue).toHaveLength(3);
    expect(kitchenNow.body.data.state.track?.id).toBe('kitchen-1');
    expect(browserNow.body.data.queue).toHaveLength(2);
    expect(browserNow.body.data.state.track?.id).toBe('living-1');
  });

  it('keeps pause, next and volume inside the room they were pressed in', async () => {
    await as(member, kitchenZone)
      .post('/api/playback/queue/set')
      .send({ tracks: kitchen, deviceId: 'speaker-kitchen', commandId: 'k-2' });
    await as(member, DEFAULT_ZONE_ID)
      .post('/api/playback/queue/set')
      .send({ tracks: living, deviceId: 'browser', commandId: 'b-2' });

    await as(member, kitchenZone).post('/api/playback/next').send({ commandId: 'k-next' });
    await as(member, kitchenZone).post('/api/playback/pause').send({});
    await as(member, kitchenZone).post('/api/playback/volume').send({ volume: 20 });

    const inKitchen = (await as(member, kitchenZone).get('/api/playback/session')).body.data;
    const inBrowser = (await as(member, DEFAULT_ZONE_ID).get('/api/playback/session')).body.data;

    expect(inKitchen.state.track?.id).toBe('kitchen-2');
    expect(inKitchen.state.state).toBe('paused');
    expect(inKitchen.state.volume).toBe(20);

    expect(inBrowser.state.track?.id).toBe('living-1');
    expect(inBrowser.state.state).toBe('playing');
    expect(inBrowser.state.volume).not.toBe(20);
  });

  it('answers with the room a client names, and lists what every room plays', async () => {
    const overview = await as(member).get('/api/playback/zones');
    expect(overview.status).toBe(200);
    const byId = Object.fromEntries(
      overview.body.data.map((z: { id: string }) => [z.id, z]),
    ) as Record<string, { name: string; deviceId: string; queueLength: number }>;
    expect(byId[kitchenZone]).toMatchObject({ deviceId: 'speaker-kitchen', queueLength: 3 });
    expect(byId[DEFAULT_ZONE_ID]).toMatchObject({ deviceId: 'browser', queueLength: 2 });

    // No zone named: the default room, never somebody else's.
    const fallback = await as(member).get('/api/playback/session');
    expect(fallback.body.data.zoneId).toBe(DEFAULT_ZONE_ID);

    const unknown = await as(member, 'zone-that-never-was').get('/api/playback/session');
    expect(unknown.status).toBe(404);
  });

  it('refuses to let two rooms claim the same speaker', async () => {
    const second = await as(admin)
      .post('/api/playback/zones')
      .send({ name: 'Kitchen again', deviceId: 'speaker-kitchen' });
    expect(second.status).toBe(409);
    expect(second.body.data.id).toBe(kitchenZone);
  });

  it('lets an admin rename and remove a room, but never the browser one', async () => {
    const renamed = await as(admin)
      .patch(`/api/playback/zones/${kitchenZone}`)
      .send({ name: 'Keuken' });
    expect(renamed.body.data.name).toBe('Keuken');

    const refused = await as(admin).delete(`/api/playback/zones/${DEFAULT_ZONE_ID}`);
    expect(refused.status).toBe(400);

    const asUser = await as(member)
      .post('/api/playback/zones')
      .send({ name: 'Bathroom', deviceId: 'speaker-bath' });
    expect(asUser.status).toBe(403);

    const removed = await as(admin).delete(`/api/playback/zones/${kitchenZone}`);
    expect(removed.status).toBe(200);
    expect(zones.get(kitchenZone)).toBeNull();
    // The other room is untouched.
    const browser = await as(member, DEFAULT_ZONE_ID).get('/api/playback/session');
    expect(browser.body.data.queue).toHaveLength(2);
  });
});

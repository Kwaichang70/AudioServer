import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, seedUser, type TestUser } from './helpers/testApp.js';
import { recordTransition } from '../services/transitions.js';

/**
 * V11.4: the transition log keeps what the server SAW and what somebody
 * MEASURED in separate columns, and only the second can support the words
 * "gapless verified". A measurement therefore records how it was made.
 */
describe('the transition log', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let member: TestUser;

  beforeEach(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    admin = await seedUser('boss', 'admin');
    member = await seedUser('listener', 'user');
  });

  afterEach(() => teardown());

  const as = (user: TestUser) => ({
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${user.token}`),
    post: (path: string) =>
      request(app)
        .post(path)
        .set('Authorization', `Bearer ${user.token}`)
        .set('X-Client-Id', 'tab'),
  });

  it('records how each boundary was made', async () => {
    recordTransition({
      zoneId: 'zone-browser',
      deviceId: 'speaker',
      fromTrackId: 'a',
      toTrackId: 'b',
      handover: 'next-uri',
      armedAt: 1_700_000_000_000,
    });
    recordTransition({
      zoneId: 'zone-browser',
      deviceId: 'speaker',
      fromTrackId: 'b',
      toTrackId: 'c',
      handover: 'dispatch',
    });

    const res = await as(member).get('/api/playback/transitions?deviceId=speaker');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ handover: 'dispatch', toTrackId: 'c' });
    expect(res.body.data[1]).toMatchObject({ handover: 'next-uri', armedAt: 1_700_000_000_000 });
    // Nothing has been measured, so nothing pretends to be.
    expect(
      res.body.data.every((t: { measuredGapMs: number | null }) => t.measuredGapMs === null),
    ).toBe(true);
  });

  it('takes a measurement with the method that produced it, from an admin only', async () => {
    const id = recordTransition({
      zoneId: 'zone-browser',
      deviceId: 'speaker',
      fromTrackId: 'a',
      toTrackId: 'b',
      handover: 'next-uri',
    });
    expect(id).toBeTruthy();

    const refused = await as(member)
      .post(`/api/playback/transitions/${id}/measurement`)
      .send({ gapMs: 0, method: 'guess' });
    expect(refused.status).toBe(403);

    const stored = await as(admin).post(`/api/playback/transitions/${id}/measurement`).send({
      gapMs: 35,
      method: 'Line-out recorded at 48 kHz, boundary read in Audacity',
      note: 'Album: Dark Side of the Moon, tracks 4→5',
    });

    expect(stored.status).toBe(200);
    expect(stored.body.data).toMatchObject({
      measuredGapMs: 35,
      method: 'Line-out recorded at 48 kHz, boundary read in Audacity',
    });
  });

  it('refuses a measurement for a boundary that is not in the log', async () => {
    const res = await as(admin)
      .post('/api/playback/transitions/999999/measurement')
      .send({ gapMs: 10, method: 'recording' });
    expect(res.status).toBe(404);
  });
});

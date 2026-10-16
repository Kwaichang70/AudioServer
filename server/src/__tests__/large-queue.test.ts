import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';

/**
 * A long playlist goes to the server as one queue (Danny, 16 Oct 2026): the
 * 100 kB body default refused it with a 500, and the speaker went on with the
 * previous album. A list of a thousand tracks fits now; a body that really is
 * too large is answered 413 with a reason, not 500.
 */

const track = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  title: `A fairly long track title number ${n}`,
  artistName: 'Prince and The New Power Generation',
  albumTitle: "21 Nights In London: The Earl's Court Concerts",
  albumId: '0a6a8c76-87a4-45e6-b667-c3baf69014cb',
  duration: 312,
  source: 'local',
  metadata: { format: 'flac', sampleRate: 44100, bitDepth: 16, replayGainTrack: -7.5 },
});

describe('A long queue', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    ({ app, teardown } = await createTestApp());
  });

  afterAll(() => teardown());

  it('takes a playlist of a thousand tracks in one go', async () => {
    const tracks = Array.from({ length: 1000 }, (_, i) => track(i));
    expect(JSON.stringify({ tracks }).length).toBeGreaterThan(100 * 1024);
    const res = await request(app)
      .post('/api/playback/queue/set')
      .set('X-Client-Id', 'tab')
      .send({ tracks, startIndex: 0, commandId: 'long' });
    expect(res.status).toBe(200);
    expect(res.body.data.queue).toHaveLength(1000);
  });

  it('says 413, with a reason, when a body really is too large', async () => {
    const tracks = Array.from({ length: 1000 }, (_, i) => ({
      ...track(i),
      metadata: { padding: 'x'.repeat(3000) },
    }));
    const res = await request(app)
      .post('/api/playback/queue/set')
      .set('X-Client-Id', 'tab')
      .send({ tracks, startIndex: 0, commandId: 'huge' });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('PayloadTooLarge');
  });
});

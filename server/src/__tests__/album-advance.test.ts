import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';

/**
 * Playing a whole album, over HTTP, exactly as the browser does it:
 * `POST /playback/queue/set` with every track, then `POST /playback/next`
 * at the end of each track. Danny reported an album stopping after one
 * song on the NAS, so this walks the entire flow instead of trusting the
 * unit tests of the service.
 */
describe('playing an album advances through the queue', () => {
  let app: Express;
  let teardown: () => void;

  const album = [1, 2, 3].map((n) => ({
    id: `track-${n}`,
    title: `Song ${n}`,
    artistName: 'Band',
    albumTitle: 'Album',
    albumId: 'album-1',
    duration: 180,
    source: 'local',
  }));

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => {
    teardown();
  });

  const client = (r: request.Test) => r.set('X-Client-Id', 'test-tab');

  beforeEach(async () => {
    await client(request(app).post('/api/playback/queue/clear')).send({
      commandId: `c-${Date.now()}`,
    });
  });

  it('queues every track and steps to the next one on each next command', async () => {
    const set = await client(request(app).post('/api/playback/queue/set')).send({
      tracks: album,
      startIndex: 0,
      deviceId: 'browser',
      commandId: 'set-1',
    });
    expect(set.status).toBe(200);
    expect(set.body.data.queue).toHaveLength(3);
    expect(set.body.data.state.track?.id).toBe('track-1');
    expect(set.body.data.state.state).toBe('playing');
    const firstItem = set.body.data.currentItemId;
    expect(firstItem).toBeTruthy();

    const second = await client(request(app).post('/api/playback/next')).send({
      commandId: 'next-1',
    });
    expect(second.status).toBe(200);
    expect(second.body.data.state.track?.id).toBe('track-2');
    expect(second.body.data.state.state).toBe('playing');
    expect(second.body.data.queue).toHaveLength(3);
    expect(second.body.data.currentItemId).not.toBe(firstItem);

    const third = await client(request(app).post('/api/playback/next')).send({
      commandId: 'next-2',
    });
    expect(third.body.data.state.track?.id).toBe('track-3');
    expect(third.body.data.state.state).toBe('playing');

    // End of the album with repeat off: stopped, queue kept.
    const past = await client(request(app).post('/api/playback/next')).send({
      commandId: 'next-3',
    });
    expect(past.body.data.state.state).toBe('stopped');
    expect(past.body.data.queue).toHaveLength(3);
  });

  it('keeps the queue when the browser reports progress between tracks', async () => {
    await client(request(app).post('/api/playback/queue/set')).send({
      tracks: album,
      startIndex: 0,
      deviceId: 'browser',
      commandId: 'set-2',
    });
    const item = (await request(app).get('/api/playback/session')).body.data.currentItemId;

    // The V05 heartbeat the browser sends every 10 s while it plays.
    for (const position of [10, 60, 170]) {
      const progress = await client(request(app).post('/api/playback/progress')).send({
        itemId: item,
        position,
      });
      expect(progress.status).toBe(200);
      expect(progress.body.data.accepted).toBe(true);
    }

    const snapshot = await request(app).get('/api/playback/session');
    expect(snapshot.body.data.queue).toHaveLength(3);
    expect(snapshot.body.data.state.state).toBe('playing');

    const next = await client(request(app).post('/api/playback/next')).send({
      commandId: 'next-4',
    });
    expect(next.body.data.state.track?.id).toBe('track-2');
    expect(next.body.data.state.state).toBe('playing');
  });

  it('a stale progress report from an old track never disturbs the queue', async () => {
    await client(request(app).post('/api/playback/queue/set')).send({
      tracks: album,
      startIndex: 0,
      deviceId: 'browser',
      commandId: 'set-3',
    });
    await client(request(app).post('/api/playback/next')).send({ commandId: 'next-5' });
    const stale = await client(request(app).post('/api/playback/progress')).send({
      itemId: 'an-old-item-id',
      position: 42,
    });
    expect(stale.body.data).toMatchObject({ accepted: false, reason: 'stale-item' });

    const snapshot = await request(app).get('/api/playback/session');
    expect(snapshot.body.data.state.track?.id).toBe('track-2');
    expect(snapshot.body.data.queue).toHaveLength(3);
  });
});

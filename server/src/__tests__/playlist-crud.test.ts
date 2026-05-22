import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';

describe('Playlist CRUD', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => {
    teardown();
  });

  it('creates a playlist with valid input', async () => {
    const res = await request(app)
      .post('/api/playlists')
      .send({ name: 'My Mix', description: 'A nice mix' });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('My Mix');
    expect(res.body.data.id).toBeTruthy();
  });

  it('rejects playlists with empty name (zod validation)', async () => {
    const res = await request(app).post('/api/playlists').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
    expect(res.body.issues[0].where).toBe('body');
  });

  it('rejects playlists with overlong name', async () => {
    const res = await request(app)
      .post('/api/playlists')
      .send({ name: 'x'.repeat(300) });
    expect(res.status).toBe(400);
  });

  it('lists playlists', async () => {
    const res = await request(app).get('/api/playlists');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('updates a playlist', async () => {
    const created = await request(app).post('/api/playlists').send({ name: 'Update me' });
    const id = created.body.data.id;

    const res = await request(app).patch(`/api/playlists/${id}`).send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated');
  });

  it('deletes a playlist', async () => {
    const created = await request(app).post('/api/playlists').send({ name: 'Delete me' });
    const id = created.body.data.id;

    const del = await request(app).delete(`/api/playlists/${id}`);
    expect(del.status).toBe(200);

    const get = await request(app).get(`/api/playlists/${id}`);
    expect(get.status).toBe(404);
  });

  it('returns 404 for unknown playlist id', async () => {
    const res = await request(app).get('/api/playlists/nope');
    expect(res.status).toBe(404);
  });
});

describe('Playback queue', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => {
    teardown();
  });

  it('starts with an empty queue', async () => {
    const res = await request(app).get('/api/playback/queue');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('rejects queue/add without a track (zod validation)', async () => {
    const res = await request(app).post('/api/playback/queue/add').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('rejects queue/remove with a non-integer index', async () => {
    const res = await request(app)
      .post('/api/playback/queue/remove')
      .send({ index: 'not-a-number' });
    expect(res.status).toBe(400);
  });

  it('rejects queue/remove with negative index', async () => {
    const res = await request(app).post('/api/playback/queue/remove').send({ index: -1 });
    expect(res.status).toBe(400);
  });

  it('accepts a valid track shape', async () => {
    const res = await request(app)
      .post('/api/playback/queue/add')
      .send({ track: { id: 'test-1', title: 'Hello', artistName: 'Artist' } });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

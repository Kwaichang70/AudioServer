import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * API keys for assistants (Grok, Jarvis): made by a person signed in, shown
 * once, stored as a hash; a key controls playback and reads the library and
 * can do nothing else — not even when an admin made it.
 */

describe('API keys', () => {
  let app: Express;
  let teardown: () => void;
  let member: TestUser;
  let key: string;
  let keyId: string;

  const withKey = (r: request.Test, k = key) => r.set('Authorization', `Bearer ${k}`);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    member = ctx.member!;
    const res = await request(app).post('/api/auth/api-keys').send({ name: 'Grok' });
    expect(res.status).toBe(201);
    key = res.body.data.key;
    keyId = res.body.data.id;
  });

  afterAll(() => teardown());

  it('is shown once, listed without the key, and stored only as a hash', async () => {
    expect(key).toMatch(/^as_[A-Za-z0-9_-]{40,}$/);
    const list = (await request(app).get('/api/auth/api-keys')).body.data;
    expect(list).toEqual([
      expect.objectContaining({ id: keyId, name: 'Grok', prefix: key.slice(0, 10) }),
    ]);
    expect(JSON.stringify(list)).not.toContain(key);
    const row = getRawDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId);
    expect(JSON.stringify(row)).not.toContain(key);
  });

  it('controls playback and reads the library, without a client id header', async () => {
    expect((await withKey(request(app).get('/api/playback/session'))).status).toBe(200);
    const volume = await withKey(request(app).post('/api/playback/volume')).send({ volume: 30 });
    expect(volume.status).toBe(200);
    expect((await withKey(request(app).get('/api/library/albums'))).status).toBe(200);
    expect((await withKey(request(app).get('/api/home'))).status).toBe(200);
    // Also as X-API-Key, for clients that keep Authorization for something else.
    const viaHeader = await request(app)
      .get('/api/playback/session')
      .set('Authorization', 'Bearer something-of-the-client')
      .set('X-API-Key', key);
    expect(viaHeader.status).toBe(200);
  });

  it('does nothing else — not even for the admin who made it', async () => {
    const refused = [
      withKey(request(app).get('/api/auth/sessions')),
      withKey(request(app).post('/api/auth/api-keys')).send({ name: 'More' }),
      withKey(request(app).post('/api/library/scan')),
      withKey(request(app).post('/api/playlists')).send({ name: 'x' }),
      // Admin-only inside playback: making a room.
      withKey(request(app).post('/api/playback/zones')).send({ name: 'R', deviceId: 'dlna:x' }),
    ];
    for (const res of await Promise.all(refused)) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('ApiKeyScope');
    }
  });

  it('can only be revoked by its owner, and then stops working', async () => {
    const other = await request(app)
      .delete(`/api/auth/api-keys/${keyId}`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(other.status).toBe(404);
    expect((await request(app).delete(`/api/auth/api-keys/${keyId}`)).status).toBe(200);
    expect((await withKey(request(app).get('/api/playback/session'))).status).toBe(401);
    expect((await request(app).get('/api/auth/api-keys')).body.data).toEqual([]);
  });

  it('refuses an unknown key', async () => {
    const res = await withKey(request(app).get('/api/playback/session'), `as_${'x'.repeat(43)}`);
    expect(res.status).toBe(401);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { existsSync } from 'fs';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { loadTokens } from '../services/tokenstore.js';
import { getSetupCode, setupCodePath } from '../services/setup.js';

/**
 * End-to-end auth flow: setup mode → first admin with setup code → login →
 * protected access → sessions/stream tokens die with their user.
 *
 * Uses auth: 'none' so nothing is injected: every status code below is what a
 * real browser would get.
 */
describe('Auth flow', () => {
  let app: Express;
  let teardown: () => void;
  let adminToken: string;
  let adminUsername: string;
  let secondUserId: string;

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => {
    teardown();
  });

  it('is closed in setup mode: only setup-status/health answer without a token', async () => {
    const status = await request(app).get('/api/auth/setup-status');
    expect(status.status).toBe(200);
    expect(status.body.data).toEqual({ needsSetup: true, setupCodeSource: 'generated' });

    const stats = await request(app).get('/api/library/stats');
    expect(stats.status).toBe(401);
    expect(stats.body.message).toBe('Setup required');

    const streamToken = await request(app).get('/api/auth/stream-token');
    expect(streamToken.status).toBe(401);

    const health = await request(app).get('/api/health');
    expect(health.status).toBe(401);
    const ready = await request(app).get('/api/health/ready');
    expect(ready.status).toBe(200);

    const me = await request(app).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data).toBeNull();
  });

  it('writes the generated setup code next to the database', () => {
    const code = getSetupCode();
    expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(existsSync(setupCodePath())).toBe(true);
    expect(getSetupCode()).toBe(code); // stable until used
  });

  it('refuses registration without the setup code', async () => {
    const missing = await request(app)
      .post('/api/auth/register')
      .send({ username: 'intruder', password: 'changeme123' });
    expect(missing.status).toBe(400);

    const wrong = await request(app)
      .post('/api/auth/register')
      .send({ username: 'intruder', password: 'changeme123', setupCode: 'NOPE-0000' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.message).toBe('Invalid setup code');
    expect(getRawDb().prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 0 });
  });

  it('atomically registers exactly one first user as admin with the setup code', async () => {
    const setupCode = getSetupCode()!;
    const registrations = await Promise.all([
      request(app)
        .post('/api/auth/register')
        .send({ username: 'admin', password: 'changeme123', setupCode }),
      request(app)
        .post('/api/auth/register')
        .send({ username: 'racing-admin', password: 'changeme123', setupCode }),
    ]);
    const success = registrations.find((res) => res.status === 200);
    const rejected = registrations.find((res) => res.status === 403);

    expect(success?.body.data.user.role).toBe('admin');
    expect(success?.body.data.token).toBeTruthy();
    expect(rejected?.body.error).toBe('Forbidden');

    const users = getRawDb().prepare('SELECT id, username, role FROM users').all() as Array<{
      id: string;
      username: string;
      role: string;
    }>;
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('admin');

    adminToken = success!.body.data.token;
    adminUsername = success!.body.data.user.username;

    // Setup is over: code gone, status flips, register is closed for good.
    expect(getSetupCode()).toBeNull();
    expect(existsSync(setupCodePath())).toBe(false);
    const status = await request(app).get('/api/auth/setup-status');
    expect(status.body.data).toEqual({ needsSetup: false });
    const again = await request(app)
      .post('/api/auth/register')
      .send({ username: 'late', password: 'changeme123', setupCode: 'ANY-CODE' });
    expect(again.status).toBe(403);
  });

  it('lets admins create additional users through /users/create', async () => {
    const res = await request(app)
      .post('/api/auth/users/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'second-user', password: 'changeme123' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ username: 'second-user', role: 'user' });
    secondUserId = res.body.data.id;
  });

  it('rejects protected requests without a token once users exist', async () => {
    const res = await request(app).get('/api/library/stats');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
    expect(res.body.message).toBe('Authentication required');
  });

  it('rejects invalid tokens with 401', async () => {
    const res = await request(app)
      .get('/api/library/stats')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('accepts valid tokens and returns the resource', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: adminUsername, password: 'changeme123' });
    expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ username: adminUsername, role: 'admin' });
    const token = login.body.data.token;

    const res = await request(app)
      .get('/api/library/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tracks).toBe(0);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.data).toMatchObject({ username: adminUsername, role: 'admin' });
    expect(me.body.data.sessionId).toBeTruthy();
  });

  it('login with wrong password returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: adminUsername, password: 'wrongpassword' });
    expect(res.status).toBe(401);
  });

  it('rejects weak passwords on register (zod validation)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'newbie', password: 'short', setupCode: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('issues a stream-token for authenticated users', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: adminUsername, password: 'changeme123' });
    const token = login.body.data.token;

    const res = await request(app)
      .get('/api/auth/stream-token')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.expiresIn).toBe(3600);
  });

  it('refuses stream-token without auth', async () => {
    const res = await request(app).get('/api/auth/stream-token');
    expect(res.status).toBe(401);
  });

  it('rejects bearer and stream tokens after their user is deleted', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'second-user', password: 'changeme123' });
    expect(login.status).toBe(200);
    const deletedUserToken = login.body.data.token;

    const streamToken = await request(app)
      .get('/api/auth/stream-token')
      .set('Authorization', `Bearer ${deletedUserToken}`);
    expect(streamToken.status).toBe(200);

    const deleted = await request(app)
      .delete(`/api/auth/users/${secondUserId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deleted.status).toBe(200);

    const bearerResponse = await request(app)
      .get('/api/library/stats')
      .set('Authorization', `Bearer ${deletedUserToken}`);
    expect(bearerResponse.status).toBe(401);

    const streamResponse = await request(app).get(
      `/api/library/tracks/missing/stream?t=${encodeURIComponent(streamToken.body.data.token)}`,
    );
    expect(streamResponse.status).toBe(401);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${deletedUserToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data).toBeNull();
  });

  it('encrypts imported provider tokens before storing them', async () => {
    const expiresAt = Date.now() + 3_600_000;
    const res = await request(app)
      .post('/api/auth/import-token')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        provider: 'spotify',
        accessToken: 'imported-access-token',
        refreshToken: 'imported-refresh-token',
        expiresAt,
      });
    expect(res.status).toBe(200);

    const row = getRawDb()
      .prepare('SELECT access_token, refresh_token FROM provider_tokens WHERE provider = ?')
      .get('spotify') as { access_token: string; refresh_token: string };
    expect(row.access_token).not.toBe('imported-access-token');
    expect(row.refresh_token).not.toBe('imported-refresh-token');
    expect(loadTokens('spotify')).toMatchObject({
      accessToken: 'imported-access-token',
      refreshToken: 'imported-refresh-token',
      expiresAt,
    });
  });
});

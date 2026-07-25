import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { loadTokens } from '../services/tokenstore.js';

/**
 * End-to-end auth flow test. This is the regression test for the fase 1
 * security fix: authMiddleware was defined but never mounted, leaving every
 * endpoint unauthenticated. The tests below would have caught that bug —
 * they exercise the full first-run → register → protected access cycle.
 */
describe('Auth flow', () => {
  let app: Express;
  let teardown: () => void;
  let adminToken: string;
  let adminUsername: string;
  let firstRunStreamToken: string;
  let secondUserId: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => {
    teardown();
  });

  it('allows protected access during first-run (no users yet)', async () => {
    // requireAuth should bypass auth when the users table is empty so the
    // operator can call /register without a token.
    const res = await request(app).get('/api/library/stats');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ artists: 0, albums: 0, tracks: 0 });

    const streamToken = await request(app).get('/api/auth/stream-token');
    expect(streamToken.status).toBe(200);
    firstRunStreamToken = streamToken.body.data.token;
  });

  it('atomically registers exactly one first user as admin', async () => {
    const registrations = await Promise.all([
      request(app).post('/api/auth/register').send({ username: 'admin', password: 'changeme123' }),
      request(app)
        .post('/api/auth/register')
        .send({ username: 'racing-admin', password: 'changeme123' }),
    ]);
    const success = registrations.find((res) => res.status === 200);
    const rejected = registrations.find((res) => res.status === 403);

    expect(success?.body.data.user.role).toBe('admin');
    expect(success?.body.data.token).toBeTruthy();
    expect(rejected?.body.error).toBe('Registration is closed. Admins must use /users/create.');

    const users = getRawDb().prepare('SELECT id, username, role FROM users').all() as Array<{
      id: string;
      username: string;
      role: string;
    }>;
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('admin');

    adminToken = success!.body.data.token;
    adminUsername = success!.body.data.user.username;
  });

  it('invalidates an anonymous first-run stream token after registration', async () => {
    const res = await request(app).get(
      `/api/library/tracks/missing/stream?t=${encodeURIComponent(firstRunStreamToken)}`,
    );
    expect(res.status).toBe(401);
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
    const token = login.body.data.token;

    const res = await request(app)
      .get('/api/library/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.tracks).toBe(0);
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
      .send({ username: 'newbie', password: 'short' });
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

  it('refuses stream-token without auth (after first user exists)', async () => {
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
    expect(loadTokens('spotify')).toEqual({
      accessToken: 'imported-access-token',
      refreshToken: 'imported-refresh-token',
      expiresAt,
    });
  });

  it('serves /api/health without auth', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('returns 404 for unknown /api/* paths through the error handler', async () => {
    // Authenticate first — requireAuth runs before notFoundHandler, so without
    // a token an unknown path returns 401 (intentional: no endpoint enumeration
    // for unauthenticated callers).
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: adminUsername, password: 'changeme123' });
    const token = login.body.data.token;

    const res = await request(app)
      .get('/api/does-not-exist')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NotFound');
  });
});

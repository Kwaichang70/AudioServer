import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';

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
  });

  it('registers the first user as admin and returns a JWT', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'admin', password: 'changeme123' });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ username: 'admin', role: 'admin' });
    expect(res.body.data.token).toBeTruthy();
    adminToken = res.body.data.token;
  });

  it('closes public registration after first-run', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'second-user', password: 'changeme123' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Registration is closed. Admins must use /users/create.');
  });

  it('lets admins create additional users through /users/create', async () => {
    const res = await request(app)
      .post('/api/auth/users/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'second-user', password: 'changeme123' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ username: 'second-user', role: 'user' });
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
      .send({ username: 'admin', password: 'changeme123' });
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
      .send({ username: 'admin', password: 'wrongpassword' });
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
      .send({ username: 'admin', password: 'changeme123' });
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
      .send({ username: 'admin', password: 'changeme123' });
    const token = login.body.data.token;

    const res = await request(app)
      .get('/api/does-not-exist')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NotFound');
  });
});

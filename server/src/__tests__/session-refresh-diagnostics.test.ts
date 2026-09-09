import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { getSetupCode } from '../services/setup.js';
import { logger } from '../logger.js';
import { redactMessage } from '../routes/health.js';

/**
 * V08.4: sliding token renewal and the admin diagnostics export.
 * The export must carry versions and state, and never a token, a password
 * or a full file path.
 */
describe('session refresh and diagnostics', () => {
  let app: Express;
  let teardown: () => void;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    const code = getSetupCode()!;
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'admin', password: 'password-1', setupCode: code });
    adminToken = reg.body.data.token;
    await request(app)
      .post('/api/auth/users/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'listener', password: 'password-2', role: 'user' });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'listener', password: 'password-2' });
    userToken = login.body.data.token;
  });

  afterAll(() => {
    teardown();
  });

  it('renews a valid session with a new token and a later expiry; the old session id stays', async () => {
    const before = jwt.decode(userToken) as { sid: string; exp: number };
    getRawDb()
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(Date.now() + 60_000, before.sid);
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    const after = jwt.decode(res.body.data.token) as { sid: string; exp: number };
    expect(after.sid).toBe(before.sid);
    expect(res.body.data.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
    // The renewed token works, and the row moved along with it.
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.data.token}`);
    expect(me.body.data.username).toBe('listener');
  });

  it('refuses to renew a revoked session', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: 'listener', password: 'password-2' });
    const token = login.body.data.token;
    await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('diagnostics are admin-only, carry versions and state, and leak no secrets or paths', async () => {
    logger.warn(`Cannot read music directory /volume1/music/Adele/19: EACCES`);
    logger.error(`Provider call failed with Bearer ${adminToken}`);
    logger.warn('Qobuz: login failed for token=abc123secret');

    const denied = await request(app)
      .get('/api/health/diagnostics')
      .set('Authorization', `Bearer ${userToken}`);
    expect(denied.status).toBe(403);

    const res = await request(app)
      .get('/api/health/diagnostics')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.app.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.app.buildId).toBeTruthy();
    expect(d.db.schemaVersion).toBe(d.db.expectedSchemaVersion);
    expect(d.counts.users).toBe(2);
    expect(d.playback.state).toBe('stopped');
    expect(Array.isArray(d.recentLog)).toBe(true);

    const text = JSON.stringify(d);
    expect(text).not.toContain(adminToken);
    expect(text).not.toContain('abc123secret');
    expect(text).not.toContain('/volume1/music/Adele');
    expect(text).not.toContain('password-1');
    expect(text).toContain('…/19');
  });

  it('redacts tokens, secrets and paths in messages', () => {
    expect(
      redactMessage(
        'x eyJhbGciOiJIUzI1NiJ9abcdefghijk.eyJzdWIiOiIxMjM0NTY3ODkwIn0abcdef.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c y',
      ),
    ).toBe('x [token] y');
    expect(redactMessage('failed password=hunter2 now')).toBe('failed password=[redacted] now');
    expect(redactMessage('Cannot read /volume1/music/Artist/Album: EACCES')).toBe(
      'Cannot read …/Album: EACCES',
    );
    expect(redactMessage('plain message')).toBe('plain message');
  });
});

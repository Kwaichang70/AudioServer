import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, seedUser, TEST_PASSWORD, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { findUser, listUsers, setUserPassword } from '../services/user-recovery.js';

/**
 * Locked out of the app with no other admin to reset you: on the server,
 * `npm run user:password` shows the user names and sets a new password.
 */
describe('user recovery on the server', () => {
  let app: Express;
  let teardown: () => void;
  let danny: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    danny = await seedUser('Danny', 'admin');
    await seedUser('guest', 'user');
  });

  afterAll(() => teardown());

  const login = (username: string, password: string) =>
    request(app).post('/api/auth/login').send({ username, password });

  it('lists who can log in, so a forgotten user name is found', () => {
    expect(listUsers(getRawDb())).toEqual([
      { username: 'Danny', role: 'admin' },
      { username: 'guest', role: 'user' },
    ]);
  });

  it('finds a user ignoring case, but only when that is unambiguous', () => {
    expect(findUser(getRawDb(), 'danny')?.username).toBe('Danny');
    expect(findUser(getRawDb(), 'nobody')).toBeNull();
  });

  it('sets a new password and signs the old sessions out', async () => {
    const before = await request(app)
      .get('/api/library/stats')
      .set('Authorization', `Bearer ${danny.token}`);
    expect(before.status).toBe(200);

    const r = await setUserPassword(getRawDb(), 'danny', 'a-new-secret-1');
    expect(r).toEqual({ username: 'Danny', revokedSessions: 1 });

    expect((await login('Danny', TEST_PASSWORD)).status).toBe(401);
    expect((await login('Danny', 'a-new-secret-1')).status).toBe(200);
    const after = await request(app)
      .get('/api/library/stats')
      .set('Authorization', `Bearer ${danny.token}`);
    expect(after.status).toBe(401);
  });

  it('refuses a short password or an unknown user, changing nothing', async () => {
    await expect(setUserPassword(getRawDb(), 'guest', 'short')).rejects.toThrow(/8 to 256/);
    await expect(setUserPassword(getRawDb(), 'nobody', 'long-enough-1')).rejects.toThrow(/No user/);
    expect((await login('guest', TEST_PASSWORD)).status).toBe(200);
  });
});

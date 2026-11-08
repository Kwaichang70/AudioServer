import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, seedUser, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { hashPassword } from '../middleware/auth.js';

/**
 * B12: bcrypt only reads the first 72 bytes. A new password longer than
 * that is refused with a clear message instead of being cut off silently;
 * logging in with an existing longer one keeps working.
 */
describe('password length', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    admin = await seedUser('admin', 'admin');
  });

  afterAll(() => teardown());

  const create = (password: string) =>
    request(app)
      .post('/api/auth/users/create')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ username: `u${Math.random().toString(36).slice(2, 8)}`, password });

  it('takes 71 and 72 bytes, refuses 73 with a reason', async () => {
    expect((await create('a'.repeat(71))).status).toBe(201);
    expect((await create('a'.repeat(72))).status).toBe(201);
    const tooLong = await create('a'.repeat(73));
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.body)).toMatch(/72 bytes/);
  });

  it('counts bytes, not letters: 30 emoji are 120 bytes', async () => {
    expect((await create('🎵'.repeat(18))).status).toBe(201); // 72 bytes
    expect((await create('🎵'.repeat(30))).status).toBe(400);
  });

  it('still lets an existing longer password log in', async () => {
    const long = `${'x'.repeat(80)}-tail`;
    getRawDb()
      .prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES ('old', 'oldtimer', ?, 'user')",
      )
      .run(await hashPassword(long));
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'oldtimer', password: long });
    expect(res.status).toBe(200);
  });
});

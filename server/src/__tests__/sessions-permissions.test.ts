import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, seedUser, TEST_PASSWORD, type TestUser } from './helpers/testApp.js';
import { signSystemStreamToken, verifyStreamToken } from '../middleware/auth.js';
import {
  createSession,
  listUserSessions,
  onSessionsRevoked,
  revokeSession,
} from '../services/sessions.js';

/**
 * V02.2 rights matrix + V02.3 session lifecycle. Every "user gets 403" row in
 * docs/permissions.md is asserted here, so the matrix cannot drift from the
 * code silently.
 */
describe('permissions matrix', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    admin = await seedUser('admin', 'admin');
    member = await seedUser('member', 'user');
  });

  afterAll(() => teardown());

  const adminOnly: Array<[string, string, Record<string, unknown>?]> = [
    ['get', '/api/auth/users'],
    ['post', '/api/auth/users/create', { username: 'x', password: 'changeme123' }],
    ['post', '/api/auth/users/some-id/reset-password', { password: 'changeme123' }],
    ['post', '/api/auth/users/some-id/revoke-sessions'],
    ['delete', '/api/auth/users/some-id'],
    [
      'post',
      '/api/auth/import-token',
      { provider: 'spotify', accessToken: 'a', refreshToken: 'r' },
    ],
    ['post', '/api/providers/spotify/auth/init', { redirectUri: 'http://localhost/cb' }],
    [
      'post',
      '/api/providers/spotify/auth/callback',
      { code: 'c', redirectUri: 'http://localhost/cb' },
    ],
    ['post', '/api/providers/spotify/auth/logout'],
    ['post', '/api/providers/tidal/auth/init', { redirectUri: 'http://localhost/cb' }],
    [
      'post',
      '/api/providers/tidal/auth/callback',
      { code: 'c', redirectUri: 'http://localhost/cb' },
    ],
    ['post', '/api/providers/tidal/auth/logout'],
    ['post', '/api/providers/qobuz/auth/login', { username: 'u', password: 'p' }],
    ['post', '/api/providers/qobuz/auth/logout'],
    ['post', '/api/library/scan'],
    ['post', '/api/library/covers/fetch'],
    ['post', '/api/library/artists/images/fetch'],
    ['post', '/api/librespot/start', { username: 'u', password: 'p' }],
    ['post', '/api/librespot/stop'],
  ];

  it.each(adminOnly)(
    '%s %s → 403 for a regular user, 401 anonymous',
    async (method, path, body) => {
      const m = method as 'get' | 'post' | 'delete';
      const agent = request(app);
      const asUser = await agent[m](path)
        .set('Authorization', `Bearer ${member.token}`)
        .send(body ?? {});
      expect(asUser.status, `${method} ${path} as user`).toBe(403);
      expect(asUser.body).toMatchObject({ error: 'Forbidden', message: 'Admin role required' });

      const anonymousAgent = request(app);
      const anonymous = await anonymousAgent[m](path).send(body ?? {});
      expect(anonymous.status, `${method} ${path} anonymous`).toBe(401);
    },
  );

  it('lets an admin past the role check (validation/state errors are not 403)', async () => {
    const users = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(users.status).toBe(200);
    expect(users.body.data.map((u: { username: string }) => u.username).sort()).toEqual([
      'admin',
      'member',
    ]);

    const scan = await request(app)
      .post('/api/library/scan')
      .set('Authorization', `Bearer ${admin.token}`);
    expect([200, 409]).toContain(scan.status);
  });

  it('validates provider auth bodies before touching the provider', async () => {
    const res = await request(app)
      .post('/api/providers/spotify/auth/init')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ redirectUri: 'not a url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  // V09.3: a Last.fm or ListenBrainz account belongs to a person, not to the
  // household, so connecting and disconnecting one is no longer admin-only.
  // The API key/secret in the environment stay admin territory.
  it.each([
    ['post', '/api/scrobble/lastfm/disconnect'],
    ['post', '/api/scrobble/listenbrainz/disconnect'],
  ])('lets a regular user manage their own scrobble account (%s %s)', async (method, path) => {
    const post = (token?: string) => {
      const req = request(app).post(path);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
    const asUser = await post(member.token).send({});
    expect(asUser.status, `${method} ${path} as user`).toBe(200);

    const anonymous = await post().send({});
    expect(anonymous.status, `${method} ${path} anonymous`).toBe(401);
  });

  it('keeps household actions open to regular users', async () => {
    const paths = ['/api/library/stats', '/api/providers/status', '/api/scrobble/config'];
    for (const path of paths) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${member.token}`);
      expect(res.status, path).toBe(200);
    }
  });
});

describe('session lifecycle', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    admin = await seedUser('admin', 'admin');
    member = await seedUser('member', 'user');
  });

  afterAll(() => teardown());

  async function login(username: string, password = TEST_PASSWORD) {
    const res = await request(app)
      .post('/api/auth/login')
      .set('User-Agent', 'vitest-browser')
      .send({ username, password });
    expect(res.status).toBe(200);
    return res.body.data.token as string;
  }

  it('logout ends the session; the token and its stream token stop working', async () => {
    const token = await login('member');
    const stream = await request(app)
      .get('/api/auth/stream-token')
      .set('Authorization', `Bearer ${token}`);
    expect(stream.status).toBe(200);

    const revokedIds: string[] = [];
    const off = onSessionsRevoked((ids) => revokedIds.push(...ids));

    const logout = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(logout.status).toBe(200);
    off();
    expect(revokedIds).toHaveLength(1);

    const after = await request(app)
      .get('/api/library/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.data).toBeNull();
    const streamAfter = await request(app).get(
      `/api/library/tracks/missing/stream?t=${encodeURIComponent(stream.body.data.token)}`,
    );
    expect(streamAfter.status).toBe(401);

    // Logging out twice is harmless.
    const again = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(again.status).toBe(200);
  });

  it("lists own sessions and revokes one of them, never someone else's", async () => {
    const a = await login('member');
    const b = await login('member');
    const list = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${a}`);
    expect(list.status).toBe(200);
    const sessions = list.body.data as Array<{ id: string; current: boolean; userAgent: string }>;
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.some((s) => s.userAgent === 'vitest-browser')).toBe(true);
    const other = sessions.find((s) => !s.current)!;

    const foreign = await request(app)
      .delete(`/api/auth/sessions/${admin.sessionId}`)
      .set('Authorization', `Bearer ${a}`);
    expect(foreign.status).toBe(404);

    const revoke = await request(app)
      .delete(`/api/auth/sessions/${other.id}`)
      .set('Authorization', `Bearer ${a}`);
    expect(revoke.status).toBe(200);
    const bAfter = await request(app).get('/api/library/stats').set('Authorization', `Bearer ${b}`);
    expect(bAfter.status).toBe(401);
    const aStill = await request(app).get('/api/library/stats').set('Authorization', `Bearer ${a}`);
    expect(aStill.status).toBe(200);
  });

  it('revoke-others keeps only the calling session', async () => {
    const keep = await login('member');
    const drop = await login('member');
    const res = await request(app)
      .post('/api/auth/sessions/revoke-others')
      .set('Authorization', `Bearer ${keep}`);
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBeGreaterThanOrEqual(1);
    expect(
      (await request(app).get('/api/library/stats').set('Authorization', `Bearer ${drop}`)).status,
    ).toBe(401);
    expect(
      (await request(app).get('/api/library/stats').set('Authorization', `Bearer ${keep}`)).status,
    ).toBe(200);
  });

  it('password change needs the current password and signs out other sessions', async () => {
    const token = await login('member');
    const other = await login('member');
    const wrong = await request(app)
      .post('/api/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'nope-nope-nope', newPassword: 'brand-new-pass-1' });
    expect(wrong.status).toBe(403);

    const ok = await request(app)
      .post('/api/auth/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'brand-new-pass-1' });
    expect(ok.status).toBe(200);
    expect(
      (await request(app).get('/api/library/stats').set('Authorization', `Bearer ${other}`)).status,
    ).toBe(401);
    expect(
      (await request(app).get('/api/library/stats').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(200);

    const oldLogin = await request(app)
      .post('/api/auth/login')
      .send({ username: 'member', password: TEST_PASSWORD });
    expect(oldLogin.status).toBe(401);
    await login('member', 'brand-new-pass-1');
  });

  it('admin reset-password signs the user out everywhere and sets the new password', async () => {
    const victim = await login('member', 'brand-new-pass-1');
    const reset = await request(app)
      .post(`/api/auth/users/${member.id}/reset-password`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ password: 'reset-by-admin-1' });
    expect(reset.status).toBe(200);
    expect(reset.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(
      (await request(app).get('/api/library/stats').set('Authorization', `Bearer ${victim}`))
        .status,
    ).toBe(401);
    await login('member', 'reset-by-admin-1');

    const missing = await request(app)
      .post('/api/auth/users/does-not-exist/reset-password')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ password: 'reset-by-admin-1' });
    expect(missing.status).toBe(404);
  });

  it("admin revoke-sessions ends every session of a user but not the admin's own", async () => {
    const t1 = await login('member', 'reset-by-admin-1');
    const t2 = await login('member', 'reset-by-admin-1');
    const res = await request(app)
      .post(`/api/auth/users/${member.id}/revoke-sessions`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.revoked).toBeGreaterThanOrEqual(2);
    for (const t of [t1, t2]) {
      expect(
        (await request(app).get('/api/library/stats').set('Authorization', `Bearer ${t}`)).status,
      ).toBe(401);
    }
    expect(listUserSessions(member.id)).toHaveLength(0);
    expect(
      (await request(app).get('/api/auth/users').set('Authorization', `Bearer ${admin.token}`))
        .status,
    ).toBe(200);
  });

  it('a token without a session row is rejected even with a valid signature', async () => {
    const { token, sessionId } = createSession(member.id);
    expect(
      (await request(app).get('/api/library/stats').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(200);
    revokeSession(sessionId);
    expect(
      (await request(app).get('/api/library/stats').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(401);
  });

  it('system stream tokens work without a session (server-driven device playback)', async () => {
    const token = signSystemStreamToken();
    expect(verifyStreamToken(token)).toEqual({ userId: 'system' });
    // Verified through the real middleware: unknown track → 404, not 401.
    const res = await request(app).get(
      `/api/library/tracks/missing/stream?t=${encodeURIComponent(token)}`,
    );
    expect(res.status).not.toBe(401);
    expect(verifyStreamToken(token.slice(0, -2))).toBeNull();
  });
});

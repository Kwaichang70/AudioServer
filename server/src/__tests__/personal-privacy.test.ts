import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, seedUser, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * V09 privacy contract. One library, two people: what each of them builds up
 * is theirs. The rules asserted here are the ones docs/permissions.md states:
 *
 *   1. A read never returns another user's rows — admin included. Being an
 *      admin manages accounts, it does not open somebody's listening history.
 *   2. A playlist can be shared with the household: visible to everyone,
 *      editable only by its owner.
 *   3. An id that is not yours answers 404, never 403, so a guessed id says
 *      nothing about who else uses this server.
 */
describe('personal data stays personal', () => {
  let app: Express;
  let teardown: () => void;
  let anna: TestUser;
  let ben: TestUser;

  const as = (user: TestUser) => ({
    get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${user.token}`),
    post: (path: string) => request(app).post(path).set('Authorization', `Bearer ${user.token}`),
    patch: (path: string) => request(app).patch(path).set('Authorization', `Bearer ${user.token}`),
    delete: (path: string) =>
      request(app).delete(path).set('Authorization', `Bearer ${user.token}`),
  });

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    anna = await seedUser('anna', 'user');
    ben = await seedUser('ben', 'admin'); // an admin, deliberately

    const db = getRawDb();
    db.prepare(
      "INSERT INTO artists (id, name, source) VALUES ('artist-1', 'Anna''s Band', 'local')",
    ).run();
    db.prepare(
      `INSERT INTO albums (id, title, artist_id, artist_name, source)
       VALUES ('album-1', 'Private Pressing', 'artist-1', 'Anna''s Band', 'local')`,
    ).run();
    db.prepare(
      `INSERT INTO listening_sessions
         (id, user_id, track_id, source, title, artist_name, album_title, album_id, artist_id,
          duration, started_at, ended_at, listened_ms, status, qualified)
       VALUES ('listen-anna', ?, 'track-1', 'local', 'Secret Song', 'Anna''s Band',
               'Private Pressing', 'album-1', 'artist-1', 200, 1700000000, 1700000200,
               200000, 'ended', 1)`,
    ).run(anna.id);
  });

  afterAll(() => teardown());

  it('keeps favorites apart', async () => {
    const added = await as(anna).post('/api/history/favorites').send({
      itemType: 'album',
      itemId: 'album-1',
    });
    expect(added.status).toBe(200);
    expect(added.body.data.favorited).toBe(true);

    expect((await as(anna).get('/api/history/favorites?type=album')).body.data).toHaveLength(1);
    expect((await as(ben).get('/api/history/favorites?type=album')).body.data).toHaveLength(0);
    expect(
      (await as(ben).get('/api/history/favorites/check?type=album&id=album-1')).body.data,
    ).toEqual({ favorited: false });

    // Both may like the same album; the unique index is per user now.
    const bensToo = await as(ben).post('/api/history/favorites').send({
      itemType: 'album',
      itemId: 'album-1',
    });
    expect(bensToo.status).toBe(200);
    expect(bensToo.body.data.favorited).toBe(true);
    expect((await as(anna).get('/api/history/favorites?type=album')).body.data).toHaveLength(1);
  });

  it('keeps listening history and statistics apart, admin included', async () => {
    expect((await as(anna).get('/api/history/tracks')).body.meta.total).toBe(1);
    expect((await as(ben).get('/api/history/tracks')).body.meta.total).toBe(0);

    expect((await as(anna).get('/api/history/stats?days=0')).body.data.listens).toBe(1);
    expect((await as(ben).get('/api/history/stats?days=0')).body.data.listens).toBe(0);

    expect((await as(anna).get('/api/history/recent')).body.data).toHaveLength(1);
    expect((await as(ben).get('/api/history/recent')).body.data).toHaveLength(0);
    expect((await as(ben).get('/api/history/top-artists')).body.data).toHaveLength(0);
  });

  it('answers 404 — not 403 — for somebody else’s playlist', async () => {
    const created = await as(anna).post('/api/playlists').send({ name: 'Anna only' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    expect((await as(anna).get('/api/playlists')).body.data).toHaveLength(1);
    expect((await as(ben).get('/api/playlists')).body.data).toHaveLength(0);

    for (const res of [
      await as(ben).get(`/api/playlists/${id}`),
      await as(ben).patch(`/api/playlists/${id}`).send({ name: 'mine now' }),
      await as(ben).delete(`/api/playlists/${id}`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Playlist not found');
    }
  });

  it('shares a playlist read-only with the household', async () => {
    const created = await as(anna)
      .post('/api/playlists')
      .send({ name: 'Kitchen radio', shared: true });
    const id = created.body.data.id;

    const seen = await as(ben).get(`/api/playlists/${id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.name).toBe('Kitchen radio');
    expect(
      (await as(ben).get('/api/playlists')).body.data.map((p: { id: string }) => p.id),
    ).toEqual([id]);

    // Visible is not editable: only the owner writes.
    expect((await as(ben).patch(`/api/playlists/${id}`).send({ name: 'no' })).status).toBe(404);
    expect((await as(ben).delete(`/api/playlists/${id}`)).status).toBe(404);
    expect((await as(anna).patch(`/api/playlists/${id}`).send({ name: 'Kitchen' })).status).toBe(
      200,
    );
  });

  it('keeps smart playlists and scrobble accounts apart', async () => {
    const created = await as(anna)
      .post('/api/smart-playlists')
      .send({ name: 'Anna smart', rules: [{ field: 'genre', operator: 'equals', value: 'Jazz' }] });
    expect(created.status).toBe(201);

    expect((await as(anna).get('/api/smart-playlists')).body.data).toHaveLength(1);
    expect((await as(ben).get('/api/smart-playlists')).body.data).toHaveLength(0);
    expect((await as(ben).get(`/api/smart-playlists/${created.body.data.id}`)).status).toBe(404);

    // A scrobble account is personal: Anna connecting hers leaves Ben's alone.
    getRawDb()
      .prepare(
        `INSERT INTO scrobble_config (user_id, listenbrainz_token, listenbrainz_enabled)
         VALUES (?, 'anna-token', 1)`,
      )
      .run(anna.id);
    expect((await as(anna).get('/api/scrobble/config')).body.data.listenbrainz.enabled).toBe(true);
    expect((await as(ben).get('/api/scrobble/config')).body.data.listenbrainz.enabled).toBe(false);
    expect((await as(ben).get('/api/listenbrainz/status')).body.data.configured).toBe(false);
    expect((await as(anna).get('/api/listenbrainz/status')).body.data.configured).toBe(true);
  });
});

/**
 * V09.4: deleting an account takes that person's private data with it, but
 * not what they had shared with the household.
 */
describe('deleting an account hands over what was shared', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let leaver: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    admin = await seedUser('boss', 'admin');
    leaver = await seedUser('leaver', 'user');
  });

  afterAll(() => teardown());

  it('keeps the shared playlist, removes the private one and the listening data', async () => {
    const bearer = (user: TestUser) => `Bearer ${user.token}`;
    const shared = await request(app)
      .post('/api/playlists')
      .set('Authorization', bearer(leaver))
      .send({ name: 'Kitchen radio', shared: true });
    const private_ = await request(app)
      .post('/api/playlists')
      .set('Authorization', bearer(leaver))
      .send({ name: 'Guilty pleasures' });
    await request(app)
      .post('/api/history/favorites')
      .set('Authorization', bearer(leaver))
      .send({ itemType: 'album', itemId: 'album-x' });

    const deleted = await request(app)
      .delete(`/api/auth/users/${leaver.id}`)
      .set('Authorization', bearer(admin));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.sharedPlaylistsHandedOver).toBe(1);

    const mine = await request(app).get('/api/playlists').set('Authorization', bearer(admin));
    expect(mine.body.data.map((p: { id: string }) => p.id)).toEqual([shared.body.data.id]);
    expect(
      (
        await request(app)
          .get(`/api/playlists/${private_.body.data.id}`)
          .set('Authorization', bearer(admin))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get('/api/history/favorites?type=album')
          .set('Authorization', bearer(admin))
      ).body.data,
    ).toHaveLength(0);
    expect(getRawDb().prepare('SELECT COUNT(*) as n FROM favorites').get()).toEqual({ n: 0 });
  });
});

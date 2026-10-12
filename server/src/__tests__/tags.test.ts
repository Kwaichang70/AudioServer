import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * Tags (R06.1): the listener's own order. Yours to edit, a shared one
 * readable but not editable by the household, any other a 404.
 */

describe('Tags', () => {
  let app: Express;
  let teardown: () => void;
  let member: TestUser;
  const asMember = (r: request.Test) => r.set('Authorization', `Bearer ${member.token}`);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    member = ctx.member!;
    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar-1', 'Bill Evans'), ('ar-2', 'Nick Drake');
      INSERT INTO albums (id, title, artist_id, artist_name, year) VALUES
        ('al-1', 'Sunday at the Village Vanguard', 'ar-1', 'Bill Evans', 1961),
        ('al-2', 'Pink Moon', 'ar-2', 'Nick Drake', 1972);
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, disc_number, track_number) VALUES
        ('t-1', 'Gloria''s Step', 'al-1', 'Sunday at the Village Vanguard', 'ar-1', 'Bill Evans', 1, 1),
        ('t-2', 'My Man''s Gone Now', 'al-1', 'Sunday at the Village Vanguard', 'ar-1', 'Bill Evans', 1, 2),
        ('t-3', 'Pink Moon', 'al-2', 'Pink Moon', 'ar-2', 'Nick Drake', 1, 1),
        ('t-gone', 'Lost take', 'al-2', 'Pink Moon', 'ar-2', 'Nick Drake', 1, 9);
      UPDATE tracks SET availability = 'missing' WHERE id = 't-gone';
    `);
  });

  afterAll(() => teardown());

  it('creates, renames and lists your tags, refusing a duplicate name', async () => {
    const created = await request(app).post('/api/tags').send({ name: 'Zondagochtend' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: 'Zondagochtend', mine: true, itemCount: 0 });
    const dup = await request(app).post('/api/tags').send({ name: 'zondagochtend' });
    expect(dup.status).toBe(409);
    // Someone else may use the same name for their own tag.
    const theirs = await asMember(request(app).post('/api/tags')).send({ name: 'Zondagochtend' });
    expect(theirs.status).toBe(201);

    const renamed = await request(app)
      .patch(`/api/tags/${created.body.data.id}`)
      .send({ name: 'Sunday morning' });
    expect(renamed.body.data.name).toBe('Sunday morning');
    const list = await request(app).get('/api/tags');
    expect(list.body.data.map((t: { name: string }) => t.name)).toEqual(['Sunday morning']);
  });

  it('tags albums, artists and tracks, and plays what they stand for', async () => {
    const tag = (await request(app).post('/api/tags').send({ name: 'Late' })).body.data;
    await request(app)
      .post(`/api/tags/${tag.id}/items`)
      .send({ itemType: 'album', itemId: 'al-1' });
    await request(app).post(`/api/tags/${tag.id}/items`).send({ itemType: 'track', itemId: 't-3' });
    const again = await request(app)
      .post(`/api/tags/${tag.id}/items`)
      .send({ itemType: 'album', itemId: 'al-1' });
    expect(again.status).toBe(201);
    expect(again.body.data.counts).toEqual({ album: 1, artist: 0, track: 1, playlist: 0 });

    const unknown = await request(app)
      .post(`/api/tags/${tag.id}/items`)
      .send({ itemType: 'album', itemId: 'nope' });
    expect(unknown.status).toBe(404);

    const detail = await request(app).get(`/api/tags/${tag.id}`);
    expect(detail.body.data.items.albums.map((a: { id: string }) => a.id)).toEqual(['al-1']);
    expect(detail.body.data.items.tracks.map((t: { id: string }) => t.id)).toEqual(['t-3']);

    const tracks = await request(app).get(`/api/tags/${tag.id}/tracks`);
    // The album's tracks in order and the single track; never a missing file.
    expect(tracks.body.data.map((t: { id: string }) => t.id)).toEqual(['t-3', 't-1', 't-2']);

    // Tagging an artist brings all of their albums.
    await request(app)
      .post(`/api/tags/${tag.id}/items`)
      .send({ itemType: 'artist', itemId: 'ar-2' });
    const withArtist = await request(app).get(`/api/tags/${tag.id}/tracks`);
    expect(withArtist.body.data.map((t: { id: string }) => t.id)).not.toContain('t-gone');

    const on = await request(app).get('/api/tags/on/album/al-1');
    expect(on.body.data.map((t: { name: string }) => t.name)).toEqual(['Late']);

    const removed = await request(app).delete(`/api/tags/${tag.id}/items/album/al-1`);
    expect(removed.body.data.counts.album).toBe(0);
  });

  describe('ownership (V09)', () => {
    it('hides a private tag completely from someone else', async () => {
      const tag = (await request(app).post('/api/tags').send({ name: 'Private' })).body.data;
      await request(app)
        .post(`/api/tags/${tag.id}/items`)
        .send({ itemType: 'album', itemId: 'al-2' });

      expect((await asMember(request(app).get(`/api/tags/${tag.id}`))).status).toBe(404);
      expect((await asMember(request(app).get(`/api/tags/${tag.id}/tracks`))).status).toBe(404);
      const list = await asMember(request(app).get('/api/tags'));
      expect(list.body.data.map((t: { name: string }) => t.name)).not.toContain('Private');
      const on = await asMember(request(app).get('/api/tags/on/album/al-2'));
      expect(on.body.data).toEqual([]);
      const write = await asMember(request(app).post(`/api/tags/${tag.id}/items`)).send({
        itemType: 'album',
        itemId: 'al-1',
      });
      expect(write.status).toBe(404);
    });

    it('lets the household read a shared tag but not change it', async () => {
      const tag = (await request(app).post('/api/tags').send({ name: 'Family', shared: true })).body
        .data;
      await request(app)
        .post(`/api/tags/${tag.id}/items`)
        .send({ itemType: 'album', itemId: 'al-2' });

      const read = await asMember(request(app).get(`/api/tags/${tag.id}`));
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({ mine: false, ownerName: 'admin', shared: true });
      const list = await asMember(request(app).get('/api/tags'));
      // Your own tags first, then the household's.
      expect(list.body.data.map((t: { name: string }) => t.name)).toEqual([
        'Zondagochtend',
        'Family',
      ]);

      for (const attempt of [
        asMember(request(app).patch(`/api/tags/${tag.id}`)).send({ name: 'Mine now' }),
        asMember(request(app).delete(`/api/tags/${tag.id}`)),
        asMember(request(app).post(`/api/tags/${tag.id}/items`)).send({
          itemType: 'track',
          itemId: 't-1',
        }),
        asMember(request(app).delete(`/api/tags/${tag.id}/items/album/al-2`)),
      ]) {
        expect((await attempt).status).toBe(404);
      }
      expect((await request(app).get(`/api/tags/${tag.id}`)).body.data.itemCount).toBe(1);
    });

    it('only lets you tag a playlist you can see, and never reveals a private one', async () => {
      const db = getRawDb();
      db.prepare(
        `INSERT INTO playlists (id, name, user_id, shared) VALUES ('pl-secret', 'Secret', ?, 0)`,
      ).run(member.id);
      const mine = (await request(app).post('/api/tags').send({ name: 'Lists', shared: true })).body
        .data;
      const denied = await request(app)
        .post(`/api/tags/${mine.id}/items`)
        .send({ itemType: 'playlist', itemId: 'pl-secret' });
      expect(denied.status).toBe(404);

      // The member tags their own private playlist in a shared tag of theirs:
      const theirs = (
        await asMember(request(app).post('/api/tags')).send({ name: 'Shared lists', shared: true })
      ).body.data;
      await asMember(request(app).post(`/api/tags/${theirs.id}/items`)).send({
        itemType: 'playlist',
        itemId: 'pl-secret',
      });
      const asAdmin = await request(app).get(`/api/tags/${theirs.id}`);
      expect(asAdmin.body.data.items.playlists).toEqual([]);
    });

    it('deletes a tag with its items', async () => {
      const tag = (await request(app).post('/api/tags').send({ name: 'Temp' })).body.data;
      await request(app)
        .post(`/api/tags/${tag.id}/items`)
        .send({ itemType: 'album', itemId: 'al-1' });
      expect((await request(app).delete(`/api/tags/${tag.id}`)).status).toBe(200);
      const left = getRawDb()
        .prepare('SELECT COUNT(*) as n FROM tag_items WHERE tag_id = ?')
        .get(tag.id) as { n: number };
      expect(left.n).toBe(0);
    });
  });
});

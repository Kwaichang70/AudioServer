import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * Ratings (R06.4): one to five stars per person, for a track or an album;
 * a Focus filter and a sort key, and nobody else's business.
 */

describe('Ratings', () => {
  let app: Express;
  let teardown: () => void;
  let member: TestUser;
  const asMember = (r: request.Test) => r.set('Authorization', `Bearer ${member.token}`);
  const rate = (itemType: string, itemId: string, rating: number | null) =>
    request(app).put('/api/ratings').send({ itemType, itemId, rating });
  const ids = (res: request.Response) => res.body.data.map((r: { id: string }) => r.id);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    member = ctx.member!;
    getRawDb().exec(`
      INSERT INTO artists (id, name) VALUES ('ar', 'Someone');
      INSERT INTO albums (id, title, artist_id, artist_name, year) VALUES
        ('al-a', 'Alpha', 'ar', 'Someone', 1970), ('al-b', 'Beta', 'ar', 'Someone', 1980),
        ('al-c', 'Gamma', 'ar', 'Someone', 1990);
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, disc_number, track_number) VALUES
        ('t-a', 'One', 'al-a', 'Alpha', 'ar', 'Someone', 1, 1),
        ('t-b', 'Two', 'al-b', 'Beta', 'ar', 'Someone', 1, 1),
        ('t-c', 'Three', 'al-c', 'Gamma', 'ar', 'Someone', 1, 1);
    `);
  });

  afterAll(() => teardown());

  it('sets, changes and clears a rating, only for real items and 1–5', async () => {
    expect((await rate('album', 'al-a', 5)).status).toBe(200);
    expect((await rate('album', 'al-b', 3)).status).toBe(200);
    expect((await rate('album', 'al-b', 2)).status).toBe(200);
    expect((await rate('track', 't-c', 4)).status).toBe(200);
    expect((await request(app).get('/api/ratings?type=album')).body.data).toEqual({
      'al-a': 5,
      'al-b': 2,
    });
    expect((await rate('album', 'al-a', 6)).status).toBe(400);
    expect((await rate('album', 'al-a', 0)).status).toBe(400);
    expect((await rate('album', 'nope', 3)).status).toBe(404);
    expect((await rate('playlist', 'x', 3)).status).toBe(400);

    await rate('album', 'al-b', null);
    expect((await request(app).get('/api/ratings?type=album')).body.data).toEqual({ 'al-a': 5 });
    await rate('album', 'al-b', 2);
  });

  it("keeps stars personal: nobody sees or filters on someone else's", async () => {
    expect((await asMember(request(app).get('/api/ratings?type=album'))).body.data).toEqual({});
    const theirs = await asMember(request(app).get('/api/library/albums?ratingMin=1'));
    expect(theirs.body.meta.total).toBe(0);
    await asMember(request(app).put('/api/ratings')).send({
      itemType: 'album',
      itemId: 'al-c',
      rating: 5,
    });
    // Their five stars do not change mine.
    expect((await request(app).get('/api/ratings?type=album')).body.data).toEqual({
      'al-a': 5,
      'al-b': 2,
    });
  });

  it('filters and sorts by my rating, unrated last', async () => {
    const atLeast3 = await request(app).get('/api/library/albums?ratingMin=3');
    expect(ids(atLeast3)).toEqual(['al-a']);
    const sorted = await request(app).get('/api/library/albums?sort=rating');
    expect(ids(sorted)).toEqual(['al-a', 'al-b', 'al-c']);
    expect(sorted.body.data.map((a: { rating: number | null }) => a.rating)).toEqual([5, 2, null]);
    const ascending = await request(app).get('/api/library/albums?sort=rating&order=asc');
    expect(ids(ascending)).toEqual(['al-b', 'al-a', 'al-c']);

    const tracks = await request(app).get('/api/library/tracks?ratingMin=4');
    expect(ids(tracks)).toEqual(['t-c']);
  });

  it('counts albums per star level, other filters applied', async () => {
    const facets = await request(app).get('/api/library/albums/facets?ratingMin=5');
    expect(facets.body.data.rating).toEqual([
      { value: '1', count: 2 },
      { value: '2', count: 2 },
      { value: '3', count: 1 },
      { value: '4', count: 1 },
      { value: '5', count: 1 },
    ]);
    expect(facets.body.data.total).toBe(1);
  });

  it('lets a smart playlist use stars — the owner’s', async () => {
    const created = await request(app)
      .post('/api/smart-playlists')
      .send({ name: 'Best', shared: true, definition: { groups: ['ratingMin=4'] } });
    const mine = await request(app).get(`/api/smart-playlists/${created.body.data.id}/tracks`);
    expect(ids(mine)).toEqual(['t-c']);
    const forThem = await asMember(
      request(app).get(`/api/smart-playlists/${created.body.data.id}/tracks`),
    );
    expect(ids(forThem)).toEqual(['t-c']);
  });
});

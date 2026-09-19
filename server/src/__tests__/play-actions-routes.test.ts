import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * R01 — the two library routes the play actions stand on:
 *  - every track of an artist in one request, album by album, so "play
 *    artist" is one call instead of one per album;
 *  - a list added to a playlist in order, which is how the queue is saved as
 *    a playlist. Each entry follows the V12.1 single-add rules; what those
 *    refuse is left out and named, never failing the whole list.
 */
describe('play action routes (R01)', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;

    const db = getRawDb();
    db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar-1', 'Miles');
    db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar-2', 'Someone else');
    // tracks.album_id is a real foreign key, so the albums come first.
    const insertAlbum = db.prepare(
      'INSERT INTO albums (id, title, artist_id, artist_name) VALUES (?, ?, ?, ?)',
    );
    insertAlbum.run('al-kob', 'Kind of Blue', 'ar-1', 'Miles');
    insertAlbum.run('al-bit', 'Bitches Brew', 'ar-1', 'Miles');
    insertAlbum.run('al-x', 'Other', 'ar-2', 'Someone else');
    const insertTrack = db.prepare(
      `INSERT INTO tracks (
        id, title, album_id, album_title, artist_id, artist_name, disc_number, track_number,
        duration, availability
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Deliberately inserted out of order: the route must sort, not the caller.
    insertTrack.run(
      'k2',
      'So What',
      'al-kob',
      'Kind of Blue',
      'ar-1',
      'Miles',
      1,
      1,
      560,
      'available',
    );
    insertTrack.run(
      'b1',
      'Pharaoh',
      'al-bit',
      'Bitches Brew',
      'ar-1',
      'Miles',
      1,
      2,
      600,
      'available',
    );
    insertTrack.run(
      'k3',
      'Blue',
      'al-kob',
      'Kind of Blue',
      'ar-1',
      'Miles',
      1,
      3,
      330,
      'available',
    );
    insertTrack.run(
      'b0',
      'Spanish',
      'al-bit',
      'Bitches Brew',
      'ar-1',
      'Miles',
      1,
      1,
      1200,
      'available',
    );
    insertTrack.run(
      'gone',
      'Missing',
      'al-kob',
      'Kind of Blue',
      'ar-1',
      'Miles',
      1,
      2,
      300,
      'missing',
    );
    insertTrack.run('x1', 'Other', 'al-x', 'Other', 'ar-2', 'Someone else', 1, 1, 200, 'available');
  });

  afterAll(() => teardown());

  describe('GET /library/artists/:id/tracks', () => {
    it('returns the artist in album, disc and track order', async () => {
      const res = await request(app).get('/api/library/artists/ar-1/tracks');

      expect(res.status).toBe(200);
      expect(res.body.data.map((t: { id: string }) => t.id)).toEqual(['b0', 'b1', 'k2', 'k3']);
    });

    it('leaves out files that are missing, which would only be skipped', async () => {
      const res = await request(app).get('/api/library/artists/ar-1/tracks');
      expect(res.body.data.map((t: { id: string }) => t.id)).not.toContain('gone');
    });

    it('never mixes in another artist', async () => {
      const res = await request(app).get('/api/library/artists/ar-1/tracks');
      expect(res.body.data.map((t: { id: string }) => t.id)).not.toContain('x1');
    });

    it('answers an unknown artist with an empty list', async () => {
      const res = await request(app).get('/api/library/artists/nobody/tracks');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('POST /playlists/:id/tracks with a list', () => {
    async function newPlaylist(name: string): Promise<string> {
      const res = await request(app).post('/api/playlists').send({ name });
      return res.body.data.id as string;
    }

    async function trackIdsOf(playlistId: string): Promise<string[]> {
      const res = await request(app).get(`/api/playlists/${playlistId}/tracks`);
      return res.body.data.map((t: { id: string }) => t.id);
    }

    const local = (trackId: string) => ({ trackId });

    it('adds the whole list in the order given, in one request', async () => {
      const id = await newPlaylist('Saved queue');

      const res = await request(app)
        .post(`/api/playlists/${id}/tracks`)
        .send({ items: [local('k3'), local('b0'), local('k2')] });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ trackCount: 3, added: 3, skipped: 0 });
      expect(await trackIdsOf(id)).toEqual(['k3', 'b0', 'k2']);
    });

    it('keeps a track that appears twice, twice', async () => {
      const id = await newPlaylist('Repeats');

      await request(app)
        .post(`/api/playlists/${id}/tracks`)
        .send({ items: [local('k2'), local('b0'), local('k2')] });

      expect(await trackIdsOf(id)).toEqual(['k2', 'b0', 'k2']);
    });

    it('stores a Qobuz track with its snapshot, as a single add would (V12.1)', async () => {
      const id = await newPlaylist('Mixed');

      const res = await request(app)
        .post(`/api/playlists/${id}/tracks`)
        .send({
          items: [
            local('k2'),
            { trackId: 'qobuz:123', title: 'Nardis', artistName: 'Bill Evans', duration: 400 },
            local('b0'),
          ],
        });

      expect(res.body.data).toMatchObject({ added: 3, skipped: 0, trackCount: 3 });
      expect(await trackIdsOf(id)).toEqual(['k2', 'qobuz:123', 'b0']);
    });

    it('leaves out what a single add would refuse, and says why', async () => {
      const id = await newPlaylist('Partly refused');

      const res = await request(app)
        .post(`/api/playlists/${id}/tracks`)
        .send({
          items: [
            local('k2'),
            // An external track that cannot describe itself, and an id the
            // library does not know.
            { trackId: 'qobuz:9' },
            local('not-in-library'),
            local('b0'),
          ],
        });

      expect(res.body.data).toMatchObject({ added: 2, skipped: 2, trackCount: 2 });
      const skipped = res.body.data.skippedItems as Array<{ trackId: string; reason: string }>;
      expect(skipped.map((item) => item.trackId)).toEqual(['qobuz:9', 'not-in-library']);
      expect(skipped.every((item) => item.reason.length > 0)).toBe(true);
      expect(await trackIdsOf(id)).toEqual(['k2', 'b0']);
    });

    it('appends after items that were already there', async () => {
      const id = await newPlaylist('Grows');
      await request(app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'x1' });

      await request(app)
        .post(`/api/playlists/${id}/tracks`)
        .send({ items: [local('k2'), local('k3')] });

      expect(await trackIdsOf(id)).toEqual(['x1', 'k2', 'k3']);
    });

    it('still accepts a single trackId the V12.1 way', async () => {
      const id = await newPlaylist('Single');

      const res = await request(app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'k2' });

      expect(res.status).toBe(200);
      expect(res.body.data.trackCount).toBe(1);
    });

    it('refuses an empty list and a body with neither shape', async () => {
      const id = await newPlaylist('Empty body');
      const empty = await request(app).post(`/api/playlists/${id}/tracks`).send({ items: [] });
      const neither = await request(app).post(`/api/playlists/${id}/tracks`).send({});
      expect(empty.status).toBe(400);
      expect(neither.status).toBe(400);
    });

    it('does not let another user add to a playlist they do not own', async () => {
      const id = await newPlaylist('Private');
      const member = await request(app)
        .post('/api/auth/login')
        .send({ username: 'member', password: 'changeme123' });

      const res = await request(app)
        .post(`/api/playlists/${id}/tracks`)
        .set('Authorization', `Bearer ${member.body.data.token}`)
        .send({ items: [local('k2')] });

      expect(res.status).toBe(404);
      expect(await trackIdsOf(id)).toEqual([]);
    });
  });
});

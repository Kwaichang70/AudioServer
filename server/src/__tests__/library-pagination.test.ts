import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

describe('Library pagination', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;

    const db = getRawDb();
    const insertArtist = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)');
    const insertAlbum = db.prepare(
      'INSERT INTO albums (id, title, artist_id, artist_name, track_count) VALUES (?, ?, ?, ?, ?)',
    );
    const insertTrack = db.prepare(
      `INSERT INTO tracks (
        id, title, album_id, album_title, artist_id, artist_name, track_number, duration
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (let i = 1; i <= 5; i += 1) {
      const artistId = `artist-${i}`;
      const albumId = `album-${i}`;
      insertArtist.run(artistId, `Artist ${i}`);
      insertAlbum.run(albumId, `Album ${i}`, artistId, `Artist ${i}`, 2);
      insertTrack.run(
        `track-${i}-1`,
        `Track ${i}.1`,
        albumId,
        `Album ${i}`,
        artistId,
        `Artist ${i}`,
        1,
        180,
      );
      insertTrack.run(
        `track-${i}-2`,
        `Track ${i}.2`,
        albumId,
        `Album ${i}`,
        artistId,
        `Artist ${i}`,
        2,
        181,
      );
    }
  });

  afterAll(() => {
    teardown();
  });

  it('returns paginated artists with meta data', async () => {
    const res = await request(app).get('/api/library/artists?page=2&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data.map((artist: { id: string }) => artist.id)).toEqual([
      'artist-3',
      'artist-4',
    ]);
    expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3 });
  });

  it('returns paginated albums with meta data', async () => {
    const res = await request(app).get('/api/library/albums?page=1&limit=3');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.meta).toEqual({ page: 1, limit: 3, total: 5, totalPages: 2 });
  });

  it('returns paginated tracks sorted by album and track number', async () => {
    const res = await request(app).get('/api/library/tracks?page=2&limit=4');

    expect(res.status).toBe(200);
    expect(res.body.data.map((track: { id: string }) => track.id)).toEqual([
      'track-3-1',
      'track-3-2',
      'track-4-1',
      'track-4-2',
    ]);
    expect(res.body.meta).toEqual({ page: 2, limit: 4, total: 10, totalPages: 3 });
  });

  it('records the baseline Drizzle migration', async () => {
    const row = getRawDb().prepare('SELECT COUNT(*) as count FROM __drizzle_migrations').get() as {
      count: number;
    };

    expect(row.count).toBe(1);
  });
});

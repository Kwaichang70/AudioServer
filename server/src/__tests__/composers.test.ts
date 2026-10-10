import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * Composers (R04.4). A composer made none of the recordings and is on all of
 * them, so the page is organised by work, with every recording beneath it —
 * and tracks without a work tag are listed, not hidden.
 */

describe('Composers', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;

    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES
        ('ar-mahler', 'Gustav Mahler'), ('ar-bach', 'Johann Sebastian Bach'),
        ('ar-vpo', 'Wiener Philharmoniker'), ('ar-bpo', 'Berliner Philharmoniker'),
        ('ar-gould', 'Glenn Gould');
      INSERT INTO albums (id, title, artist_id, artist_name, year) VALUES
        ('al-vpo', 'Mahler 5', 'ar-vpo', 'Wiener Philharmoniker', 1987),
        ('al-bpo', 'Mahler: Symphony 5', 'ar-bpo', 'Berliner Philharmoniker', 1993),
        ('al-gould', 'Goldberg Variations', 'ar-gould', 'Glenn Gould', 1981);
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration,
                           disc_number, track_number, work, movement)
       VALUES (?, ?, ?, ?, ?, ?, 600, 1, ?, ?, ?)`,
    );
    track.run(
      'v1',
      'I. Trauermarsch',
      'al-vpo',
      'Mahler 5',
      'ar-vpo',
      'Wiener Philharmoniker',
      1,
      'Symphony No. 5',
      'I. Trauermarsch',
    );
    track.run(
      'v4',
      'IV. Adagietto',
      'al-vpo',
      'Mahler 5',
      'ar-vpo',
      'Wiener Philharmoniker',
      4,
      'Symphony No. 5',
      'IV. Adagietto',
    );
    track.run(
      'b4',
      'Adagietto',
      'al-bpo',
      'Mahler: Symphony 5',
      'ar-bpo',
      'Berliner Philharmoniker',
      4,
      'Symphony No. 5',
      'IV. Adagietto',
    );
    // A Mahler song with no work tag: it must still be on his page.
    track.run(
      'lied',
      'Ich bin der Welt abhanden gekommen',
      'al-bpo',
      'Mahler: Symphony 5',
      'ar-bpo',
      'Berliner Philharmoniker',
      6,
      null,
      null,
    );
    track.run(
      'g1',
      'Aria',
      'al-gould',
      'Goldberg Variations',
      'ar-gould',
      'Glenn Gould',
      1,
      'Goldberg Variations, BWV 988',
      'Aria',
    );
    db.exec(`
      INSERT INTO track_artists (track_id, artist_id, role, position) VALUES
        ('v1', 'ar-mahler', 'composer', 0), ('v4', 'ar-mahler', 'composer', 0),
        ('b4', 'ar-mahler', 'composer', 0), ('lied', 'ar-mahler', 'composer', 0),
        ('g1', 'ar-bach', 'composer', 0),
        ('v1', 'ar-vpo', 'main', 0), ('g1', 'ar-gould', 'main', 0);
    `);
  });

  afterAll(() => teardown());

  it('lists composers from the composer credits, not from album artists', async () => {
    const res = await request(app).get('/api/library/composers');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      [
        { id: 'ar-mahler', name: 'Gustav Mahler', trackCount: 4, albumCount: 2, workCount: 1 },
        {
          id: 'ar-bach',
          name: 'Johann Sebastian Bach',
          trackCount: 1,
          albumCount: 1,
          workCount: 1,
        },
      ].sort((a, b) => a.name.localeCompare(b.name)),
    );
    // An orchestra is a performer, not a composer.
    expect(res.body.data.some((c: { id: string }) => c.id === 'ar-vpo')).toBe(false);
  });

  it('organises a composer by work, with every recording beneath it', async () => {
    const res = await request(app).get('/api/library/composers/ar-mahler');
    expect(res.status).toBe(200);
    const [symphony, other] = res.body.data.works;
    expect(symphony.work).toBe('Symphony No. 5');
    expect(symphony.recordings.map((r: { albumId: string }) => r.albumId).sort()).toEqual([
      'al-bpo',
      'al-vpo',
    ]);
    const vienna = symphony.recordings.find((r: { albumId: string }) => r.albumId === 'al-vpo');
    expect(vienna.tracks.map((t: { movement: string }) => t.movement)).toEqual([
      'I. Trauermarsch',
      'IV. Adagietto',
    ]);
    // The untagged song is listed last, under "other pieces", not dropped.
    expect(other.work).toBeNull();
    expect(other.recordings[0].tracks[0].title).toBe('Ich bin der Welt abhanden gekommen');
  });

  it('answers 404 for someone who composed nothing in the library', async () => {
    expect((await request(app).get('/api/library/composers/ar-vpo')).status).toBe(404);
    expect((await request(app).get('/api/library/composers/nobody')).status).toBe(404);
  });
});

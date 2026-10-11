import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { parseFocusQuery, serializeFocusQuery } from '../services/focus.js';

/**
 * Focus (R05.1): sorting, filters and facet counts on the library lists.
 * OR within a facet, AND across facets, counts that leave the facet's own
 * filter out, and listening data that belongs to whoever asks.
 */

describe('Focus', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let member: TestUser;

  const ids = (res: request.Response) => res.body.data.map((r: { id: string }) => r.id);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    admin = ctx.admin!;
    member = ctx.member!;

    const db = getRawDb();
    const now = Math.floor(Date.now() / 1000);
    const old = now - 400 * 86400;
    db.exec(`
      INSERT INTO artists (id, name) VALUES
        ('ar-miles', 'Miles Davis'), ('ar-herbie', 'Herbie Hancock'),
        ('ar-rj', 'Robert Johnson'), ('ar-czech', 'Czech Philharmonic'),
        ('ar-dvorak', 'Antonín Dvořák');
    `);
    const album = db.prepare(
      `INSERT INTO albums (id, title, artist_id, artist_name, year, original_year, genre, format,
                           bit_depth, sample_rate, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    album.run(
      'al-kob',
      'Kind of Blue',
      'ar-miles',
      'Miles Davis',
      1959,
      null,
      'Jazz',
      'flac',
      24,
      96000,
      'Columbia',
      old,
    );
    album.run(
      'al-brew',
      'Bitches Brew',
      'ar-miles',
      'Miles Davis',
      1970,
      null,
      'Jazz',
      'flac',
      16,
      44100,
      'Columbia',
      old,
    );
    album.run(
      'al-hh',
      'Head Hunters',
      'ar-herbie',
      'Herbie Hancock',
      1973,
      null,
      'Jazz',
      'flac',
      24,
      192000,
      'Columbia',
      old,
    );
    // The same album again, a later CD edition: hidden when editions are deduped.
    album.run(
      'al-hh-cd',
      'Head Hunters',
      'ar-herbie',
      'Herbie Hancock',
      1997,
      1973,
      'Jazz',
      'flac',
      16,
      44100,
      'Columbia',
      old,
    );
    album.run(
      'al-thrust',
      'Thrust',
      'ar-herbie',
      'Herbie Hancock',
      1974,
      null,
      'Jazz',
      'flac',
      24,
      96000,
      'Columbia',
      now,
    );
    album.run(
      'al-rj',
      'King of the Delta Blues',
      'ar-rj',
      'Robert Johnson',
      1975,
      null,
      'Blues',
      'mp3',
      null,
      44100,
      'Columbia',
      old,
    );
    album.run(
      'al-dvo',
      'New World Symphony',
      'ar-czech',
      'Czech Philharmonic',
      1985,
      null,
      'Classical',
      'flac',
      16,
      44100,
      'Supraphon',
      now,
    );
    db.exec(`
      INSERT INTO album_genres (album_id, genre) VALUES
        ('al-kob', 'Jazz'), ('al-brew', 'Jazz'), ('al-brew', 'Fusion'), ('al-hh', 'Jazz'),
        ('al-hh', 'Fusion'), ('al-hh-cd', 'Jazz'), ('al-thrust', 'Jazz'), ('al-rj', 'Blues'),
        ('al-dvo', 'Classical');
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration,
                           disc_number, track_number, format, bit_depth, sample_rate, created_at)
       SELECT ?, ?, a.id, a.title, a.artist_id, a.artist_name, ?, 1, 1, a.format, a.bit_depth,
              a.sample_rate, a.created_at
         FROM albums a WHERE a.id = ?`,
    );
    track.run('t-kob', 'So What', 545, 'al-kob');
    track.run('t-brew', 'Pharaoh’s Dance', 1200, 'al-brew');
    track.run('t-hh', 'Chameleon', 941, 'al-hh');
    track.run('t-hh-cd', 'Chameleon', 941, 'al-hh-cd');
    track.run('t-thrust', 'Palm Grease', 640, 'al-thrust');
    track.run('t-rj', 'Cross Road Blues', 150, 'al-rj');
    track.run('t-dvo', 'Largo', 720, 'al-dvo');
    db.exec(`INSERT INTO track_artists (track_id, artist_id, role, position)
             VALUES ('t-dvo', 'ar-dvorak', 'composer', 0)`);

    const listen = db.prepare(
      `INSERT INTO listening_sessions (id, track_id, title, artist_name, started_at, status, qualified, user_id)
       VALUES (?, ?, 'x', 'x', ?, 'ended', 1, ?)`,
    );
    // The admin played Head Hunters three times and Kind of Blue once, long ago;
    // the member played only Bitches Brew.
    listen.run('s1', 't-hh', now - 10, admin.id);
    listen.run('s2', 't-hh', now - 20, admin.id);
    listen.run('s3', 't-hh', now - 30, admin.id);
    listen.run('s4', 't-kob', old, admin.id);
    listen.run('s5', 't-brew', now, member.id);
    db.prepare(
      `INSERT INTO favorites (item_type, item_id, user_id) VALUES ('album', 'al-dvo', ?)`,
    ).run(admin.id);
  });

  afterAll(() => teardown());

  describe('without a query', () => {
    it('is the plain A–Z album list it always was', async () => {
      const res = await request(app).get('/api/library/albums');
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(7);
      expect(ids(res)).toEqual([
        'al-brew',
        'al-hh',
        'al-hh-cd',
        'al-kob',
        'al-rj',
        'al-dvo',
        'al-thrust',
      ]);
      expect(res.body.data[0]).toHaveProperty('hasCover');
    });

    it('keeps the artist and track lists complete', async () => {
      const artists = await request(app).get('/api/library/artists');
      expect(artists.body.meta.total).toBe(5);
      expect(artists.body.data[0]).toHaveProperty('hasImage');
      const tracks = await request(app).get('/api/library/tracks');
      expect(tracks.body.meta.total).toBe(7);
    });
  });

  describe('filters', () => {
    it('ORs values within a facet', async () => {
      const res = await request(app).get('/api/library/albums?genre=Blues&genre=Classical');
      expect(ids(res).sort()).toEqual(['al-dvo', 'al-rj']);
    });

    it('accepts comma lists as well as repeated keys', async () => {
      const res = await request(app).get('/api/library/albums?genre=Blues,Classical');
      expect(res.body.meta.total).toBe(2);
    });

    it('ANDs facets with each other', async () => {
      const res = await request(app).get(
        '/api/library/albums?genre=Jazz&yearFrom=1970&yearTo=1979',
      );
      // The CD edition counts as a 1973 album: original year wins.
      expect(ids(res).sort()).toEqual(['al-brew', 'al-hh', 'al-hh-cd', 'al-thrust']);
    });

    it('answers "hi-res jazz from the seventies I never played"', async () => {
      const res = await request(app).get(
        '/api/library/albums?genre=Jazz&yearFrom=1970&yearTo=1979&quality=hires&unplayed=true',
      );
      expect(ids(res)).toEqual(['al-thrust']);
    });

    it('treats lossy files as neither lossless nor hi-res', async () => {
      const res = await request(app).get('/api/library/albums?quality=lossless&genre=Blues');
      expect(res.body.meta.total).toBe(0);
    });

    it('filters on format, label, composer and recently added', async () => {
      const mp3 = await request(app).get('/api/library/albums?format=MP3');
      expect(ids(mp3)).toEqual(['al-rj']);
      const label = await request(app).get('/api/library/albums?label=Supraphon');
      expect(ids(label)).toEqual(['al-dvo']);
      const composer = await request(app).get('/api/library/albums?composer=ar-dvorak');
      expect(ids(composer)).toEqual(['al-dvo']);
      const recent = await request(app).get('/api/library/albums?addedWithin=30');
      expect(ids(recent).sort()).toEqual(['al-dvo', 'al-thrust']);
    });

    it('hides duplicate editions, keeping the best quality', async () => {
      const res = await request(app).get('/api/library/albums?genre=Jazz&dedupeEditions=true');
      expect(ids(res).sort()).toEqual(['al-brew', 'al-hh', 'al-kob', 'al-thrust']);
      expect(res.body.meta.total).toBe(4);
    });

    it('applies the same language to tracks and artists', async () => {
      const tracks = await request(app).get('/api/library/tracks?composer=ar-dvorak');
      expect(ids(tracks)).toEqual(['t-dvo']);
      const hires = await request(app).get('/api/library/tracks?quality=hires&sort=duration');
      expect(ids(hires)).toEqual(['t-hh', 't-thrust', 't-kob']);
      const artists = await request(app).get('/api/library/artists?genre=Blues');
      expect(ids(artists)).toEqual(['ar-rj']);
    });

    it('ignores what it does not know instead of failing', async () => {
      const res = await request(app).get(
        '/api/library/albums?sort=title;DROP TABLE albums&order=sideways&quality=ultra&bogus=1',
      );
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(7);
    });
  });

  describe('personal filters (V09)', () => {
    it('means "unplayed by me"', async () => {
      const mine = await request(app).get('/api/library/albums?genre=Jazz&unplayed=true');
      expect(ids(mine).sort()).toEqual(['al-brew', 'al-hh-cd', 'al-thrust']);
      const theirs = await request(app)
        .get('/api/library/albums?genre=Jazz&unplayed=true')
        .set('Authorization', `Bearer ${member.token}`);
      expect(ids(theirs).sort()).toEqual(['al-hh', 'al-hh-cd', 'al-kob', 'al-thrust']);
    });

    it('filters on my favourites and on what I played lately', async () => {
      const fav = await request(app).get('/api/library/albums?favorite=true');
      expect(ids(fav)).toEqual(['al-dvo']);
      const theirFav = await request(app)
        .get('/api/library/albums?favorite=true')
        .set('Authorization', `Bearer ${member.token}`);
      expect(theirFav.body.meta.total).toBe(0);
      const lately = await request(app).get('/api/library/albums?playedWithin=30');
      expect(ids(lately)).toEqual(['al-hh']);
    });
  });

  describe('sorting', () => {
    it('sorts by my plays, with never-played albums last', async () => {
      const res = await request(app).get('/api/library/albums?sort=plays');
      expect(ids(res).slice(0, 2)).toEqual(['al-hh', 'al-kob']);
      expect(res.body.data[0].plays).toBe(3);
      expect(res.body.data[6].plays).toBeNull();
    });

    it('sorts by year either way, by date added and by last played', async () => {
      const asc = await request(app).get('/api/library/albums?sort=year');
      expect(ids(asc)[0]).toBe('al-kob');
      const desc = await request(app).get('/api/library/albums?sort=year&order=desc');
      expect(ids(desc)[0]).toBe('al-dvo');
      const added = await request(app).get('/api/library/albums?sort=added');
      expect(ids(added).slice(0, 2).sort()).toEqual(['al-dvo', 'al-thrust']);
      const last = await request(app).get('/api/library/albums?sort=lastPlayed');
      expect(ids(last).slice(0, 2)).toEqual(['al-hh', 'al-kob']);
    });

    it('pages through a sorted, filtered result', async () => {
      const res = await request(app).get('/api/library/albums?genre=Jazz&sort=year&limit=2&page=2');
      expect(ids(res)).toEqual(['al-hh', 'al-hh-cd']);
      expect(res.body.meta.total).toBe(5);
    });
  });

  describe('facets', () => {
    it('counts each value with every filter except its own', async () => {
      const res = await request(app).get(
        '/api/library/albums/facets?genre=Jazz&yearFrom=1970&yearTo=1979',
      );
      expect(res.status).toBe(200);
      const facets = res.body.data;
      expect(facets.total).toBe(4);
      // Ticking Jazz still shows how many Blues albums the seventies hold.
      const genre = Object.fromEntries(
        facets.genre.map((g: { value: string; count: number }) => [g.value, g.count]),
      );
      expect(genre).toEqual({ Jazz: 4, Fusion: 2, Blues: 1 });
      // The decade facet ignores the year range but keeps Jazz.
      const decade = Object.fromEntries(
        facets.decade.map((d: { value: string; count: number }) => [d.value, d.count]),
      );
      expect(decade).toEqual({ '1950': 1, '1970': 4 });
      expect(facets.quality).toEqual([
        { value: 'lossless', count: 4 },
        { value: 'hires', count: 2 },
      ]);
      expect(facets.unplayed).toBe(3);
      expect(facets.format).toEqual([{ value: 'flac', count: 4 }]);
    });

    it('names composers and counts my favourites', async () => {
      const res = await request(app).get('/api/library/albums/facets');
      expect(res.body.data.composer).toEqual([
        { value: 'ar-dvorak', name: 'Antonín Dvořák', count: 1 },
      ]);
      expect(res.body.data.favorite).toBe(1);
      expect(res.body.data.label[0]).toEqual({ value: 'Columbia', count: 6 });
    });
  });

  it('round-trips a query through its URL form', () => {
    const query = parseFocusQuery({
      genre: ['Jazz', 'Blues'],
      yearFrom: '1970',
      quality: 'hires',
      unplayed: 'true',
      sort: 'plays',
    });
    expect(parseFocusQuery(Object.fromEntries(groupParams(serializeFocusQuery(query))))).toEqual(
      query,
    );
  });
});

function groupParams(search: string): Array<[string, string[]]> {
  const map = new Map<string, string[]>();
  for (const [k, v] of new URLSearchParams(search)) map.set(k, [...(map.get(k) ?? []), v]);
  return [...map.entries()];
}

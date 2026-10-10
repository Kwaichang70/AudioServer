import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * The artist page's data (R04.2): a discography split the way a shelf is,
 * "appears on" from the credits of R03, and top tracks that belong to the
 * listener who asks.
 */

describe('Artist page data', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    admin = ctx.admin!;
    member = ctx.member!;

    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar-main', 'The Main Act'), ('ar-other', 'Someone Else');
      INSERT INTO albums (id, title, artist_id, artist_name, year, original_year, is_compilation)
      VALUES
        ('al-lp', 'The Long One', 'ar-main', 'The Main Act', 2001, 1999, 0),
        ('al-ep', 'Short Stuff', 'ar-main', 'The Main Act', 2002, NULL, 0),
        ('al-best', 'Greatest Hits', 'ar-main', 'The Main Act', 2010, NULL, 1),
        ('al-guest', 'Their Record', 'ar-other', 'Someone Else', 2005, NULL, 0);
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration, availability)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // A full album: eight tracks of four minutes.
    for (let i = 1; i <= 8; i += 1) {
      track.run(
        `lp-${i}`,
        `LP ${i}`,
        'al-lp',
        'The Long One',
        'ar-main',
        'The Main Act',
        240,
        'available',
      );
    }
    // An EP: three tracks of four minutes.
    for (let i = 1; i <= 3; i += 1) {
      track.run(
        `ep-${i}`,
        `EP ${i}`,
        'al-ep',
        'Short Stuff',
        'ar-main',
        'The Main Act',
        240,
        'available',
      );
    }
    track.run(
      'best-1',
      'Hit',
      'al-best',
      'Greatest Hits',
      'ar-main',
      'The Main Act',
      200,
      'available',
    );
    // A guest spot on someone else's album, and a track whose file is gone.
    track.run(
      'guest-1',
      'Duet',
      'al-guest',
      'Their Record',
      'ar-other',
      'Someone Else',
      220,
      'available',
    );
    track.run(
      'lp-gone',
      'Lost One',
      'al-lp',
      'The Long One',
      'ar-main',
      'The Main Act',
      240,
      'missing',
    );
    db.exec(`
      INSERT INTO track_artists (track_id, artist_id, role, position)
      SELECT id, artist_id, 'main', 0 FROM tracks;
      INSERT INTO track_artists (track_id, artist_id, role, position)
      VALUES ('guest-1', 'ar-main', 'featured', 0), ('guest-1', 'ar-main', 'producer', 0);
    `);

    // The admin played LP 3 three times, EP 1 once and the lost track five
    // times; the member played EP 2 — that must not show up for the admin.
    const listen = db.prepare(
      `INSERT INTO listening_sessions (id, track_id, title, artist_name, started_at, status, qualified, user_id)
       VALUES (?, ?, 'x', 'The Main Act', ?, 'ended', 1, ?)`,
    );
    let n = 0;
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 3; i += 1) listen.run(`s${n++}`, 'lp-3', now - i, admin.id);
    listen.run(`s${n++}`, 'ep-1', now, admin.id);
    for (let i = 0; i < 5; i += 1) listen.run(`s${n++}`, 'lp-gone', now - i, admin.id);
    listen.run(`s${n++}`, 'ep-2', now, member.id);
  });

  afterAll(() => teardown());

  it('splits the discography into albums, singles & EPs, compilations and appearances', async () => {
    const res = await request(app).get('/api/library/artists/ar-main/discography');
    expect(res.status).toBe(200);
    const { albums, singles, compilations, appearsOn } = res.body.data;
    expect(albums.map((a: { id: string }) => a.id)).toEqual(['al-lp']);
    expect(singles.map((a: { id: string }) => a.id)).toEqual(['al-ep']);
    expect(compilations.map((a: { id: string }) => a.id)).toEqual(['al-best']);
    expect(appearsOn.map((a: { id: string }) => a.id)).toEqual(['al-guest']);
    // The roles they hold on someone else's record.
    expect(appearsOn[0].roles).toEqual(['featured', 'producer']);
    // The original year wins over the reissue year.
    expect(albums[0].year).toBe(1999);
  });

  it('gives a guest a page: "appears on" works for an artist with no album of their own', async () => {
    const db = getRawDb();
    db.prepare("INSERT INTO artists (id, name) VALUES ('ar-guest-only', 'Just A Guest')").run();
    db.prepare(
      "INSERT INTO track_artists (track_id, artist_id, role, position) VALUES ('lp-1', 'ar-guest-only', 'featured', 0)",
    ).run();
    const res = await request(app).get('/api/library/artists/ar-guest-only/discography');
    expect(res.body.data.albums).toEqual([]);
    expect(res.body.data.appearsOn.map((a: { id: string }) => a.id)).toEqual(['al-lp']);
  });

  it("lists the listener's own top tracks, playable ones only", async () => {
    const res = await request(app).get('/api/library/artists/ar-main/top-tracks');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((t: { id: string }) => t.id);
    expect(ids).toEqual(['lp-3', 'ep-1']);
    expect(res.body.data[0].plays).toBe(3);
    // The missing file had the most plays, and is still left out.
    expect(ids).not.toContain('lp-gone');
    // Someone else's listening is not mine.
    expect(ids).not.toContain('ep-2');
  });

  it('gives another listener their own top tracks', async () => {
    const res = await request(app)
      .get('/api/library/artists/ar-main/top-tracks')
      .set('Authorization', `Bearer ${member.token}`);
    expect(res.body.data.map((t: { id: string }) => t.id)).toEqual(['ep-2']);
  });

  it('answers 404 for an unknown artist', async () => {
    expect((await request(app).get('/api/library/artists/nobody/discography')).status).toBe(404);
    expect((await request(app).get('/api/library/artists/nobody/top-tracks')).status).toBe(404);
  });
});

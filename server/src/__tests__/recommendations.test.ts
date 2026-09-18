import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { localMix, matchRecommendation, normalizeName } from '../services/recommendations.js';

/**
 * Recommendations (V12.2).
 *
 * The two rules under test: a recommendation without a certain match never
 * starts a coincidentally same-named track, and the basis of a mix is visible
 * and can be switched off — after which nothing personal is read at all.
 */

function insertTrack(t: {
  id: string;
  title: string;
  artist: string;
  album?: string;
  availability?: string;
}) {
  const db = getRawDb();
  db.prepare('INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)').run(
    `ar-${t.artist}`,
    t.artist,
  );
  db.prepare(
    'INSERT OR IGNORE INTO albums (id, title, artist_id, artist_name) VALUES (?, ?, ?, ?)',
  ).run(`al-${t.album ?? t.artist}`, t.album ?? 'An Album', `ar-${t.artist}`, t.artist);
  db.prepare(
    `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration, availability)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    t.id,
    t.title,
    `al-${t.album ?? t.artist}`,
    t.album ?? 'An Album',
    `ar-${t.artist}`,
    t.artist,
    200,
    t.availability ?? 'available',
  );
}

describe('Matching a recommendation to the library', () => {
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    teardown = ctx.teardown;
    insertTrack({ id: 'exact', title: 'Paranoid Android', artist: 'Radiohead', album: 'OK' });
    insertTrack({ id: 'accent', title: 'Se A Cabo', artist: 'Santana', album: 'Abraxas' });
    insertTrack({ id: 'gone', title: 'Lost File', artist: 'Ghost', availability: 'missing' });
  });

  afterAll(() => teardown());

  it('reduces a name to a comparable form', () => {
    expect(normalizeName('Paranoid Android - 2011 Remaster')).toBe('paranoid android');
    expect(normalizeName('Se Á Cabo (Live)')).toBe('se a cabo');
    expect(normalizeName('Simon & Garfunkel')).toBe('simon and garfunkel');
  });

  it('calls an exact title + artist match certain and playable', () => {
    const match = matchRecommendation('paranoid android', 'RADIOHEAD');
    expect(match?.certainty).toBe('certain');
    expect(match?.playable).toBe(true);
    expect(match?.trackId).toBe('exact');
  });

  it('never plays a match that is only probable', () => {
    const match = matchRecommendation('Paranoid Android (Live)', 'Radiohead');
    expect(match?.certainty).toBe('probable');
    expect(match?.playable).toBe(false);
    expect(match?.note).toMatch(/not started automatically/i);
  });

  it('refuses a same-named track by another artist', () => {
    expect(matchRecommendation('Paranoid Android', 'Some Tribute Band')).toBeNull();
  });

  it('does not offer a track whose file is missing as playable', () => {
    const match = matchRecommendation('Lost File', 'Ghost');
    expect(match?.certainty).toBe('certain');
    expect(match?.playable).toBe(false);
    expect(match?.note).toMatch(/missing/i);
  });
});

describe('A local mix without any external account', () => {
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

    insertTrack({ id: 'old-1', title: 'Deep Cut', artist: 'Known Artist', album: 'Early' });
    insertTrack({ id: 'old-2', title: 'Another Cut', artist: 'Known Artist', album: 'Early' });
    insertTrack({ id: 'fresh', title: 'Played Today', artist: 'Known Artist', album: 'Early' });
    insertTrack({ id: 'broken', title: 'Gone', artist: 'Known Artist', availability: 'missing' });
    insertTrack({ id: 'other', title: 'Unrelated', artist: 'Someone Else', album: 'Other' });

    const now = Math.floor(Date.now() / 1000);
    const listen = getRawDb().prepare(
      `INSERT INTO listening_sessions (id, track_id, title, artist_name, artist_id, album_id,
                                       started_at, listened_ms, status, qualified, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ended', 1, ?)`,
    );
    // The admin listened to this artist; one of its tracks was on yesterday.
    for (let i = 0; i < 4; i += 1) {
      listen.run(
        `ls-${i}`,
        'fresh',
        'Played Today',
        'Known Artist',
        'ar-Known Artist',
        'al-Early',
        now - 86400,
        200000,
        admin.id,
      );
    }
  });

  afterAll(() => teardown());

  it('builds a mix from the listener’s own history and says why', async () => {
    const res = await request(app).get('/api/recommendations/mix?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.meta.personalised).toBe(true);
    expect(res.body.meta.basis).toMatch(/last six months/i);

    const ids = res.body.data.map((i: { id: string }) => i.id);
    expect(ids).toContain('old-1');
    // Heard yesterday, so not a discovery; and a missing file is never in a mix.
    expect(ids).not.toContain('fresh');
    expect(ids).not.toContain('broken');

    const item = res.body.data.find((i: { id: string }) => i.id === 'old-1');
    expect(item.basis).toBe('history');
    expect(item.why).toMatch(/played Known Artist 4 times/i);
  });

  it('reads nothing personal once the basis is switched off', async () => {
    const off = await request(app)
      .patch('/api/recommendations/settings')
      .send({ useHistory: false, useFavorites: false });
    expect(off.status).toBe(200);
    expect(off.body.data).toEqual({ useHistory: false, useFavorites: false });

    const res = await request(app).get('/api/recommendations/mix?limit=10');
    expect(res.body.meta.personalised).toBe(false);
    expect(res.body.meta.basis).toMatch(/not used/i);
    for (const item of res.body.data) {
      expect(item.basis).toBe('library');
      expect(item.why).toMatch(/switched off/i);
    }
    // A track heard yesterday may come back now: nothing personal is consulted.
    expect(res.body.data.every((i: { id: string }) => i.id !== 'broken')).toBe(true);

    await request(app)
      .patch('/api/recommendations/settings')
      .send({ useHistory: true, useFavorites: true });
  });

  it('keeps one listener’s preference and history out of another’s mix', async () => {
    await request(app)
      .patch('/api/recommendations/settings')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ useHistory: false, useFavorites: false });

    const mine = await request(app).get('/api/recommendations/settings');
    expect(mine.body.data.useHistory).toBe(true);

    const theirs = await request(app)
      .get('/api/recommendations/mix?limit=5')
      .set('Authorization', `Bearer ${member.token}`);
    expect(theirs.body.meta.personalised).toBe(false);

    // The member has no listening history of their own, so turning it back on
    // must not hand them the admin's artists as "you played".
    await request(app)
      .patch('/api/recommendations/settings')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ useHistory: true, useFavorites: true });
    const memberMix = localMix(member.id, { limit: 10 });
    expect(memberMix.items.every((i) => i.basis !== 'history')).toBe(true);
  });

  it('rejects a settings body that changes nothing', async () => {
    const res = await request(app).patch('/api/recommendations/settings').send({});
    expect(res.status).toBe(400);
  });
});

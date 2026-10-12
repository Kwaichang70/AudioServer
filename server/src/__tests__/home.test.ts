import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { dailyMix } from '../services/home.js';

/**
 * Home as an overview (R08.2): where you left off (with position), what is
 * new, the genres you play, and a daily mix that needs no external account.
 */

describe('Home', () => {
  let app: Express;
  let teardown: () => void;
  let dbPath: string;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    dbPath = ctx.dbPath;
    admin = ctx.admin!;
    member = ctx.member!;
    const db = getRawDb();
    const now = Math.floor(Date.now() / 1000);
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar-1', 'Bill Evans'), ('ar-2', 'Nick Drake'), ('ar-3', 'Kraftwerk');
      INSERT INTO albums (id, title, artist_id, artist_name, created_at) VALUES
        ('al-1', 'Sunday', 'ar-1', 'Bill Evans', ${now - 1000}),
        ('al-2', 'Pink Moon', 'ar-2', 'Nick Drake', ${now - 500}),
        ('al-3', 'Computerwelt', 'ar-3', 'Kraftwerk', ${now});
      INSERT INTO album_genres (album_id, genre) VALUES ('al-1', 'Jazz'), ('al-2', 'Folk'), ('al-3', 'Electronic');
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, disc_number, track_number, duration, file_path)
       SELECT ?, ?, a.id, a.title, a.artist_id, a.artist_name, 1, ?, 300, '/m/' || ? FROM albums a WHERE a.id = ?`,
    );
    for (const [album, n] of [
      ['al-1', 5],
      ['al-2', 3],
      ['al-3', 4],
    ] as const) {
      for (let i = 1; i <= n; i++)
        track.run(`${album}-t${i}`, `Track ${i}`, i, `${album}-${i}`, album);
    }
    const listen = db.prepare(
      `INSERT INTO listening_sessions (id, track_id, album_id, artist_id, title, artist_name, started_at, listened_ms, duration, status, qualified, user_id)
       VALUES (?, ?, ?, ?, 'x', 'x', ?, ?, 300, 'ended', ?, ?)`,
    );
    // Sunday: stopped two minutes into track 3.
    listen.run('s1', 'al-1-t2', 'al-1', 'ar-1', now - 300, 300_000, 1, admin.id);
    listen.run('s2', 'al-1-t3', 'al-1', 'ar-1', now - 100, 120_000, 0, admin.id);
    // Pink Moon: finished track 1 completely.
    listen.run('s3', 'al-2-t1', 'al-2', 'ar-2', now - 200, 299_000, 1, admin.id);
    // Computerwelt: played to the very end — not "in progress".
    listen.run('s4', 'al-3-t4', 'al-3', 'ar-3', now - 400, 300_000, 1, admin.id);
    for (let i = 0; i < 5; i++)
      listen.run(`j${i}`, 'al-1-t1', 'al-1', 'ar-1', now - 1000 - i, 300_000, 1, admin.id);
  });

  afterAll(() => teardown());

  it('continues where you left off, mid-track or at the next track', async () => {
    const res = await request(app).get('/api/home');
    expect(res.status).toBe(200);
    const items = res.body.data.continueListening;
    expect(items.map((i: { albumId: string }) => i.albumId)).toEqual(['al-1', 'al-2']);
    expect(items[0]).toMatchObject({
      resumeTrackId: 'al-1-t3',
      resumePosition: 120,
      progress: 0.4,
    });
    expect(items[1]).toMatchObject({ resumeTrackId: 'al-2-t2', resumePosition: 0 });
  });

  it('shows what is new in the library, newest first', async () => {
    const res = await request(app).get('/api/home');
    expect(res.body.data.newInLibrary.map((a: { id: string }) => a.id)).toEqual([
      'al-3',
      'al-2',
      'al-1',
    ]);
  });

  it('suggests the genres you play, and the library’s own when you played nothing', async () => {
    const mine = await request(app).get('/api/home');
    expect(mine.body.data.genresForYou[0]).toMatchObject({ genre: 'Jazz', albumIds: ['al-1'] });
    const theirs = await request(app)
      .get('/api/home')
      .set('Authorization', `Bearer ${member.token}`);
    expect(theirs.body.data.genresForYou.every((g: { plays: number }) => g.plays === 0)).toBe(true);
    expect(theirs.body.data.continueListening).toEqual([]);
  });

  it('has a daily mix without any external account, the same all day', async () => {
    const first = (await request(app).get('/api/home')).body.data.dailyMix;
    expect(first.items.length).toBeGreaterThan(0);
    const second = (await request(app).get('/api/home')).body.data.dailyMix;
    expect(second.items.map((i: { id: string }) => i.id)).toEqual(
      first.items.map((i: { id: string }) => i.id),
    );
    // A restart does not reroll it.
    closeDatabase();
    await initDatabase(dbPath);
    const afterRestart = (await request(app).get('/api/home')).body.data.dailyMix;
    expect(afterRestart.items.map((i: { id: string }) => i.id)).toEqual(
      first.items.map((i: { id: string }) => i.id),
    );
  });

  it('makes a new mix the next day, and drops what can no longer play', () => {
    const todays = dailyMix(admin.id);
    const gone = todays.items[0].id;
    getRawDb().prepare("UPDATE tracks SET availability = 'missing' WHERE id = ?").run(gone);
    expect(dailyMix(admin.id).items.map((i) => i.id)).not.toContain(gone);
    const tomorrow = dailyMix(admin.id, '2999-01-01');
    expect(tomorrow.date).toBe('2999-01-01');
  });
});

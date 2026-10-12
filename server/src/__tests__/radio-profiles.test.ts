import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { configureRadio, resetRadio } from '../services/library-radio.js';

/**
 * Profile separation for radio and Home (R08.4, V12.4): your private tags
 * never seed or steer someone else's radio, your daily mix is yours, and
 * what you played does not shape another person's Home.
 */

describe('Radio and Home keep profiles apart', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let member: TestUser;
  const asMember = (r: request.Test) =>
    r.set('Authorization', `Bearer ${member.token}`).set('X-Client-Id', 'member-tab');
  const asAdmin = (r: request.Test) => r.set('X-Client-Id', 'admin-tab');

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    admin = ctx.admin!;
    member = ctx.member!;
    configureRadio({ similarAvailable: () => false });
    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar-a', 'A'), ('ar-b', 'B');
      INSERT INTO albums (id, title, artist_id, artist_name, genre) VALUES
        ('al-a', 'Alpha', 'ar-a', 'A', 'Jazz'), ('al-b', 'Beta', 'ar-b', 'B', 'Jazz');
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, track_number, file_path)
       SELECT ?, ?, a.id, a.title, a.artist_id, a.artist_name, ?, '/m/' || ? FROM albums a WHERE a.id = ?`,
    );
    for (let i = 1; i <= 6; i++) {
      track.run(`a${i}`, `A${i}`, i, `a${i}`, 'al-a');
      track.run(`b${i}`, `B${i}`, i, `b${i}`, 'al-b');
    }
    // The admin's private tag on album Beta.
    db.prepare(
      "INSERT INTO tags (id, user_id, name, shared) VALUES ('tag-private', ?, 'Secret', 0)",
    ).run(admin.id);
    db.exec(
      "INSERT INTO tag_items (tag_id, item_type, item_id) VALUES ('tag-private', 'album', 'al-b')",
    );
    // The admin listened to Alpha a lot.
    const listen = db.prepare(
      `INSERT INTO listening_sessions (id, track_id, album_id, artist_id, title, artist_name, started_at, listened_ms, duration, status, qualified, user_id)
       VALUES (?, ?, 'al-a', 'ar-a', 'x', 'A', ?, 300000, 300, 'ended', 1, ?)`,
    );
    const now = Math.floor(Date.now() / 1000);
    // Always the same track: the mix draws three of A's six tracks and skips
    // what was heard this month, so at least two always remain.
    for (let i = 0; i < 4; i++) listen.run(`s${i}`, 'a1', now - i * 10, admin.id);
  });

  afterAll(() => {
    resetRadio();
    teardown();
  });

  it("does not start a radio from someone else's private tag", async () => {
    const mine = await asAdmin(request(app).post('/api/playback/radio/start')).send({
      seed: { type: 'tag', id: 'tag-private' },
    });
    expect(mine.status).toBe(200);
    expect(
      mine.body.data.tracks.every((t: { why: string }) => /tag Secret|genre Jazz/i.test(t.why)),
    ).toBe(true);
    const theirs = await asMember(request(app).post('/api/playback/radio/start')).send({
      seed: { type: 'tag', id: 'tag-private' },
    });
    expect(theirs.status).toBe(404);
  });

  it("never names someone else's private tag as a reason", async () => {
    const res = await asMember(request(app).post('/api/playback/radio/start')).send({
      seed: { type: 'album', id: 'al-b' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.tracks.some((t: { why: string }) => t.why.includes('Secret'))).toBe(false);
  });

  it('keeps Home and the daily mix per person', async () => {
    const mine = (await request(app).get('/api/home')).body.data;
    const theirs = (
      await request(app).get('/api/home').set('Authorization', `Bearer ${member.token}`)
    ).body.data;
    expect(mine.continueListening.map((c: { albumId: string }) => c.albumId)).toEqual(['al-a']);
    expect(theirs.continueListening).toEqual([]);
    const stored = getRawDb()
      .prepare("SELECT user_id FROM user_preferences WHERE key = 'home.dailyMix' ORDER BY user_id")
      .all() as Array<{ user_id: string }>;
    expect(stored.map((r) => r.user_id).sort()).toEqual([admin.id, member.id].sort());
    // The admin's mix is built from their history, the member's is not.
    const fromHistory = (mix: { items: Array<{ basis: string }> }) =>
      mix.items.some((i) => i.basis === 'history');
    expect(fromHistory(mine.dailyMix)).toBe(true);
    expect(fromHistory(theirs.dailyMix)).toBe(false);
  });
});

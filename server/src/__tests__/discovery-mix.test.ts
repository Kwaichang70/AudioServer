import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * Saving and playing a discovery mix (V12.4).
 *
 * A mix is generated per request, so it only becomes something a listener can
 * come back to once it is a playlist. What this suite checks is what happens
 * afterwards: a source that falls away, and two accounts on one server.
 */

function seed() {
  const db = getRawDb();
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('ar', 'Mix Artist');
  db.prepare('INSERT INTO albums (id, title, artist_id, artist_name) VALUES (?, ?, ?, ?)').run(
    'al',
    'Mix Album',
    'ar',
    'Mix Artist',
  );
  const insert = db.prepare(
    `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration, file_path)
     VALUES (?, ?, 'al', 'Mix Album', 'ar', 'Mix Artist', 180, ?)`,
  );
  insert.run('mix-1', 'One', '//nas/Music/one.flac');
  insert.run('mix-2', 'Two', '//nas/Music/two.flac');
  insert.run('mix-3', 'Three', '//nas/Music/three.flac');
}

describe('Saving a mix', () => {
  let app: Express;
  let teardown: () => void;
  let member: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    member = ctx.member!;
    seed();
  });

  afterAll(() => teardown());

  it('turns the mix into an ordinary playlist with a snapshot per item', async () => {
    const res = await request(app)
      .post('/api/recommendations/mix/save')
      .send({ name: 'Saturday mix', trackIds: ['mix-1', 'mix-2'] });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Saturday mix');
    expect(res.body.meta.saved).toBe(2);

    const items = await request(app).get(`/api/playlists/${res.body.data.id}/tracks`);
    expect(items.body.data.map((i: { id: string }) => i.id)).toEqual(['mix-1', 'mix-2']);
    expect(items.body.data[0].availability).toBe('available');

    const row = getRawDb()
      .prepare('SELECT track_title FROM playlist_tracks WHERE track_id = ?')
      .get('mix-1') as { track_title: string };
    expect(row.track_title).toBe('One');
  });

  it('saves a freshly generated mix when no tracks are sent', async () => {
    const res = await request(app).post('/api/recommendations/mix/save').send({ limit: 3 });
    expect(res.status).toBe(201);
    expect(res.body.meta.saved).toBeGreaterThan(0);
    expect(res.body.data.name).toMatch(/^Mix of \d{4}-\d{2}-\d{2}$/);
  });

  it('can be played: the saved items go into the queue as they are', async () => {
    const created = await request(app)
      .post('/api/recommendations/mix/save')
      .send({ name: 'To play', trackIds: ['mix-1', 'mix-3'] });
    const items = await request(app).get(`/api/playlists/${created.body.data.id}/tracks`);

    const res = await request(app)
      .post('/api/playback/queue/set')
      .set('X-Client-Id', 'mix-test')
      .send({
        tracks: items.body.data.map((i: Record<string, unknown>) => ({
          id: i.id,
          title: i.title,
          artistName: i.artistName,
          albumTitle: i.albumTitle,
          duration: i.duration,
        })),
        startIndex: 0,
        deviceId: 'browser',
        shuffle: false,
        repeat: 'off',
      });
    expect(res.status).toBe(200);
    expect(res.body.data.queue.map((q: { trackId: string }) => q.trackId)).toEqual([
      'mix-1',
      'mix-3',
    ]);
  });

  it('keeps a saved mix readable when a source falls away', async () => {
    const created = await request(app)
      .post('/api/recommendations/mix/save')
      .send({ name: 'Outage', trackIds: ['mix-1', 'mix-2'] });
    const id = created.body.data.id;
    // A Qobuz track added by hand; nobody is connected in this test server.
    await request(app).post(`/api/playlists/${id}/tracks`).send({
      trackId: 'qobuz:777',
      title: 'Remote Extra',
      artistName: 'Remote Artist',
    });
    getRawDb().prepare("UPDATE tracks SET availability = 'missing' WHERE id = ?").run('mix-2');

    const items = await request(app).get(`/api/playlists/${id}/tracks`);
    expect(items.body.data).toHaveLength(3);
    expect(items.body.meta.playable).toBe(1);
    const byId = Object.fromEntries(
      items.body.data.map((i: { id: string }) => [i.id, i as Record<string, unknown>]),
    );
    expect(byId['mix-2'].availability).toBe('missing');
    expect(byId['mix-2'].title).toBe('Two');
    expect(byId['qobuz:777'].availability).toBe('unavailable');
    expect(String(byId['qobuz:777'].unavailableReason)).toMatch(/qobuz/i);
    expect(byId['qobuz:777'].title).toBe('Remote Extra');

    getRawDb().prepare("UPDATE tracks SET availability = 'available' WHERE id = ?").run('mix-2');
  });

  it('keeps one listener’s saved mix out of another’s library', async () => {
    const mine = await request(app)
      .post('/api/recommendations/mix/save')
      .send({ name: 'Private mix', trackIds: ['mix-1'] });

    const theirList = await request(app)
      .get('/api/playlists')
      .set('Authorization', `Bearer ${member.token}`);
    expect(theirList.body.data.some((p: { id: string }) => p.id === mine.body.data.id)).toBe(false);

    const theirRead = await request(app)
      .get(`/api/playlists/${mine.body.data.id}/tracks`)
      .set('Authorization', `Bearer ${member.token}`);
    // A guessed id answers 404, the same as one that does not exist.
    expect(theirRead.status).toBe(404);
  });

  it('refuses to save nothing rather than leaving an empty playlist behind', async () => {
    const ctx = await createTestApp();
    const res = await request(ctx.app).post('/api/recommendations/mix/save').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('EmptyMix');
    const count = getRawDb().prepare('SELECT COUNT(*) as c FROM playlists').get();
    expect(count).toEqual({ c: 0 });
    ctx.teardown();
  });
});

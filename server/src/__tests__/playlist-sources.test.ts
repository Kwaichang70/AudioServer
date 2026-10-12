import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';

/**
 * Playlists with a stable source reference (R07.3): local and Qobuz in one
 * list, each item naming its source, and the same list after a restart.
 */

describe('Playlists across sources', () => {
  let app: Express;
  let teardown: () => void;
  let dbPath: string;
  let playlistId: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    dbPath = ctx.dbPath;
    getRawDb().exec(`
      INSERT INTO artists (id, name) VALUES ('ar', 'Bill Evans');
      INSERT INTO albums (id, title, artist_id, artist_name) VALUES ('al', 'Sunday', 'ar', 'Bill Evans');
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path, duration)
        VALUES ('t-local', 'Gloria''s Step', 'al', 'Sunday', 'ar', 'Bill Evans', '/music/g.flac', 360);
      -- A Qobuz album in the library (R07.1), one title of it withdrawn (R07.2).
      INSERT INTO albums (id, title, artist_id, artist_name, source, source_ref, cover_url)
        VALUES ('qobuz:42', 'Kind of Blue', 'ar', 'Miles Davis', 'qobuz', 'qobuz:album:42', 'https://static.qobuz.com/42.jpg');
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, source, availability, source_ref, duration, cover_url)
        VALUES ('qobuz:1', 'So What', 'qobuz:42', 'Kind of Blue', 'ar', 'Miles Davis', 'qobuz', 'streaming', 'qobuz:track:1', 545, 'https://static.qobuz.com/42.jpg'),
               ('qobuz:2', 'Blue in Green', 'qobuz:42', 'Kind of Blue', 'ar', 'Miles Davis', 'qobuz', 'unavailable', 'qobuz:track:2', 337, NULL);
    `);
    playlistId = (await request(app).post('/api/playlists').send({ name: 'Mixed' })).body.data.id;
  });

  afterAll(() => teardown());

  const items = async () =>
    (await request(app).get(`/api/playlists/${playlistId}/tracks`)).body.data as Array<
      Record<string, unknown>
    >;

  it('adds a local file, a Qobuz title from the library by id alone, and one from outside it', async () => {
    const add = (body: object) =>
      request(app).post(`/api/playlists/${playlistId}/tracks`).send(body);
    expect((await add({ trackId: 't-local' })).status).toBe(200);
    // In the library: no title needed, the library describes it.
    expect((await add({ trackId: 'qobuz:1' })).status).toBe(200);
    expect((await add({ trackId: 'qobuz:2' })).status).toBe(200);
    // Not in the library: the client brings the snapshot (V12.1).
    expect(
      (await add({ trackId: 'qobuz:99', title: 'Flamenco Sketches', artistName: 'Miles Davis' }))
        .status,
    ).toBe(200);

    const list = await items();
    expect(list.map((i) => [i.id, i.sourceRef, i.title])).toEqual([
      ['t-local', 'local:track:t-local', "Gloria's Step"],
      ['qobuz:1', 'qobuz:track:1', 'So What'],
      ['qobuz:2', 'qobuz:track:2', 'Blue in Green'],
      ['qobuz:99', 'qobuz:track:99', 'Flamenco Sketches'],
    ]);
  });

  it('says when Qobuz withdrew a title in the list', async () => {
    const withdrawn = (await items()).find((i) => i.id === 'qobuz:2')!;
    expect(withdrawn.availability).toBe('unavailable');
    expect(withdrawn.unavailableReason).toMatch(/no longer streams/);
  });

  it('is the same list after a restart, and old rows get a source reference', async () => {
    const before = await items();
    getRawDb().exec('UPDATE playlist_tracks SET source_ref = NULL');
    closeDatabase();
    await initDatabase(dbPath);
    const after = await items();
    expect(after).toEqual(before);
  });

  it('exports external items as marked comments in M3U', async () => {
    const res = await request(app)
      .get(`/api/playlists/${playlistId}/export`)
      .buffer(true)
      .parse((r, done) => {
        let body = '';
        r.on('data', (chunk: Buffer) => (body += chunk.toString()));
        r.on('end', () => done(null, body));
      });
    expect(res.body).toContain('/music/g.flac');
    expect(res.body).toMatch(/#.*qobuz:99/);
  });
});

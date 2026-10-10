import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { configureAlbumVersions } from '../services/album-versions.js';

/**
 * The album page's data (R04.3): credits by role, and the other versions of
 * an album — local editions and Qobuz alternatives with their quality.
 */

describe('Album page data', () => {
  let app: Express;
  let teardown: () => void;
  let qobuzResults: Array<Record<string, unknown>> = [];
  let qobuzReady = true;
  let qobuzDelay = 0;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;

    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES
        ('ar-orch', 'The Orchestra'), ('ar-mahler', 'Gustav Mahler'),
        ('ar-abbado', 'Claudio Abbado'), ('ar-solo', 'A Soloist'), ('ar-va', 'Various Artists'),
        ('ar-1', 'Artist One'), ('ar-2', 'Artist Two');
      INSERT INTO albums (id, title, artist_id, artist_name, edition_key, format, sample_rate, bit_depth, release_group_mbid, track_count, is_compilation)
      VALUES
        ('al-flac', 'Symphony No. 5', 'ar-orch', 'The Orchestra', '/m/s5|flac|44100|16', 'flac', 44100, 16, NULL, 2, 0),
        ('al-mp3', 'Symphony No. 5', 'ar-orch', 'The Orchestra', '/m/s5|mp3|44100|', 'mp3', 44100, NULL, NULL, 2, 0),
        ('al-remaster', 'Symphony No. 5 (Remaster)', 'ar-orch', 'The Orchestra', '/m/s5r|flac|96000|24', 'flac', 96000, 24, 'rg-s5', 2, 0),
        ('al-ident', 'Symphony 5', 'ar-orch', 'The Orchestra', '/m/s5i|flac|44100|16', 'flac', 44100, 16, 'rg-s5', 2, 0),
        ('al-comp', 'Hits', 'ar-va', 'Various Artists', '/m/hits|mp3||', 'mp3', 44100, NULL, NULL, 2, 1),
        ('al-other', 'Something Else', 'ar-orch', 'The Orchestra', '/m/x|flac||', 'flac', 44100, 16, NULL, 1, 0);
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration, work)
       VALUES (?, ?, ?, ?, ?, ?, 300, ?)`,
    );
    track.run(
      't-1',
      'I. Trauermarsch',
      'al-flac',
      'Symphony No. 5',
      'ar-orch',
      'The Orchestra',
      'Symphony No. 5',
    );
    track.run(
      't-2',
      'IV. Adagietto',
      'al-flac',
      'Symphony No. 5',
      'ar-orch',
      'The Orchestra',
      'Symphony No. 5',
    );
    track.run('c-1', 'Song One', 'al-comp', 'Hits', 'ar-va', 'Various Artists', null);
    track.run('c-2', 'Song Two', 'al-comp', 'Hits', 'ar-va', 'Various Artists', null);
    db.exec(`
      INSERT INTO track_artists (track_id, artist_id, role, position) VALUES
        ('t-1', 'ar-orch', 'main', 0), ('t-2', 'ar-orch', 'main', 0),
        ('t-1', 'ar-mahler', 'composer', 0), ('t-2', 'ar-mahler', 'composer', 0),
        ('t-1', 'ar-abbado', 'conductor', 0), ('t-2', 'ar-abbado', 'conductor', 0),
        ('t-2', 'ar-solo', 'performer', 0),
        ('c-1', 'ar-1', 'main', 0), ('c-2', 'ar-2', 'main', 0);
    `);
  });

  afterAll(() => teardown());

  beforeEach(() => {
    qobuzReady = true;
    qobuzDelay = 0;
    qobuzResults = [];
    configureAlbumVersions({
      qobuzReady: async () => qobuzReady,
      timeoutMs: 50,
      searchQobuz: async () => {
        if (qobuzDelay) await new Promise((r) => setTimeout(r, qobuzDelay));
        return qobuzResults as never;
      },
    });
  });

  it('lists the credits by role, without repeating the album artist', async () => {
    const res = await request(app).get('/api/library/albums/al-flac/credits');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { role: 'composer', people: [{ artistId: 'ar-mahler', name: 'Gustav Mahler', tracks: 2 }] },
      { role: 'conductor', people: [{ artistId: 'ar-abbado', name: 'Claudio Abbado', tracks: 2 }] },
      { role: 'performer', people: [{ artistId: 'ar-solo', name: 'A Soloist', tracks: 1 }] },
    ]);
  });

  it('lists the main artists of a compilation, because there they are the information', async () => {
    const res = await request(app).get('/api/library/albums/al-comp/credits');
    expect(res.body.data).toEqual([
      {
        role: 'main',
        people: [
          { artistId: 'ar-1', name: 'Artist One', tracks: 1 },
          { artistId: 'ar-2', name: 'Artist Two', tracks: 1 },
        ],
      },
    ]);
  });

  it('finds the MP3 beside the FLAC as another version', async () => {
    const res = await request(app).get('/api/library/albums/al-flac/versions?streaming=false');
    expect(res.status).toBe(200);
    const ids = res.body.data.local.map((v: { id: string }) => v.id);
    expect(ids).toEqual(['al-mp3']);
    expect(res.body.data.local[0].matchedBy).toBe('title');
    // A different title from the same artist is not a version.
    expect(ids).not.toContain('al-other');
  });

  it('finds versions by release group even when the titles differ', async () => {
    const res = await request(app).get('/api/library/albums/al-ident/versions?streaming=false');
    const local = res.body.data.local;
    expect(local.map((v: { id: string }) => v.id)).toEqual(['al-remaster']);
    expect(local[0].matchedBy).toBe('release-group');
  });

  it('offers the Qobuz album, and says when it beats the local resolution', async () => {
    qobuzResults = [
      {
        id: 'qobuz:111',
        title: 'Symphony No. 5',
        artistName: 'The Orchestra',
        sampleRate: 96000,
        bitDepth: 24,
        trackCount: 2,
      },
      {
        id: 'qobuz:222',
        title: 'Symphony No. 5',
        artistName: 'A Tribute Orchestra',
        sampleRate: 192000,
        bitDepth: 24,
      },
    ];
    const res = await request(app).get('/api/library/albums/al-flac/versions');
    expect(res.body.data.sources.qobuz).toBe('ok');
    // Same title by another artist is not this album.
    expect(res.body.data.streaming.map((v: { id: string }) => v.id)).toEqual(['qobuz:111']);
    expect(res.body.data.streaming[0].higherResolution).toBe(true);
  });

  it('says Qobuz was not asked, rather than "no versions", when it is not connected', async () => {
    qobuzReady = false;
    const res = await request(app).get('/api/library/albums/al-flac/versions');
    expect(res.body.data.sources.qobuz).toBe('unavailable');
    expect(res.body.data.streaming).toEqual([]);
  });

  it('reports a slow Qobuz as a timeout instead of waiting for it', async () => {
    qobuzDelay = 500;
    const res = await request(app).get('/api/library/albums/al-flac/versions');
    expect(res.body.data.sources.qobuz).toBe('timeout');
    // The local editions still arrive.
    expect(res.body.data.local.map((v: { id: string }) => v.id)).toEqual(['al-mp3']);
  });

  it('answers 404 for an unknown album', async () => {
    expect((await request(app).get('/api/library/albums/nope/credits')).status).toBe(404);
    expect((await request(app).get('/api/library/albums/nope/versions')).status).toBe(404);
  });
});

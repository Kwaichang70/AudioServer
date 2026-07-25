import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { dirname } from 'path';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

describe('Route response contracts', () => {
  let app: Express;
  let teardown: () => void;
  let dbPath: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    dbPath = ctx.dbPath;

    const db = getRawDb();
    db.prepare(
      "INSERT INTO artists (id, name, source) VALUES ('artist-contract', 'Contract Artist', 'local')",
    ).run();
    db.prepare(
      `INSERT INTO albums (
        id, title, artist_id, artist_name, year, cover_url, genre, is_compilation,
        track_count, replay_gain_album, replay_gain_album_peak, dir_path, edition_key,
        format, sample_rate, bit_depth, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'album-contract',
      'Contract Album',
      'artist-contract',
      'Contract Artist',
      2024,
      'https://covers.test/contract.jpg',
      'Contract Jazz',
      1,
      2,
      -6.5,
      0.91,
      '//nas/music/contract',
      'contract-edition',
      'flac',
      96_000,
      24,
      'local',
      1_700_000_000,
    );
    db.prepare(
      `INSERT INTO tracks (
        id, title, album_id, album_title, artist_id, artist_name, artist_names,
        composer, conductor, track_number, disc_number, duration, format,
        sample_rate, bit_depth, file_path, cover_url, replay_gain_track,
        replay_gain_track_peak, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'track-contract',
      'Contract Track',
      'album-contract',
      'Contract Album',
      'artist-contract',
      'Contract Artist',
      'Contract Artist; Guest',
      'Contract Composer',
      'Contract Conductor',
      1,
      1,
      245,
      'flac',
      96_000,
      24,
      '//nas/music/contract/track.flac',
      'https://covers.test/track.jpg',
      -5.25,
      0.88,
      'local',
      1_700_000_000,
      1_700_000_100,
    );
    db.prepare(
      `INSERT INTO tracks (
        id, title, album_id, album_title, artist_id, artist_name, track_number,
        duration, file_path, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'track-unreadable',
      'Unreadable Track',
      'album-contract',
      'Contract Album',
      'artist-contract',
      'Contract Artist',
      2,
      60,
      dirname(dbPath),
      'local',
    );
    db.prepare(
      `INSERT INTO play_history (track_id, album_id, artist_id, played_at)
       VALUES (?, ?, ?, ?)`,
    ).run('track-contract', 'album-contract', 'artist-contract', 1_700_000_000);
  });

  afterAll(() => {
    teardown();
  });

  it.each([
    ['/api/library/albums/recent?limit=10', false],
    ['/api/library/genres/Contract%20Jazz/albums?page=1&limit=10', true],
  ])('returns complete camelCase albums from %s', async (url, paginated) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: 'album-contract',
      artistId: 'artist-contract',
      artistName: 'Contract Artist',
      coverUrl: 'https://covers.test/contract.jpg',
      isCompilation: true,
      trackCount: 2,
      replayGainAlbum: -6.5,
      replayGainAlbumPeak: 0.91,
      dirPath: '//nas/music/contract',
      editionKey: 'contract-edition',
      format: 'flac',
      sampleRate: 96_000,
      bitDepth: 24,
      source: 'local',
      hasCover: true,
    });
    expect(res.body.data[0]).not.toHaveProperty('artist_id');
    expect(res.body.data[0]).not.toHaveProperty('replay_gain_album');
    if (paginated) {
      expect(res.body.meta).toEqual({ page: 1, limit: 10, total: 1, totalPages: 1 });
    }
  });

  it('serializes played_at as an ISO-8601 timestamp', async () => {
    const res = await request(app).get('/api/history/tracks');

    expect(res.status).toBe(200);
    expect(res.body.data[0].played_at).toBe('2023-11-14T22:13:20.000Z');
    expect(new Date(res.body.data[0].played_at).toISOString()).toBe(res.body.data[0].played_at);
  });

  it('accepts legacy JSON-string rules and returns complete smart-playlist tracks', async () => {
    const created = await request(app)
      .post('/api/smart-playlists')
      .send({
        name: 'Legacy contract playlist',
        rules: JSON.stringify([{ field: 'genre', operator: 'equals', value: 'Contract Jazz' }]),
      });

    expect(created.status).toBe(201);
    expect(JSON.parse(created.body.data.rules)).toEqual([
      { field: 'genre', operator: 'equals', value: 'Contract Jazz' },
    ]);

    const tracks = await request(app).get(`/api/smart-playlists/${created.body.data.id}/tracks`);
    expect(tracks.status).toBe(200);
    expect(tracks.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'track-contract',
          albumId: 'album-contract',
          artistId: 'artist-contract',
          artistName: 'Contract Artist',
          artistNames: 'Contract Artist; Guest',
          composer: 'Contract Composer',
          conductor: 'Contract Conductor',
          trackNumber: 1,
          discNumber: 1,
          replayGainTrack: -5.25,
          replayGainTrackPeak: 0.88,
          replayGainAlbum: -6.5,
          replayGainAlbumPeak: 0.91,
          source: 'local',
        }),
      ]),
    );
  });

  it('returns 400 for malformed legacy rule JSON', async () => {
    const res = await request(app)
      .post('/api/smart-playlists')
      .send({ name: 'Malformed rules', rules: '[not-json' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('returns 400 for invalid rule semantics on update', async () => {
    const created = await request(app)
      .post('/api/smart-playlists')
      .send({
        name: 'Update validation',
        rules: [{ field: 'genre', operator: 'equals', value: 'Contract Jazz' }],
      });

    const res = await request(app)
      .patch(`/api/smart-playlists/${created.body.data.id}`)
      .send({ rules: [{ field: 'bitDepth', operator: 'contains', value: 'not-a-number' }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ where: 'body', path: 'rules.0.operator' }),
        expect.objectContaining({ where: 'body', path: 'rules.0.value' }),
      ]),
    );
  });

  it('returns a controlled 500 when a track ReadStream fails', async () => {
    const res = await request(app).get('/api/library/tracks/track-unreadable/stream');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to read track file' });
  });
});

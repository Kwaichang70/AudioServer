import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Album, Track } from '@audioserver/shared';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { configureAlbumVersions } from '../services/album-versions.js';
import { getRawDb } from '../db/index.js';
import { configureQobuzLibrary, resetQobuzLibrary } from '../services/qobuz-library.js';
import { scanLibrary } from '../services/scanner.js';
import { QobuzProviderError } from '../providers/qobuz.js';

/**
 * Qobuz in the collection (R07.1): an added album is ordinary library rows
 * with a provider reference, and a forced rescan does not touch it.
 */

const album = (id: string, title: string, streamable = true) =>
  ({
    id: `qobuz:${id}`,
    title,
    artistId: 'qobuz:900',
    artistName: 'Miles Davis',
    year: 1959,
    coverUrl: `https://static.qobuz.com/${id}.jpg`,
    genre: 'Jazz',
    sampleRate: 96000,
    bitDepth: 24,
    label: 'Columbia',
    streamable,
    source: 'qobuz',
  }) as Album & { label?: string; streamable: boolean };

const track = (id: string, n: number, albumId: string, streamable = true) =>
  ({
    id: `qobuz:${id}`,
    title: `Track ${n}`,
    albumId: `qobuz:${albumId}`,
    albumTitle: 'Kind of Blue',
    artistId: 'qobuz:900',
    artistName: 'Miles Davis',
    trackNumber: n,
    discNumber: 1,
    duration: 300 + n,
    sampleRate: 96000,
    bitDepth: 24,
    streamable,
    source: 'qobuz',
  }) as Track & { streamable: boolean };

describe('Qobuz in the library', () => {
  let app: Express;
  let teardown: () => void;
  let tmp: string;
  let member: TestUser;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    member = ctx.member!;
    tmp = mkdtempSync(join(tmpdir(), 'qobuz-lib-'));
    // A local artist of the same name: a Qobuz album must join them, not split them.
    getRawDb().exec(`INSERT INTO artists (id, name) VALUES ('ar-local', 'Miles Davis')`);
    configureQobuzLibrary({
      fetchAlbum: async (id) => {
        const bare = id.replace('qobuz:', '');
        if (bare === '404') throw new QobuzProviderError('qobuz_stream_unavailable', 'gone', 404);
        if (bare === '13') return { album: album('13', 'Withdrawn', false), tracks: [] };
        return {
          album: album(bare, 'Kind of Blue'),
          tracks: [track('1', 1, bare), track('2', 2, bare), track('3', 3, bare, false)],
        };
      },
      fetchTrack: async (id) => ({
        ...track(id.replace('qobuz:', ''), 5, '77'),
        album: album('77', 'Sketches of Spain'),
      }),
    });
  });

  afterEach(() => undefined);
  afterAll(() => {
    resetQobuzLibrary();
    rmSync(tmp, { recursive: true, force: true });
    teardown();
  });

  it('adds an album as library rows with a provider reference', async () => {
    const res = await request(app).post('/api/library/qobuz/albums/42');
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      albumId: 'qobuz:42',
      title: 'Kind of Blue',
      artistName: 'Miles Davis',
      trackCount: 3,
      // Not signed in to Qobuz in this test: the favourite follows at the next sync.
      qobuzFavorite: 'pending',
    });
    const db = getRawDb();
    expect(
      db
        .prepare('SELECT source, source_ref, artist_id, label, cover_url FROM albums WHERE id = ?')
        .get('qobuz:42'),
    ).toEqual({
      source: 'qobuz',
      source_ref: 'qobuz:album:42',
      artist_id: 'ar-local',
      label: 'Columbia',
      cover_url: 'https://static.qobuz.com/42.jpg',
    });
    const rows = db
      .prepare(
        "SELECT id, availability, source_ref, file_path FROM tracks WHERE album_id = 'qobuz:42' ORDER BY track_number",
      )
      .all();
    expect(rows).toEqual([
      { id: 'qobuz:1', availability: 'streaming', source_ref: 'qobuz:track:1', file_path: null },
      { id: 'qobuz:2', availability: 'streaming', source_ref: 'qobuz:track:2', file_path: null },
      // Qobuz no longer streams this one: listed, dimmed, not played.
      { id: 'qobuz:3', availability: 'unavailable', source_ref: 'qobuz:track:3', file_path: null },
    ]);
  });

  it('shows it among your albums, in Focus and under the artist', async () => {
    const albums = await request(app).get('/api/library/albums');
    expect(albums.body.data.map((a: { id: string }) => a.id)).toContain('qobuz:42');
    const qobuzOnly = await request(app).get('/api/library/albums?source=qobuz');
    expect(qobuzOnly.body.data.map((a: { id: string }) => a.id)).toEqual(['qobuz:42']);
    const page = await request(app).get('/api/library/albums/qobuz:42');
    expect(page.status).toBe(200);
    const cover = await request(app).get('/api/library/albums/qobuz:42/cover');
    expect(cover.status).toBe(302);
    expect(cover.headers.location).toBe('https://static.qobuz.com/42.jpg');
  });

  it('adds again without copies, refreshing the snapshot', async () => {
    await request(app).post('/api/library/qobuz/albums/qobuz:42');
    const n = getRawDb()
      .prepare("SELECT COUNT(*) as n FROM tracks WHERE album_id = 'qobuz:42'")
      .get() as { n: number };
    expect(n.n).toBe(3);
  });

  it('adds a single track with an album row holding only that track', async () => {
    const res = await request(app).post('/api/library/qobuz/tracks/555');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ albumId: 'qobuz:77', trackCount: 1 });
  });

  it('refuses a withdrawn album and reports a Qobuz error', async () => {
    expect((await request(app).post('/api/library/qobuz/albums/13')).status).toBe(409);
    expect((await request(app).post('/api/library/qobuz/albums/404')).status).toBe(404);
    expect((await request(app).post('/api/library/qobuz/albums/not-a-number')).status).toBe(400);
  });

  it('survives a forced rescan untouched', async () => {
    const root = join(tmp, 'music');
    mkdirSync(root, { recursive: true });
    await scanLibrary([root], { trigger: 'test', force: true });
    const db = getRawDb();
    expect(db.prepare("SELECT COUNT(*) as n FROM albums WHERE source = 'qobuz'").get()).toEqual({
      n: 2,
    });
    expect(db.prepare("SELECT availability FROM tracks WHERE id = 'qobuz:1'").get()).toEqual({
      availability: 'streaming',
    });
  });

  it('removes a Qobuz album with its personal marks, but never a local album', async () => {
    getRawDb().exec(`
      INSERT INTO albums (id, title, artist_id, artist_name) VALUES ('al-file', 'On disk', 'ar-local', 'Miles Davis');
    `);
    await request(app)
      .post('/api/history/favorites')
      .send({ itemType: 'album', itemId: 'qobuz:77' });
    expect(
      (await request(app).get('/api/library/qobuz/in-library?ids=77,42,999')).body.data.sort(),
    ).toEqual(['qobuz:42', 'qobuz:77']);

    expect((await request(app).delete('/api/library/albums/al-file')).status).toBe(404);
    expect((await request(app).delete('/api/library/albums/qobuz:77')).status).toBe(200);
    const db = getRawDb();
    expect(
      db.prepare("SELECT COUNT(*) as n FROM tracks WHERE album_id = 'qobuz:77'").get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT COUNT(*) as n FROM favorites WHERE item_id = 'qobuz:77'").get(),
    ).toEqual({ n: 0 });
    // The local artist stays even though a Qobuz album of theirs went.
    expect(db.prepare("SELECT id FROM artists WHERE id = 'ar-local'").get()).toBeTruthy();
  });

  describe('one library (R07.4)', () => {
    beforeAll(async () => {
      await request(app).post('/api/library/qobuz/albums/42');
      getRawDb().exec(`
        INSERT INTO albums (id, title, artist_id, artist_name, format, bit_depth, sample_rate, edition_key)
        VALUES ('al-cd', 'Kind of Blue', 'ar-local', 'Miles Davis', 'flac', 16, 44100, 'cd');
        INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path)
        VALUES ('t-cd', 'So What', 'al-cd', 'Kind of Blue', 'ar-local', 'Miles Davis', '/m/so-what.flac');
      `);
    });

    it('filters every list by source: local, Qobuz, or both', async () => {
      const ids = async (q: string) =>
        (await request(app).get(`/api/library/albums?${q}`)).body.data.map(
          (a: { id: string }) => a.id,
        );
      expect(await ids('source=local')).not.toContain('qobuz:42');
      expect(await ids('source=qobuz')).toEqual(['qobuz:42']);
      expect(await ids('source=local&source=qobuz')).toEqual(
        expect.arrayContaining(['qobuz:42', 'al-cd']),
      );
      const facets = await request(app).get('/api/library/albums/facets');
      const sources = Object.fromEntries(
        facets.body.data.source.map((f: { value: string; count: number }) => [f.value, f.count]),
      );
      expect(sources.qobuz).toBe(1);
      const tracks = await request(app).get('/api/library/tracks?source=qobuz');
      expect(tracks.body.data.every((t: { source: string }) => t.source === 'qobuz')).toBe(true);
    });

    it('shows local and Qobuz albums together on the artist page, each with its source', async () => {
      const res = await request(app).get('/api/library/artists/ar-local/discography');
      const all = [
        ...res.body.data.albums,
        ...res.body.data.singles,
        ...res.body.data.compilations,
      ];
      expect(all.map((a: { id: string; source: string }) => [a.id, a.source])).toEqual(
        expect.arrayContaining([
          ['al-cd', 'local'],
          ['qobuz:42', 'qobuz'],
        ]),
      );
    });

    it('lists an added Qobuz edition under Versions, and not again as a Qobuz suggestion', async () => {
      configureAlbumVersions({
        qobuzReady: async () => true,
        searchQobuz: async () => [
          {
            id: 'qobuz:42',
            title: 'Kind of Blue',
            artistName: 'Miles Davis',
            bitDepth: 24,
            sampleRate: 96000,
          },
          {
            id: 'qobuz:43',
            title: 'Kind of Blue',
            artistName: 'Miles Davis',
            bitDepth: 24,
            sampleRate: 192000,
          },
        ],
      });
      const res = await request(app).get('/api/library/albums/al-cd/versions');
      expect(
        res.body.data.local.map((v: { id: string; source: string }) => [v.id, v.source]),
      ).toEqual([['qobuz:42', 'qobuz']]);
      expect(res.body.data.streaming.map((v: { id: string }) => v.id)).toEqual(['qobuz:43']);
    });

    it('is one library for the household, with personal marks per person', async () => {
      const asMember = (r: request.Test) => r.set('Authorization', `Bearer ${member.token}`);
      const theirs = await asMember(request(app).get('/api/library/albums?source=qobuz'));
      expect(theirs.body.data.map((a: { id: string }) => a.id)).toEqual(['qobuz:42']);
      await request(app)
        .put('/api/ratings')
        .send({ itemType: 'album', itemId: 'qobuz:42', rating: 5 });
      await request(app)
        .post('/api/history/favorites')
        .send({ itemType: 'album', itemId: 'qobuz:42' });
      expect((await asMember(request(app).get('/api/ratings?type=album'))).body.data).toEqual({});
      expect(
        (await asMember(request(app).get('/api/history/favorites/ids?type=album'))).body.data,
      ).toEqual([]);
    });
  });
});

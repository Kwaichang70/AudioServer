import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import {
  compareForm,
  getIdentifyStatus,
  identifyAlbums,
  listDoubtfulAlbums,
  pickUnambiguous,
  resetIdentifyForTests,
} from '../services/identify.js';
import { configureMusicBrainz, MIN_INTERVAL_MS } from '../services/musicbrainz.js';
import type { ReleaseCandidate } from '../services/musicbrainz.js';

/**
 * Identifying albums (R03.3).
 *
 * The rule under test is restraint: link only what is beyond doubt, and hand
 * everything else to an admin instead of guessing. A wrong MBID would put
 * another record's label, date and credits on this album and every later
 * match would believe it.
 */

const candidate = (over: Partial<ReleaseCandidate> = {}): ReleaseCandidate => ({
  mbid: 'rel-1',
  title: 'Kind of Blue',
  artist: 'Miles Davis',
  releaseGroupMbid: 'rg-1',
  label: 'Columbia',
  catalogNumber: 'CL 1355',
  date: '1959-08-17',
  trackCount: 5,
  score: 100,
  ...over,
});

describe('Choosing a candidate', () => {
  const album = { title: 'Kind of Blue', artistName: 'Miles Davis', trackCount: 5 };

  it('reduces a name to what counts as the same name', () => {
    expect(compareForm('Café Blue')).toBe('cafe blue');
    expect(compareForm('Simon & Garfunkel')).toBe('simon and garfunkel');
  });

  it('accepts one candidate that agrees on artist, title and track count', () => {
    const { match } = pickUnambiguous(album, [candidate()]);
    expect(match?.mbid).toBe('rel-1');
  });

  it('refuses a candidate with another track count — a box set is not the album', () => {
    const { match, qualified } = pickUnambiguous(album, [candidate({ trackCount: 37 })]);
    expect(match).toBeNull();
    expect(qualified).toHaveLength(0);
  });

  it('refuses a low score and a different artist', () => {
    expect(pickUnambiguous(album, [candidate({ score: 62 })]).match).toBeNull();
    expect(pickUnambiguous(album, [candidate({ artist: 'A Tribute Band' })]).match).toBeNull();
  });

  it('refuses to choose between two different releases', () => {
    const { match, qualified } = pickUnambiguous(album, [
      candidate({ mbid: 'rel-1', releaseGroupMbid: 'rg-1' }),
      candidate({ mbid: 'rel-2', releaseGroupMbid: 'rg-2' }),
    ]);
    expect(match).toBeNull();
    expect(qualified).toHaveLength(2);
  });

  it('still links when the candidates are pressings of one album', () => {
    const { match } = pickUnambiguous(album, [
      candidate({ mbid: 'rel-1', releaseGroupMbid: 'rg-1' }),
      candidate({ mbid: 'rel-2', releaseGroupMbid: 'rg-1' }),
    ]);
    expect(match?.mbid).toBe('rel-1');
  });
});

describe('The identification job', () => {
  let app: Express;
  let teardown: () => void;
  let member: TestUser;
  let requested: string[] = [];
  let answer: (url: string) => unknown = () => ({ releases: [] });

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    member = ctx.member!;
  });

  afterAll(() => teardown());

  beforeEach(() => {
    resetIdentifyForTests();
    requested = [];
    const db = getRawDb();
    db.prepare('DELETE FROM album_identity_candidates').run();
    db.prepare('DELETE FROM albums').run();
    db.prepare('DELETE FROM artists').run();
    db.prepare("INSERT INTO artists (id, name) VALUES ('ar-1', 'Miles Davis')").run();
    db.prepare(
      `INSERT INTO albums (id, title, artist_id, artist_name, track_count, source)
       VALUES ('al-1', 'Kind of Blue', 'ar-1', 'Miles Davis', 5, 'local')`,
    ).run();

    // No network and no waiting: the queue is the thing under test elsewhere.
    configureMusicBrainz({
      fetch: (async (url: string) => {
        requested.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => answer(String(url)),
        } as unknown as Response;
      }) as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 0,
    });
  });

  afterEach(() => {
    configureMusicBrainz({ sleep: async () => {} });
  });

  it('links an album when MusicBrainz is unambiguous, and keeps the release data', async () => {
    answer = () => ({
      releases: [
        {
          id: 'rel-1',
          title: 'Kind of Blue',
          score: 100,
          date: '1959-08-17',
          'track-count': 5,
          'artist-credit': [{ artist: { id: 'art-1', name: 'Miles Davis' } }],
          'release-group': { id: 'rg-1' },
          'label-info': [{ 'catalog-number': 'CL 1355', label: { name: 'Columbia' } }],
        },
      ],
    });

    const status = await identifyAlbums();
    expect(status.linked).toBe(1);
    expect(status.doubtful).toBe(0);
    expect(getIdentifyStatus().isRunning).toBe(false);

    const album = getRawDb().prepare("SELECT * FROM albums WHERE id = 'al-1'").get() as Record<
      string,
      unknown
    >;
    expect(album.mbid).toBe('rel-1');
    expect(album.release_group_mbid).toBe('rg-1');
    expect(album.label).toBe('Columbia');
    expect(album.catalog_number).toBe('CL 1355');
    expect(album.release_date).toBe('1959-08-17');
    const artist = getRawDb().prepare("SELECT mbid FROM artists WHERE id = 'ar-1'").get() as {
      mbid: string | null;
    };
    expect(artist.mbid).toBe('art-1');
    // The track count is part of the query, not a filter afterwards.
    expect(requested[0]).toContain('tracks%3A5');
  });

  it('asks the admin instead of choosing between two releases', async () => {
    answer = () => ({
      releases: [
        {
          id: 'rel-1',
          title: 'Kind of Blue',
          score: 100,
          'track-count': 5,
          'artist-credit': [{ artist: { id: 'art-1', name: 'Miles Davis' } }],
          'release-group': { id: 'rg-1' },
        },
        {
          id: 'rel-2',
          title: 'Kind of Blue',
          score: 97,
          'track-count': 5,
          'artist-credit': [{ artist: { id: 'art-1', name: 'Miles Davis' } }],
          'release-group': { id: 'rg-2' },
        },
      ],
    });

    const status = await identifyAlbums();
    expect(status.doubtful).toBe(1);
    expect(status.linked).toBe(0);
    const album = getRawDb().prepare("SELECT mbid FROM albums WHERE id = 'al-1'").get() as {
      mbid: string | null;
    };
    expect(album.mbid).toBeNull();

    const doubtful = listDoubtfulAlbums();
    expect(doubtful).toHaveLength(1);
    expect(doubtful[0].candidates.map((c) => c.mbid)).toEqual(['rel-1', 'rel-2']);
  });

  it('counts an album MusicBrainz does not know as not found, and stores nothing', async () => {
    answer = () => ({ releases: [] });
    const status = await identifyAlbums();
    expect(status.notFound).toBe(1);
    expect(listDoubtfulAlbums()).toEqual([]);
  });

  it('skips albums that already have an id', async () => {
    getRawDb().prepare("UPDATE albums SET mbid = 'rel-9' WHERE id = 'al-1'").run();
    const status = await identifyAlbums();
    expect(status.total).toBe(0);
    expect(requested).toEqual([]);
  });

  it('lets an admin pick a candidate, and refuses an unknown release', async () => {
    answer = () => ({
      releases: [
        {
          id: 'rel-1',
          title: 'Kind of Blue',
          score: 100,
          'track-count': 5,
          'artist-credit': [{ artist: { id: 'art-1', name: 'Miles Davis' } }],
          'release-group': { id: 'rg-1' },
        },
        {
          id: 'rel-2',
          title: 'Kind of Blue',
          score: 97,
          'track-count': 5,
          'artist-credit': [{ artist: { id: 'art-1', name: 'Miles Davis' } }],
          'release-group': { id: 'rg-2' },
        },
      ],
    });
    await identifyAlbums();

    // The chosen release is looked up, not trusted from the stored candidate.
    answer = (url) =>
      url.includes('/release/rel-2')
        ? {
            id: 'rel-2',
            title: 'Kind of Blue',
            'artist-credit': [{ artist: { id: 'art-1', name: 'Miles Davis' } }],
            'release-group': { id: 'rg-2' },
            'label-info': [{ label: { name: 'Legacy' } }],
            date: '1997',
          }
        : { releases: [] };

    const chosen = await request(app).post('/api/library/identify/al-1').send({ mbid: 'rel-2' });
    expect(chosen.status).toBe(200);
    const album = getRawDb().prepare("SELECT * FROM albums WHERE id = 'al-1'").get() as Record<
      string,
      unknown
    >;
    expect(album.mbid).toBe('rel-2');
    expect(album.label).toBe('Legacy');
    // The question is answered, so the candidates are gone.
    expect(listDoubtfulAlbums()).toEqual([]);

    answer = () => ({ error: 'Not Found' });
    const bad = await request(app)
      .post('/api/library/identify/al-1')
      .send({ mbid: 'rel-nonexistent' });
    expect([404, 422]).toContain(bad.status);
  });

  it('keeps the doubtful list and the job behind admin rights', async () => {
    const asMember = { Authorization: `Bearer ${member.token}` };
    expect((await request(app).get('/api/library/identify/doubtful').set(asMember)).status).toBe(
      403,
    );
    expect((await request(app).post('/api/library/identify').set(asMember)).status).toBe(403);
    // The status itself is readable: it says whether a job is running.
    expect((await request(app).get('/api/library/identify/status').set(asMember)).status).toBe(200);
  });

  it('spaces its requests one second apart', async () => {
    const waits: number[] = [];
    // A clock well past zero, as a real one is: the module's "last request"
    // starts at 0, so only a fake clock near zero would make the FIRST call
    // wait as well.
    let clock = 10_000_000;
    configureMusicBrainz({
      fetch: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ releases: [] }),
        }) as unknown as Response) as unknown as typeof fetch,
      now: () => clock,
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const db = getRawDb();
    db.prepare(
      `INSERT INTO albums (id, title, artist_id, artist_name, track_count, source)
       VALUES ('al-2', 'Bitches Brew', 'ar-1', 'Miles Davis', 6, 'local')`,
    ).run();

    await identifyAlbums();
    // Two albums, so one wait of the full interval between them.
    expect(waits.filter((w) => w >= MIN_INTERVAL_MS)).toHaveLength(1);
  });
});

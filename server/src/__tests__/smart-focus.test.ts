import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';

/**
 * R05.3: smart playlists and bookmarks are stored Focus questions.
 *
 * The promise of the migration is that an old six-field smart playlist plays
 * the same tracks afterwards. That is checked against the query the old
 * route ran, copied here verbatim as the reference.
 */

const OLD_FIELDS: Record<string, string> = {
  genre: 'a.genre',
  year: 'a.year',
  format: 't.format',
  sampleRate: 't.sample_rate',
  bitDepth: 't.bit_depth',
  artistName: 't.artist_name',
};

interface OldRule {
  field: string;
  operator: string;
  value: string;
  value2?: string;
}

/** The pre-R05.3 `executeSmartPlaylist`, as it was. */
function oldSmartPlaylist(rules: OldRule[]): string[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  for (const rule of rules) {
    const col = OLD_FIELDS[rule.field];
    if (rule.operator === 'equals') {
      conditions.push(`${col} = ?`);
      params.push(rule.value);
    } else if (rule.operator === 'contains') {
      conditions.push(`${col} LIKE ?`);
      params.push(`%${rule.value}%`);
    } else if (rule.operator === 'greaterThan') {
      conditions.push(`${col} > ?`);
      params.push(Number(rule.value));
    } else if (rule.operator === 'lessThan') {
      conditions.push(`${col} < ?`);
      params.push(Number(rule.value));
    } else {
      conditions.push(`${col} BETWEEN ? AND ?`);
      params.push(Number(rule.value), Number(rule.value2 || rule.value));
    }
  }
  const where = conditions.length ? conditions.join(' AND ') : '1=1';
  return (
    getRawDb()
      .prepare(
        `SELECT DISTINCT t.id FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
          WHERE ${where} ORDER BY t.artist_name, t.album_title, t.disc_number, t.track_number LIMIT ?`,
      )
      .all(...params, 200) as Array<{ id: string }>
  ).map((r) => r.id);
}

const LEGACY: Array<[string, OldRule[]]> = [
  ['genre equals', [{ field: 'genre', operator: 'equals', value: 'Jazz' }]],
  ['genre contains', [{ field: 'genre', operator: 'contains', value: 'lu' }]],
  ['year between', [{ field: 'year', operator: 'between', value: '1960', value2: '1979' }]],
  [
    'hi-res flac',
    [
      { field: 'format', operator: 'equals', value: 'flac' },
      { field: 'sampleRate', operator: 'greaterThan', value: '48000' },
    ],
  ],
  ['bit depth', [{ field: 'bitDepth', operator: 'equals', value: '16' }]],
  ['artist contains', [{ field: 'artistName', operator: 'contains', value: 'Davis' }]],
  [
    'year below, mp3',
    [
      { field: 'year', operator: 'lessThan', value: '1980' },
      { field: 'format', operator: 'contains', value: 'mp' },
    ],
  ],
];

describe('Smart playlists and bookmarks as Focus questions', () => {
  let app: Express;
  let teardown: () => void;
  let dbPath: string;
  let admin: TestUser;
  let member: TestUser;
  const legacyIds: Record<string, string> = {};

  const ids = (res: request.Response) => res.body.data.map((r: { id: string }) => r.id);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    dbPath = ctx.dbPath;
    admin = ctx.admin!;
    member = ctx.member!;

    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES
        ('ar-miles', 'Miles Davis'), ('ar-coltrane', 'John Coltrane'),
        ('ar-rj', 'Robert Johnson'), ('ar-kw', 'Kraftwerk');
      INSERT INTO albums (id, title, artist_id, artist_name, year, genre, format, bit_depth, sample_rate) VALUES
        ('al-kob', 'Kind of Blue', 'ar-miles', 'Miles Davis', 1959, 'Jazz', 'flac', 24, 96000),
        ('al-brew', 'Bitches Brew', 'ar-miles', 'Miles Davis', 1970, 'Jazz', 'mp3', 16, 44100),
        ('al-als', 'A Love Supreme', 'ar-coltrane', 'John Coltrane', 1965, 'Jazz', 'flac', 16, 44100),
        ('al-rj', 'King of the Delta Blues', 'ar-rj', 'Robert Johnson', 1961, 'Blues', 'mp3', 16, 44100),
        ('al-tee', 'Trans-Europa Express', 'ar-kw', 'Kraftwerk', 1977, 'Electronic', 'flac', 24, 192000);
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, duration,
                           disc_number, track_number, format, bit_depth, sample_rate)
       SELECT ?, ?, a.id, a.title, a.artist_id, a.artist_name, 300, 1, ?, a.format, a.bit_depth,
              a.sample_rate FROM albums a WHERE a.id = ?`,
    );
    const tracks: Array<[string, string, number, string]> = [
      ['kob-1', 'So What', 1, 'al-kob'],
      ['kob-2', 'Freddie Freeloader', 2, 'al-kob'],
      ['brew-1', 'Pharaoh’s Dance', 1, 'al-brew'],
      ['als-1', 'Acknowledgement', 1, 'al-als'],
      ['als-2', 'Resolution', 2, 'al-als'],
      ['rj-1', 'Cross Road Blues', 1, 'al-rj'],
      ['tee-1', 'Europe Endless', 1, 'al-tee'],
      ['tee-2', 'Trans-Europe Express', 2, 'al-tee'],
    ];
    for (const t of tracks) track.run(...t);
    db.prepare(
      `INSERT INTO listening_sessions (id, track_id, title, artist_name, started_at, status, qualified, user_id)
       VALUES ('s1', 'kob-1', 'x', 'x', ?, 'ended', 1, ?)`,
    ).run(Math.floor(Date.now() / 1000), admin.id);

    // Smart playlists as the pre-Focus version stored them: rules, no definition.
    const insert = db.prepare(
      `INSERT INTO smart_playlists (id, name, rules, track_count, user_id, shared)
       VALUES (?, ?, ?, 0, ?, 0)`,
    );
    for (const [name, rules] of LEGACY) {
      legacyIds[name] = `sp-${name.replace(/\W+/g, '-')}`;
      insert.run(legacyIds[name], name, JSON.stringify(rules), admin.id);
    }
    insert.run('sp-broken', 'broken', '[not json', admin.id);

    // Restart: the migration runs on start, as it will on the NAS.
    closeDatabase();
    await initDatabase(dbPath);
  });

  afterAll(() => teardown());

  describe('migration of six-field smart playlists', () => {
    it('gives every readable old playlist a definition and leaves broken ones alone', () => {
      const rows = getRawDb().prepare('SELECT id, definition FROM smart_playlists').all() as Array<{
        id: string;
        definition: string | null;
      }>;
      for (const row of rows) {
        if (row.id === 'sp-broken') expect(row.definition).toBeNull();
        else expect(JSON.parse(row.definition!)).toMatchObject({ version: 2, limit: 200 });
      }
    });

    it.each(LEGACY)('"%s" plays exactly the tracks it played before', async (name, rules) => {
      const before = oldSmartPlaylist(rules);
      expect(before.length).toBeGreaterThan(0);
      const res = await request(app).get(`/api/smart-playlists/${legacyIds[name]}/tracks`);
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual(before);
    });

    it('still reports a playlist whose rules cannot be read', async () => {
      const res = await request(app).get('/api/smart-playlists/sp-broken/tracks');
      expect(res.status).toBe(500);
    });

    it('still accepts six-field rules from an old client, as one group', async () => {
      const res = await request(app)
        .post('/api/smart-playlists')
        .send({
          name: 'old client',
          rules: [{ field: 'genre', operator: 'equals', value: 'Blues' }],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.definition.groups).toHaveLength(1);
      const tracks = await request(app).get(`/api/smart-playlists/${res.body.data.id}/tracks`);
      expect(ids(tracks)).toEqual(['rj-1']);
    });
  });

  describe('definitions', () => {
    it('ORs groups, with one sort and a limit', async () => {
      const res = await request(app)
        .post('/api/smart-playlists')
        .send({
          name: 'Hi-res or blues',
          definition: {
            groups: ['quality=hires&genre=Jazz', 'genre=Blues'],
            sort: 'year',
            order: 'desc',
            limit: 3,
          },
        });
      expect(res.status).toBe(201);
      const tracks = await request(app).get(`/api/smart-playlists/${res.body.data.id}/tracks`);
      // Hi-res jazz is Kind of Blue (1959); blues is 1961. Newest first, then album order.
      expect(ids(tracks)).toEqual(['rj-1', 'kob-1', 'kob-2']);
      expect(res.body.data.trackCount).toBe(3);
    });

    it("reads the owner's listening data, also for a housemate", async () => {
      const created = await request(app)
        .post('/api/smart-playlists')
        .send({
          name: 'Unplayed jazz',
          shared: true,
          definition: { groups: ['genre=Jazz&unplayed=true'] },
        });
      const mine = await request(app).get(`/api/smart-playlists/${created.body.data.id}/tracks`);
      const theirs = await request(app)
        .get(`/api/smart-playlists/${created.body.data.id}/tracks`)
        .set('Authorization', `Bearer ${member.token}`);
      expect(ids(mine)).not.toContain('kob-1');
      expect(ids(theirs)).toEqual(ids(mine));
    });

    it('normalizes groups and drops what is not Focus', async () => {
      const res = await request(app)
        .post('/api/smart-playlists')
        .send({
          name: 'norm',
          definition: { groups: ['bogus=1&genre=Jazz&sort=plays'], sort: 'nonsense' },
        });
      expect(res.body.data.definition).toEqual({
        version: 2,
        groups: ['genre=Jazz'],
        limit: 200,
      });
    });

    it('rejects an empty definition', async () => {
      const res = await request(app)
        .post('/api/smart-playlists')
        .send({ name: 'empty', definition: { groups: [] } });
      expect(res.status).toBe(400);
    });

    it('lets the field conditions travel in a Focus URL', async () => {
      const rule = encodeURIComponent(
        JSON.stringify({ field: 'artistName', operator: 'contains', value: 'Davis' }),
      );
      const res = await request(app).get(`/api/library/tracks?rule=${rule}&format=flac`);
      expect(ids(res)).toEqual(['kob-1', 'kob-2']);
      const albums = await request(app).get(`/api/library/albums?rule=${rule}`);
      expect(ids(albums).sort()).toEqual(['al-brew', 'al-kob']);
    });
  });

  describe('bookmarks', () => {
    it('stores a named Focus question, normalized, for its owner only', async () => {
      const created = await request(app).post('/api/bookmarks').send({
        name: 'Hi-Res jazz, 70s, never played',
        path: '/albums',
        query: 'unplayed=true&utm=x&genre=Jazz&quality=hires&yearFrom=1970&yearTo=1979',
      });
      expect(created.status).toBe(201);
      expect(created.body.data.query).toBe(
        'genre=Jazz&yearFrom=1970&yearTo=1979&quality=hires&unplayed=true',
      );

      const mine = await request(app).get('/api/bookmarks');
      expect(mine.body.data.map((b: { name: string }) => b.name)).toEqual([
        'Hi-Res jazz, 70s, never played',
      ]);
      const theirs = await request(app)
        .get('/api/bookmarks')
        .set('Authorization', `Bearer ${member.token}`);
      expect(theirs.body.data).toEqual([]);

      const id = created.body.data.id;
      const steal = await request(app)
        .delete(`/api/bookmarks/${id}`)
        .set('Authorization', `Bearer ${member.token}`);
      expect(steal.status).toBe(404);
      const rename = await request(app).patch(`/api/bookmarks/${id}`).send({ name: 'Seventies' });
      expect(rename.body.data.name).toBe('Seventies');
      const removed = await request(app).delete(`/api/bookmarks/${id}`);
      expect(removed.status).toBe(200);
    });

    it('only bookmarks pages that speak Focus', async () => {
      const res = await request(app)
        .post('/api/bookmarks')
        .send({ name: 'x', path: '/settings', query: '' });
      expect(res.status).toBe(400);
    });
  });
});

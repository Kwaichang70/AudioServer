import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { attachmentHeader, buildIndex, matchEntry, parseM3u } from '../services/m3u.js';

/**
 * B11: an M3U import takes exactly one track per line or says it could not —
 * "song.flac" is not "other-song.flac", and two albums with a "01.flac" are
 * ambiguous unless the folder or the #EXTINF says which. Export works for
 * any playlist name.
 */

const files = [
  {
    id: 'a',
    filePath: '//diskstation/Music/Album A/01.flac',
    title: 'Intro',
    artistName: 'Band A',
  },
  {
    id: 'b',
    filePath: '//diskstation/Music/Album B/01.flac',
    title: 'Opening',
    artistName: 'Band B',
  },
  {
    id: 'c',
    filePath: '//diskstation/Music/Misc/other-song.flac',
    title: 'Other',
    artistName: 'X',
  },
  { id: 'd', filePath: '//diskstation/Music/Misc/song.flac', title: 'Song', artistName: 'X' },
];
const index = buildIndex(files);
const match = (line: string, label?: string) => matchEntry(index, { line, label });

describe('M3U matching', () => {
  it('takes the exact path, also written with backslashes', () => {
    expect(match('//diskstation/Music/Album B/01.flac')).toEqual({ kind: 'matched', trackId: 'b' });
    expect(match('\\\\diskstation\\Music\\Album B\\01.flac')).toEqual({
      kind: 'matched',
      trackId: 'b',
    });
  });

  it('never takes a name that only ends the same', () => {
    expect(match('D:/old/song.flac')).toEqual({ kind: 'matched', trackId: 'd' });
    expect(match('D:/old/ong.flac')).toEqual({ kind: 'missing' });
  });

  it('uses the folder, then the #EXTINF, for a file name two albums share', () => {
    expect(match('E:/rip/Album A/01.flac')).toEqual({ kind: 'matched', trackId: 'a' });
    expect(match('E:/rip/01.flac', 'Band B - Opening')).toEqual({ kind: 'matched', trackId: 'b' });
    expect(match('E:/rip/01.flac')).toEqual({ kind: 'ambiguous', candidates: 2 });
  });

  it('reads #EXTINF labels and Windows line ends', () => {
    expect(parseM3u('#EXTM3U\r\n#EXTINF:180,Band B - Opening\r\nE:/rip/01.flac\r\n')).toEqual([
      { line: 'E:/rip/01.flac', label: 'Band B - Opening' },
    ]);
  });
});

describe('M3U over HTTP', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    const db = getRawDb();
    db.exec(`INSERT INTO artists (id, name) VALUES ('ar', 'X');
             INSERT INTO albums (id, title, artist_id, artist_name) VALUES ('al', 'Misc', 'ar', 'X');`);
    const insert = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path)
       VALUES (?, ?, 'al', 'Misc', 'ar', ?, ?)`,
    );
    for (const f of files) insert.run(f.id, f.title, f.artistName, f.filePath);
  });

  afterAll(() => teardown());

  it('imports what matches and reports what is missing or ambiguous', async () => {
    const res = await request(app)
      .post('/api/playlists/import')
      .send({ name: 'Mix', content: '#EXTM3U\nE:/rip/01.flac\nD:/old/song.flac\nZ:/nope.flac\n' });
    expect(res.status).toBe(201);
    expect(res.body.meta).toMatchObject({ matched: 1, total: 3, missing: 1, ambiguous: 1 });
    expect(res.body.meta.ambiguousLines).toEqual(['E:/rip/01.flac']);
  });

  for (const name of ['Muziek 🎵', '日本語', 'He said "hi"', 'line\nbreak']) {
    it(`exports "${name.replace('\n', '\\n')}" without a server error`, async () => {
      const created = await request(app).post('/api/playlists').send({ name });
      const res = await request(app)
        .get(`/api/playlists/${created.body.data.id}/export`)
        .buffer(true)
        .parse((r, done) => {
          let body = '';
          r.on('data', (chunk: Buffer) => (body += chunk.toString()));
          r.on('end', () => done(null, body));
        });
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename=".*\.m3u"; filename\*=UTF-8''/,
      );
      // The #PLAYLIST line holds the name on one line.
      expect((res.body as string).split('\n')[1]).toBe(`#PLAYLIST:${name.replace('\n', ' ')}`);
    });
  }

  it('keeps the real name in the encoded part', () => {
    expect(attachmentHeader('Muziek 🎵', '.m3u')).toContain(
      `filename*=UTF-8''${encodeURIComponent('Muziek 🎵.m3u')}`,
    );
  });
});

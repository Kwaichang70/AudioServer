import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';

/**
 * Mixed playlists (V12.1).
 *
 * The acceptance this suite is written against: a playlist with local and
 * Qobuz tracks comes back identical after a restart, asks for no stream URL
 * until playback, keeps an item that cannot be played right now instead of
 * dropping it, and exports to M3U with an explicit limitation for everything
 * that is not a local file.
 */

async function seedLibrary() {
  const db = getRawDb();
  db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run('artist-1', 'Local Artist');
  db.prepare(
    'INSERT INTO albums (id, title, artist_id, artist_name, track_count) VALUES (?, ?, ?, ?, ?)',
  ).run('album-1', 'Local Album', 'artist-1', 'Local Artist', 2);
  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name,
                         track_number, duration, file_path, format)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertTrack.run(
    'track-1',
    'First Local',
    'album-1',
    'Local Album',
    'artist-1',
    'Local Artist',
    1,
    212,
    '//nas/Music/first.flac',
    'flac',
  );
  insertTrack.run(
    'track-2',
    'Second Local',
    'album-1',
    'Local Album',
    'artist-1',
    'Local Artist',
    2,
    180,
    '//nas/Music/second.flac',
    'flac',
  );
}

describe('Mixed playlists (V12.1)', () => {
  let app: Express;
  let teardown: () => void;
  let playlistId: string;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    await seedLibrary();
    const created = await request(app).post('/api/playlists').send({ name: 'Mixed' });
    playlistId = created.body.data.id;
  });

  afterAll(() => teardown());

  it('holds a local and a Qobuz track in one playlist', async () => {
    const local = await request(app)
      .post(`/api/playlists/${playlistId}/tracks`)
      .send({ trackId: 'track-1' });
    expect(local.status).toBe(200);

    const qobuz = await request(app).post(`/api/playlists/${playlistId}/tracks`).send({
      trackId: 'qobuz:99887',
      title: 'Remote Song',
      artistName: 'Remote Artist',
      albumTitle: 'Remote Album',
      duration: 240,
    });
    expect(qobuz.status).toBe(200);
    expect(qobuz.body.data.trackCount).toBe(2);

    const listed = await request(app).get(`/api/playlists/${playlistId}/tracks`);
    expect(listed.body.data.map((i: { id: string }) => i.id)).toEqual(['track-1', 'qobuz:99887']);
    expect(listed.body.data[1].source).toBe('qobuz');
    expect(listed.body.data[1].title).toBe('Remote Song');
  });

  it('stores a snapshot, not a stream URL', () => {
    const row = getRawDb()
      .prepare('SELECT * FROM playlist_tracks WHERE track_id = ?')
      .get('qobuz:99887') as Record<string, unknown>;
    expect(row.track_title).toBe('Remote Song');
    expect(row.artist_name).toBe('Remote Artist');
    expect(row.duration).toBe(240);
    // Nothing that expires may be persisted: the URL is resolved at playback.
    const stored = JSON.stringify(row);
    expect(stored).not.toMatch(/https?:\/\//);
  });

  it('refuses an external track without a readable name', async () => {
    const res = await request(app)
      .post(`/api/playlists/${playlistId}/tracks`)
      .send({ trackId: 'qobuz:nameless' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('MetadataRequired');
  });

  it('answers 404 for a local id that is not in the library', async () => {
    const res = await request(app)
      .post(`/api/playlists/${playlistId}/tracks`)
      .send({ trackId: 'no-such-track' });
    expect(res.status).toBe(404);
  });

  it('keeps an item whose local file left the library, with its snapshot', async () => {
    const created = await request(app).post('/api/playlists').send({ name: 'Survivors' });
    const id = created.body.data.id;
    await request(app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'track-2' });

    // The scanner purges the row; the playlist item must not vanish with it.
    getRawDb().prepare('DELETE FROM tracks WHERE id = ?').run('track-2');

    const res = await request(app).get(`/api/playlists/${id}/tracks`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].title).toBe('Second Local');
    expect(res.body.data[0].availability).toBe('unavailable');
    expect(res.body.data[0].unavailableReason).toMatch(/no longer in the library/i);
    expect(res.body.meta.unavailable).toBe(1);

    // Put it back so the rest of the suite sees the library it seeded.
    getRawDb()
      .prepare(
        `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name,
                             track_number, duration, file_path, format)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'track-2',
        'Second Local',
        'album-1',
        'Local Album',
        'artist-1',
        'Local Artist',
        2,
        180,
        '//nas/Music/second.flac',
        'flac',
      );
  });

  it('marks a local file the scanner cannot find as missing, not gone', async () => {
    const created = await request(app).post('/api/playlists').send({ name: 'Missing file' });
    const id = created.body.data.id;
    await request(app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'track-2' });
    getRawDb().prepare("UPDATE tracks SET availability = 'missing' WHERE id = ?").run('track-2');

    const res = await request(app).get(`/api/playlists/${id}/tracks`);
    expect(res.body.data[0].availability).toBe('missing');
    expect(res.body.data[0].unavailableReason).toMatch(/relink|scan/i);

    getRawDb().prepare("UPDATE tracks SET availability = 'available' WHERE id = ?").run('track-2');
  });

  it('gives every item its own id, so one of two copies can be removed', async () => {
    const created = await request(app).post('/api/playlists').send({ name: 'Twice' });
    const id = created.body.data.id;
    const first = await request(app)
      .post(`/api/playlists/${id}/tracks`)
      .send({ trackId: 'track-1' });
    const second = await request(app)
      .post(`/api/playlists/${id}/tracks`)
      .send({ trackId: 'track-1' });
    expect(first.body.data.itemId).not.toBe(second.body.data.itemId);

    const removed = await request(app).delete(
      `/api/playlists/${id}/tracks/${first.body.data.itemId}`,
    );
    expect(removed.body.data.trackCount).toBe(1);

    const left = await request(app).get(`/api/playlists/${id}/tracks`);
    expect(left.body.data).toHaveLength(1);
    expect(left.body.data[0].playlistItemId).toBe(second.body.data.itemId);
  });

  it('reorders by item id and keeps items the caller left out', async () => {
    const created = await request(app).post('/api/playlists').send({ name: 'Order' });
    const id = created.body.data.id;
    const a = await request(app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'track-1' });
    const b = await request(app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'track-2' });
    await request(app)
      .post(`/api/playlists/${id}/tracks`)
      .send({ trackId: 'qobuz:5', title: 'Third', artistName: 'Someone' });

    const res = await request(app)
      .post(`/api/playlists/${id}/reorder`)
      .send({ itemIds: [b.body.data.itemId, a.body.data.itemId] });
    expect(res.status).toBe(200);

    const listed = await request(app).get(`/api/playlists/${id}/tracks`);
    expect(listed.body.data.map((i: { id: string }) => i.id)).toEqual([
      'track-2',
      'track-1',
      'qobuz:5',
    ]);
  });

  it('still accepts the old trackIds reorder body', async () => {
    const created = await request(app).post('/api/playlists').send({ name: 'Legacy order' });
    const id = created.body.data.id;
    await request(app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'track-1' });
    await request(app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'track-2' });

    const res = await request(app)
      .post(`/api/playlists/${id}/reorder`)
      .send({ trackIds: ['track-2', 'track-1'] });
    expect(res.status).toBe(200);
    const listed = await request(app).get(`/api/playlists/${id}/tracks`);
    expect(listed.body.data.map((i: { id: string }) => i.id)).toEqual(['track-2', 'track-1']);
  });

  it('exports local files and names the limitation for the rest', async () => {
    const res = await request(app)
      .get(`/api/playlists/${playlistId}/export`)
      .buffer(true)
      .parse((r, cb) => {
        let body = '';
        r.on('data', (chunk) => (body += chunk));
        r.on('end', () => cb(null, body));
      });
    expect(res.status).toBe(200);
    expect(res.headers['x-playlist-export-skipped']).toBe('1');
    const m3u = res.body as unknown as string;
    expect(m3u).toContain('//nas/Music/first.flac');
    expect(m3u).toContain('# not exported (qobuz): qobuz:99887');
    expect(m3u).toMatch(/cannot be\n# exported/);
    // An external item must never be written as a playable line.
    expect(m3u).not.toMatch(/^qobuz:99887$/m);
  });

  it('imports an M3U of local paths and snapshots them', async () => {
    const m3u = '#EXTM3U\n//nas/Music/first.flac\n//nas/Music/gone.flac\n';
    const res = await request(app)
      .post('/api/playlists/import')
      .send({ name: 'Imported', content: m3u });
    expect(res.status).toBe(201);
    expect(res.body.meta.matched).toBe(1);

    const listed = await request(app).get(`/api/playlists/${res.body.data.id}/tracks`);
    expect(listed.body.data[0].id).toBe('track-1');
    const row = getRawDb()
      .prepare('SELECT track_title FROM playlist_tracks WHERE playlist_id = ?')
      .get(res.body.data.id) as { track_title: string };
    expect(row.track_title).toBe('First Local');
  });
});

describe('A mixed playlist survives a restart (V12.1)', () => {
  it('reads back identically from the same database file', async () => {
    const ctx = await createTestApp();
    await seedLibrary();
    const created = await request(ctx.app).post('/api/playlists').send({ name: 'Across restarts' });
    const id = created.body.data.id;
    await request(ctx.app).post(`/api/playlists/${id}/tracks`).send({ trackId: 'track-1' });
    await request(ctx.app).post(`/api/playlists/${id}/tracks`).send({
      trackId: 'qobuz:4242',
      title: 'Kept Across Restart',
      artistName: 'Remote Artist',
      albumTitle: 'Remote Album',
      duration: 199,
    });
    const before = await request(ctx.app).get(`/api/playlists/${id}/tracks`);

    // Close the database and open the same file again, exactly as a restart does.
    const { initDatabase, getRawDb: raw } = await import('../db/index.js');
    raw().close();
    await initDatabase(ctx.dbPath);
    const after = await request(ctx.app).get(`/api/playlists/${id}/tracks`);

    expect(after.body.data).toEqual(before.body.data);
    expect(after.body.data.map((i: { id: string }) => i.id)).toEqual(['track-1', 'qobuz:4242']);
    expect(after.body.data[1].title).toBe('Kept Across Restart');
    ctx.teardown();
  });
});

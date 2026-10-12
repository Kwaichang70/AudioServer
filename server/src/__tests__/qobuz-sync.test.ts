import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Album, Track } from '@audioserver/shared';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { configureQobuzLibrary, resetQobuzLibrary } from '../services/qobuz-library.js';
import {
  configureQobuzSync,
  refreshQobuzAvailability,
  resetQobuzSync,
  syncQobuzFavorites,
} from '../services/qobuz-sync.js';
import { QobuzProviderError } from '../providers/qobuz.js';

/**
 * Library ⇄ Qobuz favourites (R07.2), against a fake Qobuz account: both
 * directions, removal only after you confirm, withdrawn titles dimmed.
 */

const qobuz = {
  favorites: new Set<string>(),
  /** Albums Qobuz offers; a missing id answers 404. */
  catalog: new Map<string, { streamable: boolean; tracks: Array<[string, boolean]> }>(),
  calls: [] as string[],
  failFavorite: false,
};

function fetchAlbum(id: string) {
  const key = id.startsWith('qobuz:') ? id : `qobuz:${id}`;
  const entry = qobuz.catalog.get(key);
  if (!entry)
    return Promise.reject(new QobuzProviderError('qobuz_stream_unavailable', 'gone', 404));
  const album = {
    id: key,
    title: `Album ${key}`,
    artistId: 'qobuz:1',
    artistName: 'Artist',
    streamable: entry.streamable,
    source: 'qobuz',
  } as Album & { streamable: boolean };
  const tracks = entry.tracks.map(
    ([tid, streamable], i) =>
      ({
        id: tid,
        title: `T${i}`,
        albumId: key,
        albumTitle: album.title,
        artistId: 'qobuz:1',
        artistName: 'Artist',
        trackNumber: i + 1,
        streamable,
        source: 'qobuz',
      }) as Track & { streamable: boolean },
  );
  return Promise.resolve({ album, tracks });
}

describe('Qobuz favourites sync', () => {
  let app: Express;
  let teardown: () => void;
  const libraryIds = () =>
    (
      getRawDb()
        .prepare("SELECT id FROM albums WHERE source = 'qobuz' ORDER BY id")
        .all() as Array<{
        id: string;
      }>
    ).map((r) => r.id);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    configureQobuzLibrary({ fetchAlbum });
    configureQobuzSync({
      ready: () => true,
      fetchFavorites: async () => [...qobuz.favorites],
      setFavorite: async (id, favorite) => {
        qobuz.calls.push(`${favorite ? '+' : '-'}${id}`);
        if (qobuz.failFavorite) throw new Error('Qobuz down');
        if (favorite) qobuz.favorites.add(id);
        else qobuz.favorites.delete(id);
      },
      fetchAlbum,
    });
    for (const id of ['1', '2', '3', '4']) {
      qobuz.catalog.set(`qobuz:${id}`, {
        streamable: true,
        tracks: [
          [`qobuz:${id}01`, true],
          [`qobuz:${id}02`, true],
        ],
      });
    }
  });

  beforeEach(() => {
    qobuz.calls = [];
    qobuz.failFavorite = false;
  });

  afterAll(() => {
    resetQobuzLibrary();
    resetQobuzSync();
    teardown();
  });

  it('brings a favourite added on Qobuz (your phone) into the library', async () => {
    qobuz.favorites.add('qobuz:1');
    const result = await syncQobuzFavorites();
    expect(result?.addedToLibrary).toEqual(['qobuz:1']);
    expect(libraryIds()).toEqual(['qobuz:1']);
    // Nothing to push back.
    expect(qobuz.calls).toEqual([]);
  });

  it('favourites on Qobuz what you add in the app — right away', async () => {
    const res = await request(app).post('/api/library/qobuz/albums/2');
    expect(res.body.data.qobuzFavorite).toBe('synced');
    expect(qobuz.calls).toEqual(['+qobuz:2']);
    expect(qobuz.favorites.has('qobuz:2')).toBe(true);
  });

  it('retries a favourite that could not be pushed at the next sync', async () => {
    qobuz.failFavorite = true;
    const res = await request(app).post('/api/library/qobuz/albums/3');
    expect(res.body.data.qobuzFavorite).toBe('pending');
    qobuz.failFavorite = false;
    const result = await syncQobuzFavorites();
    expect(result?.favoritedOnQobuz).toEqual(['qobuz:3']);
    expect(qobuz.favorites.has('qobuz:3')).toBe(true);
  });

  it('unfavourites on Qobuz what you removed from the library (after confirming in the app)', async () => {
    expect((await request(app).delete('/api/library/albums/qobuz:3')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(qobuz.calls).toEqual(['-qobuz:3']);
    expect(qobuz.favorites.has('qobuz:3')).toBe(false);
    // And a sync afterwards does not bring it back.
    const result = await syncQobuzFavorites();
    expect(result?.addedToLibrary).toEqual([]);
    expect(libraryIds()).not.toContain('qobuz:3');
  });

  it('does not delete what was removed on Qobuz — it asks', async () => {
    qobuz.favorites.delete('qobuz:1');
    const result = await syncQobuzFavorites();
    expect(result?.removedOnQobuz).toEqual(['qobuz:1']);
    expect(libraryIds()).toContain('qobuz:1');
    const status = await request(app).get('/api/library/qobuz/sync');
    expect(status.body.data.waiting.map((w: { id: string }) => w.id)).toEqual(['qobuz:1']);
    // A second sync neither deletes it nor favourites it back.
    await syncQobuzFavorites();
    expect(qobuz.calls).toEqual([]);
    expect(libraryIds()).toContain('qobuz:1');
  });

  it('keeps it when you say keep, removes it when you say remove', async () => {
    qobuz.favorites.delete('qobuz:2');
    await syncQobuzFavorites();
    const keep = await request(app)
      .post('/api/library/qobuz/sync/qobuz:1')
      .send({ decision: 'keep' });
    expect(keep.status).toBe(200);
    const remove = await request(app)
      .post('/api/library/qobuz/sync/qobuz:2')
      .send({ decision: 'remove' });
    expect(remove.body.data.waiting).toEqual([]);
    expect(libraryIds()).toEqual(['qobuz:1']);
    // Kept without the favourite: a sync leaves it alone.
    await syncQobuzFavorites();
    expect(qobuz.calls).toEqual([]);
    expect(
      (await request(app).post('/api/library/qobuz/sync/qobuz:1').send({ decision: 'remove' }))
        .status,
    ).toBe(404);
  });

  it('marks titles Qobuz withdrew as unavailable, and back when they return', async () => {
    await request(app).post('/api/library/qobuz/albums/4');
    qobuz.catalog.set('qobuz:4', {
      streamable: true,
      tracks: [
        ['qobuz:401', true],
        ['qobuz:402', false],
      ],
    });
    qobuz.catalog.delete('qobuz:1'); // gone from Qobuz entirely
    const result = await refreshQobuzAvailability();
    expect(result.checked).toBe(2);
    const availability = (id: string) =>
      (
        getRawDb().prepare('SELECT availability FROM tracks WHERE id = ?').get(id) as {
          availability: string;
        }
      ).availability;
    expect(availability('qobuz:401')).toBe('streaming');
    expect(availability('qobuz:402')).toBe('unavailable');
    expect(availability('qobuz:101')).toBe('unavailable');

    qobuz.catalog.set('qobuz:4', {
      streamable: true,
      tracks: [
        ['qobuz:401', true],
        ['qobuz:402', true],
      ],
    });
    await refreshQobuzAvailability();
    expect(availability('qobuz:402')).toBe('streaming');
  });

  it('does nothing without a Qobuz login', async () => {
    configureQobuzSync({ ready: () => false });
    expect(await syncQobuzFavorites()).toBeNull();
    expect((await request(app).post('/api/library/qobuz/sync')).status).toBe(409);
  });
});

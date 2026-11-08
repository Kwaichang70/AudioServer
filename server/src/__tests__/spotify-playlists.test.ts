import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { providers } from '../providers/registry.js';

/**
 * The user's Spotify playlists in AudioServer: all of them (Spotify pages by
 * 50), with their track count also after Spotify renamed `tracks` to `items`,
 * and a playlist's tracks for the page that shows it.
 */
describe('Spotify playlists', () => {
  let app: Express;
  let teardown: () => void;
  const spotify = providers.spotify;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spotify.auth.isAuthenticated = false;
  });

  afterAll(() => teardown());

  it('reads every page and the track count in either form', async () => {
    spotify.auth.isAuthenticated = true;
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `p${from + i}`,
        name: `List ${from + i}`,
        ...(i % 2 ? { tracks: { total: 7 } } : { items: { total: 9 } }),
      }));
    const api = vi
      .spyOn(spotify as unknown as { apiRequest: (p: string) => Promise<unknown> }, 'apiRequest')
      .mockImplementation(async (path: string) => {
        const offset = Number(new URL(`http://x${path}`).searchParams.get('offset'));
        return offset === 0
          ? { items: page(0, 50), total: 62 }
          : { items: [...page(50, 12), null], total: 62 };
      });
    const lists = await spotify.getPlaylists();
    expect(lists).toHaveLength(62);
    expect(api).toHaveBeenCalledTimes(2);
    expect(lists[0]).toMatchObject({ id: 'spotify:p0', trackCount: 9 });
    expect(lists[1]).toMatchObject({ id: 'spotify:p1', trackCount: 7 });
  });

  it('reads a long playlist page by page', async () => {
    spotify.auth.isAuthenticated = true;
    const entry = (n: number) => ({ item: { id: `t${n}`, name: `Song ${n}`, artists: [] } });
    const api = vi
      .spyOn(spotify as unknown as { apiRequest: (p: string) => Promise<unknown> }, 'apiRequest')
      .mockImplementation(async (path: string) => {
        const offset = Number(new URL(`http://x${path}`).searchParams.get('offset'));
        const n = offset === 200 ? 30 : 100;
        return { items: Array.from({ length: n }, (_, i) => entry(offset + i)), total: 230 };
      });
    const tracks = await spotify.getPlaylistTracks('spotify:long');
    expect(tracks).toHaveLength(230);
    expect(tracks[229]).toMatchObject({ id: 'spotify:t229', title: 'Song 229' });
    expect(api).toHaveBeenCalledTimes(3);
  });

  it('serves a playlist with its tracks', async () => {
    const tracks = vi.spyOn(spotify, 'getPlaylistTracks').mockResolvedValue([
      {
        id: 'spotify:t1',
        title: 'So What',
        albumId: 'spotify:kb',
        albumTitle: 'Kind of Blue',
        artistId: 'spotify:md',
        artistName: 'Miles Davis',
        source: 'spotify',
      },
    ]);
    const res = await request(app).get('/api/providers/spotify/playlists/abc/tracks');
    expect(res.status).toBe(200);
    expect(res.body.data[0].title).toBe('So What');
    expect(tracks).toHaveBeenCalledWith('abc');
  });
});

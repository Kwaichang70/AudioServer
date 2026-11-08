import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { providers } from '../providers/registry.js';
import { deviceManager } from '../devices/manager.js';
import { configureSpotifyLibrary, resetSpotifyLibrary } from '../services/spotify-library.js';
import { stopServerPlayback } from '../services/server-player.js';

/**
 * Spotify albums in the library, added one by one: ordinary library rows
 * (id `spotify:…`), shown without asking Spotify, removed again on request.
 * In a room such an album plays through Spotify Connect, the whole album,
 * from the track that was asked for.
 */
describe('Spotify albums in the library', () => {
  let app: Express;
  let teardown: () => void;
  let key: string;
  let living: string;
  const spotify = providers.spotify;
  const calls: string[] = [];

  const kindOfBlue = {
    album: {
      id: 'spotify:kob',
      title: 'Kind of Blue',
      artistId: 'spotify:md',
      artistName: 'Miles Davis',
      year: 1959,
      coverUrl: 'https://i.scdn.co/image/kob',
      trackCount: 2,
      source: 'spotify' as const,
    },
    tracks: [
      {
        id: 'spotify:t1',
        title: 'So What',
        albumId: 'spotify:kob',
        albumTitle: 'Kind of Blue',
        artistId: 'spotify:md',
        artistName: 'Miles Davis',
        trackNumber: 1,
        discNumber: 1,
        duration: 562,
        source: 'spotify' as const,
      },
      {
        id: 'spotify:t2',
        title: 'Freddie Freeloader',
        albumId: 'spotify:kob',
        albumTitle: 'Kind of Blue',
        artistId: 'spotify:md',
        artistName: 'Miles Davis',
        trackNumber: 2,
        discNumber: 1,
        duration: 586,
        source: 'spotify' as const,
      },
    ],
  };

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    // A local artist of the same name: the Spotify album joins it.
    getRawDb().exec("INSERT INTO artists (id, name) VALUES ('ar-md', 'Miles Davis')");
    configureSpotifyLibrary({ fetchAlbum: async () => kindOfBlue, connected: () => true });
    living = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Woonkamer', deviceId: 'sonos:woonkamer' })
    ).body.data.id;
    key = (await request(app).post('/api/auth/api-keys').send({ name: 'Homey' })).body.data.key;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(() => {
    resetSpotifyLibrary();
    spotify.auth.isAuthenticated = false;
    stopServerPlayback(living);
    teardown();
  });

  it('adds an album as library rows under the artist you already have', async () => {
    const res = await request(app).post('/api/library/spotify/albums/kob');
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      albumId: 'spotify:kob',
      title: 'Kind of Blue',
      artistName: 'Miles Davis',
      trackCount: 2,
    });
    const album = (await request(app).get('/api/library/albums/spotify:kob')).body.data;
    expect(album).toMatchObject({ title: 'Kind of Blue', artistId: 'ar-md', source: 'spotify' });
    const tracks = getRawDb()
      .prepare(
        "SELECT id, availability, source FROM tracks WHERE album_id = 'spotify:kob' ORDER BY track_number",
      )
      .all();
    expect(tracks).toEqual([
      { id: 'spotify:t1', availability: 'streaming', source: 'spotify' },
      { id: 'spotify:t2', availability: 'streaming', source: 'spotify' },
    ]);
    // Adding again refreshes; it does not copy.
    await request(app).post('/api/library/spotify/albums/spotify:kob');
    expect(
      (
        getRawDb().prepare("SELECT COUNT(*) n FROM albums WHERE id = 'spotify:kob'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    const state = await request(app).get('/api/library/spotify/in-library?ids=kob,other');
    expect(state.body.data).toEqual(['spotify:kob']);
  });

  it('plays the library album in a room through Spotify Connect, from a given track', async () => {
    spotify.auth.isAuthenticated = true;
    vi.spyOn(deviceManager, 'getDevices').mockResolvedValue([]);
    vi.spyOn(spotify, 'getConnectDevices').mockResolvedValue([
      { id: 'sonos-wk', name: 'Woonkamer', type: 'Speaker' },
    ]);
    vi.spyOn(spotify, 'getAlbum').mockResolvedValue(kindOfBlue.album);
    vi.spyOn(spotify, 'connectPlayContext').mockImplementation(async (uri, d, offset) => {
      calls.push(`play ${uri} on ${d} offset ${JSON.stringify(offset)}`);
    });
    vi.spyOn(spotify, 'connectSetShuffle').mockResolvedValue();
    const byName = await request(app)
      .post('/api/control/play')
      .set('X-API-Key', key)
      .send({ room: 'Woonkamer', album: 'kind of blue' });
    expect(byName.status).toBe(200);
    expect(byName.body.data).toMatchObject({
      source: 'spotify',
      playing: 'Kind of Blue (Miles Davis)',
    });
    const fromTrack = await request(app)
      .post('/api/control/play')
      .set('X-API-Key', key)
      .send({ room: living, album: 'spotify:kob', startTrack: 'spotify:t2', source: 'spotify' });
    expect(fromTrack.status).toBe(200);
    expect(calls).toEqual([
      'play spotify:album:kob on sonos-wk offset undefined',
      'play spotify:album:kob on sonos-wk offset {"uri":"spotify:track:t2"}',
    ]);
  });

  it('keeps Spotify tracks out of a queue the server plays itself', async () => {
    const res = await request(app)
      .post('/api/control/play')
      .set('X-API-Key', key)
      .send({ room: 'Woonkamer', artist: 'Miles Davis' });
    // The artist has only Spotify tracks: nothing the server itself can play.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('empty');
  });

  it('removes it again, with the artist rows it alone needed', async () => {
    expect((await request(app).delete('/api/library/albums/spotify:kob')).status).toBe(200);
    expect((await request(app).get('/api/library/albums/spotify:kob')).status).toBe(404);
    expect(
      (
        getRawDb()
          .prepare("SELECT COUNT(*) n FROM tracks WHERE album_id = 'spotify:kob'")
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    // The local artist stays.
    expect(getRawDb().prepare("SELECT id FROM artists WHERE id = 'ar-md'").get()).toBeTruthy();
    expect((await request(app).delete('/api/library/albums/spotify:kob')).status).toBe(404);
  });

  it('refuses a bad Spotify id, and says when Spotify is not connected', async () => {
    expect((await request(app).post('/api/library/spotify/albums/not-an-id!')).status).toBe(400);
    configureSpotifyLibrary({ fetchAlbum: async () => kindOfBlue, connected: () => false });
    const res = await request(app).post('/api/library/spotify/albums/kob');
    expect(res.status).toBe(409);
    configureSpotifyLibrary({ fetchAlbum: async () => kindOfBlue, connected: () => true });
  });
});

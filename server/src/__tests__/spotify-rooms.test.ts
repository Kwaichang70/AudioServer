import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { providers } from '../providers/registry.js';
import type { SpotifyConnectDevice, SpotifyPlaybackState } from '../providers/spotify.js';
import { deviceManager } from '../devices/manager.js';
import { zones } from '../services/zones.js';
import { stopServerPlayback } from '../services/server-player.js';
import {
  onSpotifyRoomsChanged,
  pickConnectDevice,
  refreshSpotifyRooms,
} from '../services/spotify-rooms.js';

/**
 * Spotify in a room, started by the server (step 8): "play my Spotify playlist
 * Discover Weekly in the Woonkamer" from Homey or Grok. The room's speaker is
 * found among Spotify's Connect devices by name and told to play; while it
 * plays Spotify, the room's pause, skip, volume and now-playing go to Spotify.
 */

const dev = (id: string, name: string, extra: Partial<SpotifyConnectDevice> = {}) => ({
  id,
  name,
  type: 'Speaker',
  ...extra,
});

describe('pickConnectDevice', () => {
  const devices = [
    dev('s1', 'Woonkamer'),
    dev('s2', 'Keuken'),
    dev('c1', 'CocktailAudio X45 Pro'),
    dev('p1', "Danny's iPhone", { type: 'Smartphone' }),
  ];

  it('takes the exact name of the room or the speaker first', () => {
    expect(pickConnectDevice(['Woonkamer', 'Sonos One'], devices)).toMatchObject({ id: 's1' });
    expect(pickConnectDevice(['Living', 'keuken'], devices)).toMatchObject({ id: 's2' });
  });

  it('then a name inside the other, then shared words', () => {
    expect(pickConnectDevice(['Hifi', 'CocktailAudio X45'], devices)).toMatchObject({ id: 'c1' });
    expect(pickConnectDevice(['Hifi', 'X45 streamer'], devices)).toMatchObject({ id: 'c1' });
  });

  it('refuses to guess between two, and says nothing when nothing fits', () => {
    expect(pickConnectDevice(['Sonos'], [dev('a', 'Sonos Keuken'), dev('b', 'Sonos Bad')])).toBe(
      'ambiguous',
    );
    expect(pickConnectDevice(['Zolder'], devices)).toBeNull();
  });

  it('skips devices that cannot be controlled remotely', () => {
    expect(
      pickConnectDevice(['Woonkamer'], [dev('s1', 'Woonkamer', { is_restricted: true })]),
    ).toBeNull();
  });
});

describe('Spotify in a room', () => {
  let app: Express;
  let teardown: () => void;
  let key: string;
  let living: string;
  let playback: SpotifyPlaybackState | null;
  const spotify = providers.spotify;
  const calls: string[] = [];

  const control = (method: 'get' | 'post', path: string) =>
    request(app)[method](`/api/control${path}`).set('X-API-Key', key);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    getRawDb().exec(`
      INSERT INTO artists (id, name) VALUES ('ar-p', 'Prince');
      INSERT INTO albums (id, title, artist_id, artist_name, year) VALUES ('al-1', 'Purple Rain', 'ar-p', 'Prince', 1984);
      INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, disc_number, track_number, duration, file_path)
        VALUES ('t-1', 'Let''s Go Crazy', 'al-1', 'Purple Rain', 'ar-p', 'Prince', 1, 1, 280, '/m/1');
    `);
    living = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Woonkamer', deviceId: 'sonos:woonkamer' })
    ).body.data.id;
    key = (await request(app).post('/api/auth/api-keys').send({ name: 'Homey' })).body.data.key;
  });

  beforeEach(() => {
    calls.length = 0;
    playback = null;
    spotify.auth.isAuthenticated = true;
    vi.spyOn(deviceManager, 'getDevices').mockResolvedValue([]);
    vi.spyOn(deviceManager, 'stop').mockResolvedValue();
    vi.spyOn(deviceManager, 'setVolume').mockResolvedValue();
    vi.spyOn(spotify, 'getConnectDevices').mockResolvedValue([
      dev('sonos-wk', 'Woonkamer'),
      dev('cocktail', 'CocktailAudio X45'),
    ]);
    vi.spyOn(spotify, 'getPlaylists').mockResolvedValue([
      { id: 'spotify:pl1', name: 'Discover Weekly', trackCount: 30, source: 'spotify' },
      { id: 'spotify:pl2', name: 'Zondag Jazz', trackCount: 12, source: 'spotify' },
    ]);
    vi.spyOn(spotify, 'search').mockResolvedValue({
      artists: [{ id: 'spotify:ar9', name: 'Prince', source: 'spotify' }],
      albums: [
        {
          id: 'spotify:al8',
          title: 'Purple Rain (Deluxe)',
          artistId: 'spotify:ar9',
          artistName: 'Prince',
          source: 'spotify',
        },
        {
          id: 'spotify:al7',
          title: 'Purple Rain',
          artistId: 'spotify:ar9',
          artistName: 'Prince',
          trackCount: 9,
          source: 'spotify',
        },
      ],
      tracks: [],
      playlists: [],
    });
    vi.spyOn(spotify, 'connectPlayContext').mockImplementation(async (uri, device, offset) => {
      calls.push(`play ${uri} on ${device} offset ${JSON.stringify(offset)}`);
      playback = {
        is_playing: true,
        progress_ms: 61_000,
        device: dev(device!, 'Woonkamer', { volume_percent: 35 }),
        item: {
          id: 'x',
          name: 'Blue in Green',
          artists: [{ id: 'm', name: 'Miles Davis' }],
          album: { id: 'kb', name: 'Kind of Blue' },
        } as SpotifyPlaybackState['item'],
      };
    });
    vi.spyOn(spotify, 'connectSetShuffle').mockImplementation(async (on) => {
      calls.push(`shuffle ${on}`);
    });
    vi.spyOn(spotify, 'getPlaybackState').mockImplementation(async () => playback);
    vi.spyOn(spotify, 'connectPause').mockImplementation(async (d) => {
      calls.push(`pause ${d}`);
    });
    vi.spyOn(spotify, 'connectResume').mockImplementation(async (d) => {
      calls.push(`resume ${d}`);
    });
    vi.spyOn(spotify, 'connectNext').mockImplementation(async (d) => {
      calls.push(`next ${d}`);
    });
    vi.spyOn(spotify, 'connectSetVolume').mockImplementation(async (v, d) => {
      calls.push(`volume ${v} ${d}`);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(() => {
    spotify.auth.isAuthenticated = false;
    stopServerPlayback(living);
    teardown();
  });

  it('lists the Spotify playlists after the library ones', async () => {
    const lists = (await control('get', '/playlists')).body.data;
    expect(lists).toEqual(
      expect.arrayContaining([
        { name: 'Discover Weekly', trackCount: 30, kind: 'spotify' },
        { name: 'Zondag Jazz', trackCount: 12, kind: 'spotify' },
      ]),
    );
  });

  it('plays a Spotify playlist on the room speaker through Spotify Connect', async () => {
    const res = await control('post', '/play').send({
      room: 'woonkamer',
      playlist: 'zondag',
      source: 'spotify',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      room: 'Woonkamer',
      playing: 'Zondag Jazz',
      source: 'spotify',
      speaker: 'Woonkamer',
    });
    expect(calls).toEqual([
      'play spotify:playlist:pl2 on sonos-wk offset undefined',
      'shuffle false',
    ]);
  });

  it('takes a room and a playlist by id too, as the playlist page sends them', async () => {
    const res = await control('post', '/play').send({
      room: living,
      playlist: 'spotify:pl1',
      source: 'spotify',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.playing).toBe('Discover Weekly');
    expect(calls[0]).toBe('play spotify:playlist:pl1 on sonos-wk offset undefined');
  });

  it('lets go of the speaker first when AudioServer was playing there', async () => {
    await control('post', '/play').send({ room: 'Woonkamer', album: 'Purple Rain' });
    expect(zones.sessionFor(living).getState().state).toBe('playing');
    await control('post', '/play').send({
      room: 'Woonkamer',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    expect(deviceManager.stop).toHaveBeenCalledWith('sonos:woonkamer');
    expect(zones.sessionFor(living).getState().state).toBe('stopped');
  });

  it('picks the album with the exact title, and starts a shuffled one anywhere', async () => {
    const res = await control('post', '/play').send({
      room: 'Woonkamer',
      album: 'Purple Rain',
      artist: 'Prince',
      shuffle: true,
      source: 'spotify',
    });
    expect(res.body.data.playing).toBe('Purple Rain (Prince)');
    expect(calls[0]).toMatch(/^play spotify:album:al7 on sonos-wk offset [0-8]$/);
    expect(calls[1]).toBe('shuffle true');
  });

  it('then sends pause, next, volume and now-playing to Spotify', async () => {
    await control('post', '/play').send({ room: 'Woonkamer', artist: 'prince', source: 'spotify' });
    expect(calls[0]).toBe('play spotify:artist:ar9 on sonos-wk offset undefined');
    calls.length = 0;

    const now = (await control('get', '/now-playing?room=Woonkamer')).body.data;
    expect(now).toMatchObject({
      room: 'Woonkamer',
      source: 'spotify',
      state: 'playing',
      track: { title: 'Blue in Green', artist: 'Miles Davis', album: 'Kind of Blue' },
      position: 61,
      volume: 35,
    });
    await control('post', '/pause').send({ room: 'Woonkamer' });
    await control('post', '/next').send({ room: 'Woonkamer' });
    await control('post', '/volume').send({ room: 'Woonkamer', volume: 20 });
    expect(calls).toEqual(['pause sonos-wk', 'next sonos-wk', 'volume 20 sonos-wk']);
    expect(deviceManager.setVolume).not.toHaveBeenCalled();
  });

  it('lets the room go when Spotify has moved elsewhere, or AudioServer took it back', async () => {
    await control('post', '/play').send({
      room: 'Woonkamer',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    playback = { ...playback!, device: dev('phone', "Danny's iPhone") };
    const now = (await control('get', '/now-playing?room=Woonkamer')).body.data;
    expect(now.source).toBeUndefined();

    await control('post', '/play').send({
      room: 'Woonkamer',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    await control('post', '/play').send({ room: 'Woonkamer', album: 'Purple Rain' });
    calls.length = 0;
    await control('post', '/pause').send({ room: 'Woonkamer' });
    expect(calls).toEqual([]);
  });

  it('shows the room as playing Spotify, with the track once Spotify reports it', async () => {
    const notified = vi.fn();
    onSpotifyRoomsChanged(notified);
    await control('post', '/play').send({
      room: 'Woonkamer',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    const zoneOf = async () =>
      (await request(app).get('/api/playback/zones')).body.data.find(
        (z: { id: string }) => z.id === living,
      );
    expect((await zoneOf()).spotify).toEqual({
      state: 'playing',
      track: null,
      speaker: 'Woonkamer',
      playing: 'Zondag Jazz',
    });
    await refreshSpotifyRooms();
    expect((await zoneOf()).spotify.track).toEqual({
      title: 'Blue in Green',
      artistName: 'Miles Davis',
      albumTitle: 'Kind of Blue',
    });
    expect(notified).toHaveBeenCalled();
    const rooms = (await control('get', '/rooms')).body.data;
    expect(rooms.find((r: { name: string }) => r.name === 'Woonkamer')).toMatchObject({
      source: 'spotify',
      state: 'playing',
      track: { title: 'Blue in Green' },
    });

    // Spotify moved to the phone: the room is no longer a Spotify room.
    notified.mockClear();
    playback = { ...playback!, device: dev('phone', "Danny's iPhone") };
    await refreshSpotifyRooms();
    expect((await zoneOf()).spotify).toBeNull();
    expect(notified).toHaveBeenCalledTimes(1);
    onSpotifyRoomsChanged(() => {});
  });

  it('lets the previous room go when Spotify starts in another', async () => {
    const hifi = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'CocktailAudio X45', deviceId: 'dlna:cocktail' })
    ).body.data.id;
    await control('post', '/play').send({
      room: 'Woonkamer',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    await control('post', '/play').send({
      room: 'CocktailAudio X45',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    const all = (await request(app).get('/api/playback/zones')).body.data;
    expect(all.find((z: { id: string }) => z.id === living).spotify).toBeNull();
    expect(all.find((z: { id: string }) => z.id === hifi).spotify.speaker).toBe(
      'CocktailAudio X45',
    );
    await control('post', '/stop').send({ room: 'CocktailAudio X45' });
    stopServerPlayback(hifi);
  });

  it('moves Spotify to another room: Spotify hands over, the rooms follow', async () => {
    const hifi = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'CocktailAudio X45', deviceId: 'dlna:cocktail' })
    ).body.data.id;
    const transfer = vi.spyOn(spotify, 'connectTransferPlayback').mockImplementation(async (d) => {
      calls.push(`transfer ${d}`);
      playback = { ...playback!, device: dev(d, 'CocktailAudio X45') };
    });
    await control('post', '/play').send({
      room: 'Woonkamer',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    const res = await request(app)
      .post('/api/playback/transfer')
      .set('X-Client-Id', 'spotify-test')
      .set('X-Zone-Id', living)
      .send({ toZoneId: hifi });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      trackId: 'spotify:x',
      position: 61,
      resumedAtPosition: true,
      note: 'Spotify continues on CocktailAudio X45.',
    });
    expect(transfer).toHaveBeenCalledWith('cocktail');
    const all = (await request(app).get('/api/playback/zones')).body.data;
    expect(all.find((z: { id: string }) => z.id === living).spotify).toBeNull();
    expect(all.find((z: { id: string }) => z.id === hifi).spotify).toMatchObject({
      speaker: 'CocktailAudio X45',
      playing: 'Zondag Jazz',
      track: { title: 'Blue in Green' },
    });
    calls.length = 0;
    await control('post', '/pause').send({ room: 'CocktailAudio X45' });
    expect(calls).toEqual(['pause cocktail']);
    stopServerPlayback(hifi);
  });

  it('says which Spotify devices exist when the speaker is not among them', async () => {
    const kitchen = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Zolder', deviceId: 'dlna:zolder' })
    ).body.data.id;
    const res = await control('post', '/play').send({
      room: 'Zolder',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    expect(res.status).toBe(404);
    expect(res.body.options).toEqual(['Woonkamer', 'CocktailAudio X45']);
    expect(res.body.message).toMatch(/Spotify does not see the speaker of "Zolder"/);
    stopServerPlayback(kitchen);
  });

  it('asks to connect Spotify when it is not', async () => {
    spotify.auth.isAuthenticated = false;
    const res = await control('post', '/play').send({
      room: 'Woonkamer',
      playlist: 'Zondag Jazz',
      source: 'spotify',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Spotify is not connected/);
  });
});

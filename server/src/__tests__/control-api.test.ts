import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { zones } from '../services/zones.js';
import { getActiveServerDevice, stopServerPlayback } from '../services/server-player.js';
import { deviceManager } from '../devices/manager.js';

/**
 * Simple commands by name for Homey, Grok and Jarvis (step 2): "play the
 * playlist Zondagochtend in the Woonkamer" works with an API key, finds names
 * without case or accents, says which names exist when one is wrong, and
 * drives the speaker as well as the session.
 */

describe('Control API', () => {
  let app: Express;
  let teardown: () => void;
  let key: string;
  let living: string;
  let kitchen: string;

  const control = (method: 'get' | 'post', path: string) =>
    request(app)[method](`/api/control${path}`).set('X-API-Key', key);

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar-p', 'Prince'), ('ar-b', 'Björk');
      INSERT INTO albums (id, title, artist_id, artist_name, year) VALUES
        ('al-1', 'Purple Rain', 'ar-p', 'Prince', 1984),
        ('al-2', 'Sign o'' the Times', 'ar-p', 'Prince', 1987),
        ('al-3', 'Homogenic', 'ar-b', 'Björk', 1997);
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, disc_number, track_number, duration, file_path)
       SELECT ?, ?, a.id, a.title, a.artist_id, a.artist_name, 1, ?, 200, '/m/' || ? FROM albums a WHERE a.id = ?`,
    );
    for (const [album, n] of [
      ['al-1', 3],
      ['al-2', 2],
      ['al-3', 2],
    ] as const) {
      for (let i = 1; i <= n; i++)
        track.run(`${album}-${i}`, `${album} track ${i}`, i, `${album}-${i}`, album);
    }
    living = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Woonkamer', deviceId: 'dlna:cocktail' })
    ).body.data.id;
    kitchen = (
      await request(app)
        .post('/api/playback/zones')
        .send({ name: 'Keuken', deviceId: 'sonos:keuken' })
    ).body.data.id;
    const pl = (await request(app).post('/api/playlists').send({ name: 'Zondagochtend' })).body
      .data;
    for (const id of ['al-3-1', 'al-1-2']) {
      await request(app).post(`/api/playlists/${pl.id}/tracks`).send({ trackId: id });
    }
    key = (await request(app).post('/api/auth/api-keys').send({ name: 'Homey' })).body.data.key;
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(() => {
    stopServerPlayback(living);
    stopServerPlayback(kitchen);
    teardown();
  });

  it('lists the rooms and the playlists, for whoever builds the flow', async () => {
    const rooms = (await control('get', '/rooms')).body.data;
    expect(rooms.map((r: { name: string }) => r.name)).toEqual(
      expect.arrayContaining(['Woonkamer', 'Keuken']),
    );
    const lists = (await control('get', '/playlists')).body.data;
    expect(lists).toEqual([expect.objectContaining({ name: 'Zondagochtend', kind: 'playlist' })]);
  });

  it('plays a playlist by name in a room, whatever the case', async () => {
    const res = await control('post', '/play').send({
      room: 'woonkamer',
      playlist: 'zondagochtend',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ room: 'Woonkamer', playing: 'Zondagochtend', tracks: 2 });
    const session = zones.sessionFor(living);
    expect(session.getQueue().map((e) => e.trackId)).toEqual(['al-3-1', 'al-1-2']);
    expect(session.getState().state).toBe('playing');
    // The server drives the speaker from now on, also with no app open.
    expect(getActiveServerDevice(living)).toBe('dlna:cocktail');
  });

  it('plays an album or an artist, accents optional', async () => {
    const album = await control('post', '/play').send({ room: 'Keuken', album: 'purple' });
    expect(album.body.data).toMatchObject({ playing: 'Purple Rain (Prince)', tracks: 3 });
    const artist = await control('post', '/play').send({ room: 'Keuken', artist: 'bjork' });
    expect(artist.body.data).toMatchObject({ playing: 'Björk', tracks: 2 });
    // An artist plays album by album, oldest first.
    const prince = await control('post', '/play').send({ room: 'Keuken', artist: 'Prince' });
    expect(
      zones
        .sessionFor(kitchen)
        .getQueue()
        .map((e) => e.trackId),
    ).toEqual(['al-1-1', 'al-1-2', 'al-1-3', 'al-2-1', 'al-2-2']);
    expect(prince.status).toBe(200);
  });

  it('says what exists when a name is wrong, unclear or missing', async () => {
    const unknown = await control('post', '/play').send({
      room: 'Zolder',
      playlist: 'Zondagochtend',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.options).toEqual(expect.arrayContaining(['Woonkamer', 'Keuken']));
    const noRoom = await control('post', '/play').send({ playlist: 'Zondagochtend' });
    expect(noRoom.status).toBe(400);
    expect(noRoom.body.error).toBe('room_required');
    const unclear = await control('post', '/play').send({ room: 'Keuken', album: 'i' });
    expect(unclear.status).toBe(409);
    expect(unclear.body.error).toBe('ambiguous');
    const browser = await control('post', '/play').send({
      room: 'Browser',
      playlist: 'Zondagochtend',
    });
    expect(browser.status).toBe(409);
    expect(browser.body.error).toBe('not_playable');
  });

  it('pauses and sets the volume on the speaker itself, not just in the app', async () => {
    const pause = vi.spyOn(deviceManager, 'pause').mockResolvedValue();
    const volume = vi.spyOn(deviceManager, 'setVolume').mockResolvedValue();
    await control('post', '/play').send({ room: 'Woonkamer', playlist: 'Zondagochtend' });
    const paused = await control('post', '/pause').send({ room: 'Woonkamer' });
    expect(paused.body.data).toEqual({ room: 'Woonkamer', state: 'paused' });
    expect(pause).toHaveBeenCalledWith('dlna:cocktail');
    expect(zones.sessionFor(living).getState().state).toBe('paused');
    const vol = await control('post', '/volume').send({ room: 'Woonkamer', volume: 30 });
    expect(vol.body.data).toEqual({ room: 'Woonkamer', volume: 30 });
    expect(volume).toHaveBeenCalledWith('dlna:cocktail', 30);
    const now = (await control('get', '/now-playing?room=Woonkamer')).body.data;
    expect(now).toMatchObject({ room: 'Woonkamer', state: 'paused', volume: 30 });
    expect(now.track.title).toBe('al-3 track 1');
  });

  it('skips and stops', async () => {
    const stopDevice = vi.spyOn(deviceManager, 'stop').mockResolvedValue();
    await control('post', '/play').send({ room: 'Woonkamer', playlist: 'Zondagochtend' });
    const next = await control('post', '/next').send({ room: 'Woonkamer' });
    expect(next.body.data.track).toBe('al-1 track 2');
    const stop = await control('post', '/stop').send({ room: 'Woonkamer' });
    expect(stop.body.data.state).toBe('stopped');
    expect(stopDevice).toHaveBeenCalledWith('dlna:cocktail');
  });
});

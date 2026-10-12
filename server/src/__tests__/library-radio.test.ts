import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { zones } from '../services/zones.js';
import {
  RECENT_WINDOW,
  configureRadio,
  getRadioState,
  pickRadioTracks,
  recentlyHeard,
  resetRadio,
  resolveSeed,
  setRadio,
  topUp,
} from '../services/library-radio.js';
import { initLibraryRadio } from '../services/radio-wiring.js';

/**
 * Radio per zone (R08.1, tests of R08.4): related music after the queue,
 * with a reason; never an unplayable item, nothing again within 50, and a
 * clean stop when the library has nothing left.
 */

const ZONE = 'zone-browser';

describe('Radio', () => {
  let app: Express;
  let teardown: () => void;
  let unobserve: () => void;
  const announced: Array<{ zoneId: string; note?: string }> = [];

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    const db = getRawDb();
    const artist = db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)');
    const album = db.prepare(
      'INSERT INTO albums (id, title, artist_id, artist_name, genre) VALUES (?, ?, ?, ?, ?)',
    );
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, track_number, duration, file_path, availability)
       VALUES (?, ?, ?, ?, ?, ?, ?, 200, ?, ?)`,
    );
    // Twelve jazz artists with an album of ten tracks each; Miles Davis the seed.
    const jazz = [
      'Miles Davis',
      'John Coltrane',
      'Bill Evans',
      'Herbie Hancock',
      'Wayne Shorter',
      'Chet Baker',
      'Thelonious Monk',
      'Sonny Rollins',
      'Art Blakey',
      'Cannonball Adderley',
      'Dexter Gordon',
      'Lee Morgan',
    ];
    jazz.forEach((name, i) => {
      artist.run(`ar-${i}`, name);
      album.run(`al-${i}`, `${name} Album`, `ar-${i}`, name, 'Jazz');
      for (let n = 1; n <= 10; n++) {
        track.run(
          `t-${i}-${n}`,
          `Tune ${n}`,
          `al-${i}`,
          `${name} Album`,
          `ar-${i}`,
          name,
          n,
          `/m/${i}/${n}.flac`,
          n === 10 ? 'missing' : 'available',
        );
      }
    });
    // A Qobuz title Qobuz withdrew: never chosen either.
    track.run(
      'qobuz:9',
      'Withdrawn',
      'al-1',
      'John Coltrane Album',
      'ar-1',
      'John Coltrane',
      11,
      null,
      'unavailable',
    );
    // Unrelated: never chosen for a jazz seed.
    artist.run('ar-metal', 'Metallica');
    album.run('al-metal', 'Master of Puppets', 'ar-metal', 'Metallica', 'Metal');
    track.run(
      't-metal',
      'Battery',
      'al-metal',
      'Master of Puppets',
      'ar-metal',
      'Metallica',
      1,
      '/m/metal.flac',
      'available',
    );
    // A tiny world with nothing related, for the clean stop.
    artist.run('ar-alone', 'Lonely Artist');
    album.run('al-alone', 'Alone', 'ar-alone', 'Lonely Artist', null);
    track.run(
      't-alone',
      'Only Song',
      'al-alone',
      'Alone',
      'ar-alone',
      'Lonely Artist',
      1,
      '/m/alone.flac',
      'available',
    );

    configureRadio({
      similarAvailable: () => true,
      similar: async (name) =>
        name === 'Miles Davis'
          ? [{ name: 'John Coltrane', match: 0.9, localArtistId: 'ar-1' }]
          : [],
    });
    unobserve = initLibraryRadio((zoneId, state) => announced.push({ zoneId, note: state.note }));
  });

  beforeEach(() => {
    announced.length = 0;
    getRawDb().exec('DELETE FROM radio_picks; DELETE FROM zone_radio;');
    zones.sessionFor(ZONE).setQueue([]);
  });

  afterAll(() => {
    unobserve();
    resetRadio();
    teardown();
  });

  const miles = () => resolveSeed('artist', 'ar-0', null)!;

  it('picks related, playable tracks with a reason, never the unrelated or unplayable', async () => {
    const picks = await pickRadioTracks(miles(), { count: 10, exclude: new Set(), userId: null });
    expect(picks).toHaveLength(10);
    const ids = picks.map((p) => p.track.id);
    expect(ids).not.toContain('t-metal');
    expect(ids).not.toContain('qobuz:9');
    expect(ids.some((id) => id.endsWith('-10'))).toBe(false); // missing files
    const coltrane = picks.find((p) => p.track.artistName === 'John Coltrane');
    expect(coltrane?.why).toBe('Related to Miles Davis (Last.fm) · genre Jazz');
    expect(picks.every((p) => p.why.length > 0)).toBe(true);
  });

  it('keeps variety: at most two per artist, never the same artist twice in a row', async () => {
    const picks = await pickRadioTracks(miles(), { count: 10, exclude: new Set(), userId: null });
    const perArtist = new Map<string, number>();
    picks.forEach((p, i) => {
      perArtist.set(p.track.artistName, (perArtist.get(p.track.artistName) ?? 0) + 1);
      if (i > 0) expect(p.track.artistName).not.toBe(picks[i - 1].track.artistName);
    });
    expect(Math.max(...perArtist.values())).toBeLessThanOrEqual(2);
  });

  it('tops up a zone before its queue runs out, and repeats nothing within 50', async () => {
    setRadio(ZONE, true, miles(), null);
    const seen: string[] = [];
    // Twelve top-ups of five: sixty picks from 108 playable jazz tracks.
    for (let i = 0; i < 12; i++) {
      const picks = await topUp(ZONE, 0);
      expect(picks.length).toBeGreaterThan(0);
      seen.push(...picks.map((p) => p.track.id));
    }
    for (let i = 0; i < seen.length; i++) {
      const window = seen.slice(Math.max(0, i - RECENT_WINDOW), i);
      expect(window).not.toContain(seen[i]);
    }
    // They went into the zone's queue.
    expect(zones.sessionFor(ZONE).getQueue().length).toBe(60);
    expect(Object.keys(getRadioState(ZONE).reasons)).toHaveLength(60);
  });

  it('does not top up while enough is queued, or when radio is off', async () => {
    setRadio(ZONE, true, miles(), null);
    expect(await topUp(ZONE, 3)).toEqual([]);
    setRadio(ZONE, false, null, null);
    expect(await topUp(ZONE, 0)).toEqual([]);
  });

  it('stops cleanly when the library has nothing left, and says so', async () => {
    setRadio(ZONE, true, resolveSeed('artist', 'ar-alone', null), null);
    // The one song is the seed's own: once it has been played, nothing is left.
    const exclude = recentlyHeard(ZONE, ['t-alone'], null);
    expect(exclude.has('t-alone')).toBe(true);
    zones
      .sessionFor(ZONE)
      .setQueue([
        { id: 't-alone', title: 'Only Song', artistName: 'Lonely Artist', albumTitle: 'Alone' },
      ]);
    expect(await topUp(ZONE, 0)).toEqual([]);
    expect(announced.at(-1)?.note).toMatch(/nothing new/);
  });

  it('follows what is playing when switched on without a seed', async () => {
    zones.sessionFor(ZONE).setQueue([
      {
        id: 't-0-1',
        title: 'Tune 1',
        artistName: 'Miles Davis',
        albumTitle: 'Miles Davis Album',
      },
    ]);
    zones.sessionFor(ZONE).playItem(zones.sessionFor(ZONE).getQueue()[0].itemId, {
      clientId: null,
      sessionId: null,
      server: true,
    });
    setRadio(ZONE, true, null, null);
    const picks = await topUp(ZONE, 0);
    expect(picks.length).toBeGreaterThan(0);
  });

  it('plays on after the last track of an album: a track start near the end fills the queue', async () => {
    const session = zones.sessionFor(ZONE);
    session.setQueue([
      {
        id: 't-0-1',
        title: 'Tune 1',
        artistName: 'Miles Davis',
        albumTitle: 'Miles Davis Album',
        albumId: 'al-0',
      },
      {
        id: 't-0-2',
        title: 'Tune 2',
        artistName: 'Miles Davis',
        albumTitle: 'Miles Davis Album',
        albumId: 'al-0',
      },
    ]);
    setRadio(ZONE, true, null, null);
    session.playItem(session.getQueue()[0].itemId, {
      clientId: null,
      sessionId: null,
      server: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const queue = session.getQueue();
    expect(queue.length).toBeGreaterThan(2);
    // What came after the album is radio, and each says why.
    const reasons = getRadioState(ZONE).reasons;
    expect(queue.slice(2).every((entry) => reasons[entry.trackId])).toBe(true);
  });

  describe('API', () => {
    const client = (r: request.Test) => r.set('X-Client-Id', 'radio-test');

    it('"Start radio" from an artist gives ten tracks with reasons within two seconds', async () => {
      const started = Date.now();
      const res = await client(request(app).post('/api/playback/radio/start')).send({
        seed: { type: 'artist', id: 'ar-0' },
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.status).toBe(200);
      expect(res.body.data.tracks).toHaveLength(10);
      expect(res.body.data.tracks.every((t: { why: string }) => t.why)).toBe(true);
      expect(res.body.data.radio).toMatchObject({
        enabled: true,
        seed: { type: 'artist', label: 'Miles Davis' },
      });
      const state = await request(app).get('/api/playback/radio');
      expect(state.body.data.enabled).toBe(true);
    });

    it('answers 409 when nothing is close enough, and 404 for an unknown seed', async () => {
      // Lonely Artist's one song was played recently.
      getRawDb()
        .prepare(
          `INSERT INTO listening_sessions (id, track_id, title, artist_name, started_at, status, qualified, user_id)
           SELECT 'ls-alone', 't-alone', 'x', 'x', 1, 'ended', 1, id FROM users WHERE username = 'admin'`,
        )
        .run();
      const empty = await client(request(app).post('/api/playback/radio/start')).send({
        seed: { type: 'artist', id: 'ar-alone' },
      });
      expect(empty.status).toBe(409);
      const unknown = await client(request(app).post('/api/playback/radio/start')).send({
        seed: { type: 'artist', id: 'nope' },
      });
      expect(unknown.status).toBe(404);
    });

    it('switches radio on and off; a queue you pick yourself drops the seed', async () => {
      await client(request(app).post('/api/playback/radio/start')).send({
        seed: { type: 'artist', id: 'ar-0' },
      });
      await client(request(app).post('/api/playback/queue/set')).send({
        tracks: [
          {
            id: 't-metal',
            title: 'Battery',
            artistName: 'Metallica',
            albumTitle: 'Master of Puppets',
          },
        ],
      });
      expect(getRadioState(ZONE)).toMatchObject({ enabled: true, seed: null });
      const off = await client(request(app).post('/api/playback/radio')).send({ enabled: false });
      expect(off.body.data.enabled).toBe(false);
    });
  });
});

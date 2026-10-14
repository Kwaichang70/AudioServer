import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestApp, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import {
  configureOutputCapabilities,
  forgetCapabilities,
} from '../services/output-capabilities.js';
import {
  configureTranscode,
  ffmpegArgs,
  planTranscode,
  resetTranscode,
} from '../services/transcode.js';
import { replayGainFor, setLeveling } from '../services/zone-audio.js';
import { describeAudioPath } from '../services/audio-path.js';
import { PlaybackService } from '../services/playback.js';

/**
 * Volume leveling on the speaker path (R10.2): ReplayGain from the library,
 * applied by ffmpeg only where the file is converted anyway, or where a room
 * asks for it — and then the audio path says the result is not bit-perfect.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ctx = (zoneId: string, trackId = 'loud') => ({ zoneId, trackId });

describe('Volume leveling for speakers', () => {
  let app: Express;
  let teardown: () => void;
  let member: TestUser;
  let dir: string;

  const speaker = (formats: string[]) =>
    configureOutputCapabilities({
      listDevices: async () => [{ id: 'dlna:amp', name: 'Amp', type: 'dlna' }],
      controllerFor: () => ({
        getSupportedActions: async () => ['Play', 'Seek'],
        getSupportedFormats: async () => formats,
      }),
      measuredGapFor: () => undefined,
      measurementsFor: () => 0,
    });

  beforeAll(async () => {
    const c = await createTestApp();
    app = c.app;
    teardown = c.teardown;
    member = c.member!;
    dir = mkdtempSync(join(tmpdir(), 'audioserver-level-'));
    const file = join(dir, 'loud.flac');
    if (hasFfmpeg) {
      spawnSync('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-ar',
        '44100',
        '-sample_fmt',
        's16',
        file,
      ]);
    } else {
      writeFileSync(file, 'x');
    }
    const db = getRawDb();
    db.exec(`
      INSERT INTO artists (id, name) VALUES ('ar-l', 'L');
      INSERT INTO albums (id, title, artist_id, artist_name, replay_gain_album, replay_gain_album_peak)
        VALUES ('al-loud', 'Loud', 'ar-l', 'L', -8.5, 0.5),
               ('al-none', 'No album gain', 'ar-l', 'L', NULL, NULL);
    `);
    const track = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path, duration, format, sample_rate, bit_depth, replay_gain_track, replay_gain_track_peak)
       VALUES (?, ?, ?, 'x', 'ar-l', 'L', ?, 3, 'flac', 44100, 16, ?, ?)`,
    );
    track.run('loud', 'Loud', 'al-loud', file, -6, 0.9);
    track.run('single', 'Single', 'al-none', file, -4, 0.9);
    track.run('quiet', 'Quiet', 'al-none', file, 9, 0.7);
    track.run('bare', 'No gain', 'al-none', file, null, null);
  });

  afterEach(() => {
    forgetCapabilities();
    resetTranscode();
  });

  afterAll(() => {
    teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes album gain, falls back to track gain, and never lets a peak clip', () => {
    expect(replayGainFor('loud', 'album')).toEqual({
      gainDb: -8.5,
      basis: 'album',
      limitedByPeak: false,
    });
    expect(replayGainFor('loud', 'track')).toMatchObject({ gainDb: -6, basis: 'track' });
    expect(replayGainFor('single', 'album')).toMatchObject({ gainDb: -4, basis: 'track' });
    // +9 dB would push a 0.7 peak over full scale: held at +3.1 dB.
    expect(replayGainFor('quiet', 'track')).toEqual({
      gainDb: 3.1,
      basis: 'track',
      limitedByPeak: true,
    });
    expect(replayGainFor('bare', 'track')).toBeNull();
  });

  it("levels by default only what is converted anyway ('auto')", async () => {
    configureTranscode({ ffmpegAvailable: async () => true });
    speaker(['audio/mpeg']);
    const converted = await planTranscode('audio/flac', 'dlna:amp', ctx('zone-auto'));
    expect(converted).toMatchObject({ target: 'mp3', gain: { gainDb: -8.5, basis: 'album' } });
    forgetCapabilities();
    speaker(['audio/flac']);
    expect(await planTranscode('audio/flac', 'dlna:amp', ctx('zone-auto'))).toBeNull();
  });

  it("'off' converts what must be converted, without touching the level", async () => {
    configureTranscode({ ffmpegAvailable: async () => true });
    speaker(['audio/mpeg']);
    setLeveling('zone-off', 'off');
    const plan = await planTranscode('audio/flac', 'dlna:amp', ctx('zone-off'));
    expect(plan?.target).toBe('mp3');
    expect(plan?.gain).toBeUndefined();
  });

  it("'track' levels a FLAC the speaker takes, and keeps it FLAC", async () => {
    configureTranscode({ ffmpegAvailable: async () => true });
    speaker(['audio/flac', 'audio/mpeg']);
    setLeveling('zone-track', 'track');
    const plan = await planTranscode('audio/flac', 'dlna:amp', ctx('zone-track'));
    expect(plan).toMatchObject({ target: 'flac', to: 'audio/flac', gain: { gainDb: -6 } });
    expect(plan?.reason).toMatch(/Volume leveling is on for this room/);
    // Without ReplayGain there is nothing to level, so nothing is converted.
    expect(await planTranscode('audio/flac', 'dlna:amp', ctx('zone-track', 'bare'))).toBeNull();
  });

  it('dithers back to 16 bit after a gain change, not for MP3 or 24 bit', () => {
    const flac16 = ffmpegArgs('/a.flac', 'flac', { bitDepth: 16, gainDb: -6 });
    expect(flac16).toContain('volume=-6.00dB,aresample=osf=s16:dither_method=triangular');
    expect(ffmpegArgs('/a.flac', 'mp3', { gainDb: -6 })).toContain('volume=-6.00dB');
    expect(ffmpegArgs('/a.flac', 'flac', { bitDepth: 24, gainDb: -6 })).toContain('volume=-6.00dB');
    expect(ffmpegArgs('/a.flac', 'flac', { bitDepth: 16 })).not.toContain('-af');
  });

  it('says in the audio path that leveling makes the path not bit-perfect', async () => {
    configureTranscode({ ffmpegAvailable: async () => true });
    speaker(['audio/flac']);
    setLeveling('zone-path-level', 'album');
    const session = new PlaybackService('zone-path-level');
    const origin = { clientId: null, sessionId: null };
    session.setQueue(
      [{ id: 'loud', title: 'Loud', artistName: 'L', albumTitle: 'Loud' }],
      0,
      origin,
      'dlna:amp',
    );
    session.playItem(session.getCurrentItemId()!, origin, 'dlna:amp');
    const path = await describeAudioPath(session);
    expect(path.steps.find((s) => s.stage === 'transfer')?.title).toBe(
      'Level adjusted on the NAS to FLAC',
    );
    const caveats = path.caveats.join(' ');
    expect(caveats).toMatch(/album ReplayGain -8.5 dB\): this path is not bit-perfect/);
    expect(caveats).not.toMatch(/ReplayGain is not applied/);
  });

  it('is set per room by an admin, and shown with the rooms', async () => {
    const zone = (
      await request(app).post('/api/playback/zones').send({ name: 'Den', deviceId: 'dlna:amp' })
    ).body.data.id as string;
    const refused = await request(app)
      .put(`/api/playback/zones/${zone}/leveling`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ leveling: 'album' });
    expect(refused.status).toBe(403);
    const ok = await request(app)
      .put(`/api/playback/zones/${zone}/leveling`)
      .send({ leveling: 'album' });
    expect(ok.body.data).toEqual({ zoneId: zone, leveling: 'album' });
    const rooms = (await request(app).get('/api/playback/zones')).body.data;
    expect(rooms.find((r: { id: string }) => r.id === zone).leveling).toBe('album');
    expect(rooms.find((r: { id: string }) => r.id === 'zone-browser').leveling).toBe('auto');
    const bad = await request(app)
      .put(`/api/playback/zones/${zone}/leveling`)
      .send({ leveling: 'loud' });
    expect(bad.status).toBe(400);
  });

  it.skipIf(!hasFfmpeg)('really lowers the level by the gain it names', async () => {
    const res = await request(app)
      .get('/api/library/tracks/loud/stream?format=flac&zone=zone-real&gain=-6')
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.headers['content-type']).toBe('audio/flac');
    const out = join(dir, 'leveled.flac');
    writeFileSync(out, res.body as Buffer);
    const level = (f: string) =>
      Number(
        /max_volume: (-?[\d.]+) dB/.exec(
          spawnSync('ffmpeg', [
            '-i',
            f,
            '-af',
            'volumedetect',
            '-f',
            'null',
            '-',
          ]).stderr.toString(),
        )?.[1],
      );
    const before = level(join(dir, 'loud.flac'));
    const after = level(out);
    expect(after - before).toBeCloseTo(-6, 0);
  });
});

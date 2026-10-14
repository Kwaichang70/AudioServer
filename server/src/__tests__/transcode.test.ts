import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { get as httpGet } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import type { Express } from 'express';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import {
  configureOutputCapabilities,
  forgetCapabilities,
} from '../services/output-capabilities.js';
import {
  configureTranscode,
  decideTranscode,
  ffmpegArgs,
  resetTranscode,
  startTranscode,
  transcodeStats,
} from '../services/transcode.js';
import { resolveForDevice } from '../services/playback-resolver.js';
import { describeAudioPath } from '../services/audio-path.js';
import { PlaybackService } from '../services/playback.js';

/**
 * Format adaptation for speakers (R10.1): the NAS converts a file only when
 * the speaker itself said it does not take that format, the audio path says
 * so, and every conversion is measured.
 */

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('Deciding whether to convert', () => {
  it('converts FLAC for a speaker that lists only MP3', () => {
    expect(decideTranscode('audio/flac', ['audio/mpeg'])).toMatchObject({
      target: 'mp3',
      from: 'audio/flac',
      to: 'audio/mpeg',
    });
  });

  it('leaves the file alone when the speaker takes it, under any of its names', () => {
    expect(decideTranscode('audio/flac', ['audio/x-flac', 'audio/mpeg'])).toBeNull();
    expect(decideTranscode('audio/mpeg', ['audio/mp3'])).toBeNull();
  });

  it('never converts for a speaker that did not say what it takes', () => {
    expect(decideTranscode('audio/flac', [])).toBeNull();
  });

  it('makes WAV when asked to and the speaker takes it, MP3 otherwise', () => {
    expect(decideTranscode('audio/flac', ['audio/wav', 'audio/mpeg'], 'wav')?.target).toBe('wav');
    expect(decideTranscode('audio/flac', ['audio/mpeg'], 'wav')?.target).toBe('mp3');
    // Nothing we can make: the original goes, and the speaker decides.
    expect(decideTranscode('audio/flac', ['audio/aac'])).toBeNull();
  });

  it('brings high rates down to their own family for MP3, keeps 24 bit for WAV', () => {
    expect(ffmpegArgs('/m/a.flac', 'mp3', { sampleRate: 96000 })).toContain('48000');
    expect(ffmpegArgs('/m/a.flac', 'mp3', { sampleRate: 88200 })).toContain('44100');
    expect(ffmpegArgs('/m/a.flac', 'mp3', { sampleRate: 44100 })).not.toContain('-ar');
    expect(ffmpegArgs('/m/a.flac', 'wav', { bitDepth: 24 })).toContain('pcm_s24le');
    expect(ffmpegArgs('/m/a.flac', 'mp3')).toEqual(expect.arrayContaining(['libmp3lame', '320k']));
  });
});

describe('Converting for a speaker', () => {
  let app: Express;
  let teardown: () => void;
  let dir: string;

  const speaker = (formats: string[]) =>
    configureOutputCapabilities({
      listDevices: async () => [{ id: 'dlna:old', name: 'Old amp', type: 'dlna' }],
      controllerFor: () => ({
        getSupportedActions: async () => ['Play', 'Seek', 'SetNextAVTransportURI'],
        getSupportedFormats: async () => formats,
      }),
      measuredGapFor: () => undefined,
      measurementsFor: () => 0,
    });

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    dir = mkdtempSync(join(tmpdir(), 'audioserver-transcode-'));
    const file = join(dir, 'tone.flac');
    if (hasFfmpeg) {
      spawnSync('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=4',
        '-ar',
        '96000',
        '-sample_fmt',
        's32',
        file,
      ]);
    } else {
      writeFileSync(file, 'not really flac');
    }
    getRawDb().exec(`
      INSERT INTO artists (id, name) VALUES ('ar-t', 'Tone');
      INSERT INTO albums (id, title, artist_id, artist_name) VALUES ('al-t', 'Tones', 'ar-t', 'Tone');
    `);
    getRawDb()
      .prepare(
        `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path, duration, format, sample_rate, bit_depth)
         VALUES ('tone', 'A440', 'al-t', 'Tones', 'ar-t', 'Tone', ?, 4, 'flac', 96000, 24)`,
      )
      .run(file);
  });

  afterEach(() => {
    forgetCapabilities();
    resetTranscode();
  });

  afterAll(() => {
    teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands an MP3-only speaker a conversion, and any other speaker the file', async () => {
    configureTranscode({ ffmpegAvailable: async () => true });
    speaker(['audio/mpeg']);
    const converted = await resolveForDevice(
      { id: 'tone' },
      { deviceId: 'dlna:old', zoneId: 'zone-dlna-old' },
    );
    expect(converted.url).toContain('&format=mp3&zone=zone-dlna-old');
    expect(converted.mimeType).toBe('audio/mpeg');
    expect(converted.transcode?.reason).toMatch(/does not list FLAC/);

    forgetCapabilities();
    speaker(['audio/flac', 'audio/mpeg']);
    const original = await resolveForDevice({ id: 'tone' }, { deviceId: 'dlna:old', zoneId: 'z' });
    expect(original.url).not.toContain('format=');
    expect(original.mimeType).toBe('audio/flac');
  });

  it('sends the original when ffmpeg is missing, rather than nothing', async () => {
    configureTranscode({ ffmpegAvailable: async () => false });
    speaker(['audio/mpeg']);
    const resolved = await resolveForDevice({ id: 'tone' }, { deviceId: 'dlna:old', zoneId: 'z' });
    expect(resolved.url).not.toContain('format=');
  });

  it('names the conversion in the audio path, and that MP3 is lossy', async () => {
    configureTranscode({ ffmpegAvailable: async () => true });
    speaker(['audio/mpeg']);
    const session = new PlaybackService('zone-path');
    const origin = { clientId: null, sessionId: null };
    session.setQueue(
      [{ id: 'tone', title: 'A440', artistName: 'Tone', albumTitle: 'Tones' }],
      0,
      origin,
      'dlna:old',
    );
    session.playItem(session.getCurrentItemId()!, origin, 'dlna:old');
    const path = await describeAudioPath(session);
    const transfer = path.steps.find((s) => s.stage === 'transfer')!;
    expect(transfer).toMatchObject({
      title: 'Converted on the NAS to MP3 320',
      certainty: 'known',
    });
    expect(transfer.detail).toMatch(/does not list FLAC/);
    expect(path.caveats.join(' ')).toMatch(/lossy/);
    expect(path.summary).toMatch(/converts the file/);
  });

  it('runs at most two conversions per room, and counts what each one used', async () => {
    // Stand-ins that live until stopped, so the limit can be watched.
    configureTranscode({ spawn: () => spawn('sleep', ['30']) });
    const start = (zoneId: string, trackId: string) =>
      startTranscode({ file: '/x.flac', target: 'mp3', zoneId, trackId });
    const first = start('kitchen', 't1');
    start('kitchen', 't2');
    start('living', 't9');
    start('kitchen', 't3');
    const stats = transcodeStats();
    expect(stats.active.map((r) => r.trackId).sort()).toEqual(['t2', 't3', 't9']);
    expect(stats.recent[0]).toMatchObject({ trackId: 't1', outcome: 'replaced' });
    first.stop(); // already gone: nothing happens twice
    expect(transcodeStats().recent).toHaveLength(1);
  });

  it.skipIf(!hasFfmpeg)('streams real MP3 320 from a 96 kHz/24-bit FLAC', async () => {
    const res = await request(app)
      .get('/api/library/tracks/tone/stream?format=mp3&zone=zone-real')
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['accept-ranges']).toBe('none');
    const out = join(dir, 'out.mp3');
    writeFileSync(out, res.body as Buffer);
    const probe = spawnSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,sample_rate,bit_rate',
      '-of',
      'csv=p=0',
      out,
    ]).stdout.toString();
    expect(probe.trim()).toBe('mp3,48000,320000');
    await new Promise((r) => setTimeout(r, 100));
    const run = transcodeStats().recent.find((r) => r.zoneId === 'zone-real');
    expect(run).toMatchObject({ trackId: 'tone', target: 'mp3', outcome: 'finished' });
  });

  it.skipIf(!hasFfmpeg)('stops converting when the speaker hangs up', async () => {
    const long = join(dir, 'long.flac');
    spawnSync('ffmpeg', [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=600',
      long,
    ]);
    getRawDb()
      .prepare(
        `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, file_path, duration, format, sample_rate, bit_depth)
         VALUES ('long', 'Long', 'al-t', 'Tones', 'ar-t', 'Tone', ?, 600, 'flac', 44100, 16)`,
      )
      .run(long);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      const req = httpGet(
        `http://127.0.0.1:${port}/api/library/tracks/long/stream?format=mp3&zone=zone-skip`,
        (res) => res.once('data', () => req.destroy()),
      );
      req.on('close', () => resolve());
    });
    await vi.waitFor(() =>
      expect(transcodeStats().recent.find((r) => r.zoneId === 'zone-skip')?.outcome).toBe(
        'stopped',
      ),
    );
    expect(transcodeStats().active).toEqual([]);
    server.close();
  });

  it('answers a HEAD without starting a conversion', async () => {
    const res = await request(app).head('/api/library/tracks/tone/stream?format=mp3&zone=z');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(transcodeStats()).toEqual({ active: [], recent: [] });
  });
});

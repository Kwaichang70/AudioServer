import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { devicesRouter } from '../routes/devices.js';
import { deviceManager } from '../devices/manager.js';
import { getRawDb, initDatabase } from '../db/index.js';

describe('Devices route metadata', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-device-route-'));
    await initDatabase(join(tmp, 'test.db'));
    const db = getRawDb();
    db.prepare(
      "INSERT INTO artists (id, name, source) VALUES ('artist-1', 'Artist', 'local')",
    ).run();
    db.prepare(
      "INSERT INTO albums (id, title, artist_id, artist_name, source) VALUES ('album-1', 'Album', 'artist-1', 'Artist', 'local')",
    ).run();
    db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, format, source)
       VALUES ('track-1', 'Track', 'album-1', 'Album', 'artist-1', 'Artist', 'flac', 'local')`,
    ).run();
  });

  afterAll(() => {
    vi.restoreAllMocks();
    getRawDb().close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the signed stream token to the generated device cover URL', async () => {
    const play = vi.spyOn(deviceManager, 'play').mockResolvedValue();
    const app = express();
    app.use(express.json());
    app.use('/api/devices', devicesRouter);
    const streamUrl =
      'http://192.168.1.20:3001/api/library/tracks/track-1/stream?t=signed.token-123&ignored=value';

    const response = await request(app)
      .post('/api/devices/device-1/play')
      .send({
        streamUrl,
        trackId: 'track-1',
        metadata: { title: 'Track', artist: 'Artist', album: 'Album' },
      });

    expect(response.status).toBe(200);
    expect(play).toHaveBeenCalledWith(
      'device-1',
      streamUrl,
      expect.objectContaining({
        mimeType: 'audio/flac',
        coverUrl: 'http://192.168.1.20:3001/api/library/albums/album-1/cover?t=signed.token-123',
      }),
    );
  });
});

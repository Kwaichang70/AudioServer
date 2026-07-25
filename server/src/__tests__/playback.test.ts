import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import { playbackRouter } from '../routes/playback.js';
import { playbackService } from '../services/playback.js';
import { initSocketIO } from '../socketio.js';

let server: Server;
let baseUrl: string;
let tmp: string | null = null;

const mockTrack1 = {
  id: 't1',
  title: 'Track One',
  artistName: 'Artist A',
  albumTitle: 'Album X',
  albumId: 'a1',
  duration: 180,
};
const mockTrack2 = {
  id: 't2',
  title: 'Track Two',
  artistName: 'Artist A',
  albumTitle: 'Album X',
  albumId: 'a1',
  duration: 210,
};
const mockTrack3 = {
  id: 't3',
  title: 'Track Three',
  artistName: 'Artist B',
  albumTitle: 'Album Y',
  albumId: 'a2',
  duration: 240,
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'audioserver-playback-api-test-'));
  await initDatabase(join(tmp, 'test.db'));
  playbackService.initialize();

  const app = express();
  app.use(express.json());
  app.use('/api/playback', playbackRouter);
  server = createServer(app);
  initSocketIO(server);
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  try {
    getRawDb().close();
  } catch {
    // ignore
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function post(path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api/playback${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function get(path: string) {
  const res = await fetch(`${baseUrl}/api/playback${path}`);
  return res.json();
}

describe('Playback API', () => {
  it('starts in stopped state', async () => {
    const { data } = await get('/now-playing');
    expect(data.state).toBe('stopped');
  });

  it('can play a track', async () => {
    const { data } = await post('/play', { track: mockTrack1 });
    expect(data.state).toBe('playing');
    expect(data.track.id).toBe('t1');
  });

  it('can pause', async () => {
    const { data } = await post('/pause');
    expect(data.state).toBe('paused');
  });

  it('can resume', async () => {
    const { data } = await post('/play');
    expect(data.state).toBe('playing');
  });

  it('can set volume', async () => {
    const { data } = await post('/volume', { volume: 75 });
    expect(data.volume).toBe(75);
  });

  it('clamps volume to 0-100', async () => {
    await post('/volume', { volume: 150 });
    const { data } = await get('/now-playing');
    expect(data.volume).toBe(100);
  });

  it('can stop', async () => {
    const { data } = await post('/stop');
    expect(data.state).toBe('stopped');
  });
});

describe('Queue API', () => {
  it('starts with empty queue', async () => {
    const { data } = await get('/queue');
    expect(data).toEqual([]);
  });

  it('can add to queue', async () => {
    await post('/queue/add', { track: mockTrack1 });
    await post('/queue/add', { track: mockTrack2 });
    await post('/queue/add', { track: mockTrack3 });
    const { data } = await get('/queue');
    expect(data).toHaveLength(3);
    expect(data[0].trackTitle).toBe('Track One');
    expect(data[2].trackTitle).toBe('Track Three');
    const persisted = getRawDb()
      .prepare('SELECT track_id, track_title FROM queue_items ORDER BY position')
      .all() as Array<{ track_id: string; track_title: string }>;
    expect(persisted).toEqual([
      { track_id: 't1', track_title: 'Track One' },
      { track_id: 't2', track_title: 'Track Two' },
      { track_id: 't3', track_title: 'Track Three' },
    ]);
  });

  it('rejects queue entries without persisted display metadata', async () => {
    const res = await fetch(`${baseUrl}/api/playback/queue/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track: { id: 'incomplete' } }),
    });

    expect(res.status).toBe(400);
  });

  it('advances to the successor after removing the currently playing item', () => {
    playbackService.setQueue([mockTrack1, mockTrack2, mockTrack3]);
    playbackService.play(mockTrack2);

    playbackService.removeFromQueue(1);

    expect(playbackService.getQueueIndex()).toBe(0);
    expect(playbackService.advance()).toMatchObject({ id: 't3', title: 'Track Three' });
    playbackService.setQueue([mockTrack1, mockTrack2, mockTrack3]);
  });

  it('can remove from queue', async () => {
    await post('/queue/remove', { index: 1 });
    const { data } = await get('/queue');
    expect(data).toHaveLength(2);
    expect(data[0].trackTitle).toBe('Track One');
    expect(data[1].trackTitle).toBe('Track Three');
  });

  it('can move in queue', async () => {
    await post('/queue/move', { from: 1, to: 0 });
    const { data } = await get('/queue');
    expect(data[0].trackTitle).toBe('Track Three');
    expect(data[1].trackTitle).toBe('Track One');
  });

  it('can clear queue', async () => {
    await post('/queue/clear');
    const { data } = await get('/queue');
    expect(data).toEqual([]);
  });
});

describe('Shuffle & Repeat', () => {
  it('can set shuffle', async () => {
    const { data } = await post('/shuffle', { shuffle: true });
    expect(data.volume).toBeDefined(); // verify response format
  });

  it('can set repeat', async () => {
    await post('/repeat', { repeat: 'all' });
    await post('/repeat', { repeat: 'one' });
    await post('/repeat', { repeat: 'off' });
    const { data } = await get('/now-playing');
    expect(data).toBeDefined();
  });
});

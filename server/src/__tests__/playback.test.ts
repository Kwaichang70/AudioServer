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

/** POST as browser tab `client` (every mutation needs X-Client-Id). */
async function postRaw(path: string, body?: unknown, client = 'tab-a') {
  return fetch(`${baseUrl}/api/playback${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': client },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function post(path: string, body?: unknown, client = 'tab-a') {
  const res = await postRaw(path, body, client);
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

  it('refuses mutations without a client id so an outdated page reloads instead of overwriting', async () => {
    const res = await fetch(`${baseUrl}/api/playback/pause`, { method: 'POST' });
    expect(res.status).toBe(426);
    expect((await res.json()).error).toBe('UpgradeRequired');
  });
});

describe('Queue API', () => {
  it('starts with empty queue', async () => {
    const { data } = await get('/queue');
    expect(data).toEqual([]);
  });

  it('can add to queue and every item gets a stable id', async () => {
    await post('/queue/add', { track: mockTrack1 });
    await post('/queue/add', { track: mockTrack2 });
    const { data } = await post('/queue/add', { track: mockTrack3 });
    expect(data.queue).toHaveLength(3);
    expect(data.queue[0].trackTitle).toBe('Track One');
    expect(data.queue[2].trackTitle).toBe('Track Three');
    expect(new Set(data.queue.map((i: { itemId: string }) => i.itemId)).size).toBe(3);
    const persisted = getRawDb()
      .prepare('SELECT item_id, track_id, track_title FROM queue_items ORDER BY position')
      .all() as Array<{ item_id: string; track_id: string; track_title: string }>;
    expect(persisted.map((r) => r.track_id)).toEqual(['t1', 't2', 't3']);
    expect(persisted.every((r) => r.item_id)).toBe(true);
  });

  it('rejects queue entries without persisted display metadata', async () => {
    const res = await postRaw('/queue/add', { track: { id: 'incomplete' } });
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

  it('can remove from queue by item id', async () => {
    const before = await get('/session');
    const second = before.data.queue[1];
    const { data } = await post('/queue/remove', {
      itemId: second.itemId,
      expectedRevision: before.data.revision,
    });
    expect(data.queue).toHaveLength(2);
    expect(data.queue[0].trackTitle).toBe('Track One');
    expect(data.queue[1].trackTitle).toBe('Track Three');
  });

  it('can move in queue by item id', async () => {
    const before = await get('/session');
    const { data } = await post('/queue/move', { itemId: before.data.queue[1].itemId, to: 0 });
    expect(data.queue[0].trackTitle).toBe('Track Three');
    expect(data.queue[1].trackTitle).toBe('Track One');
  });

  it('refuses a stale edit with 409 and the fresh snapshot', async () => {
    const before = await get('/session');
    // Another tab changes the queue first.
    await post('/queue/add', { track: mockTrack2 }, 'tab-b');
    const res = await postRaw('/queue/remove', {
      itemId: before.data.queue[0].itemId,
      expectedRevision: before.data.revision,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('StaleRevision');
    expect(body.data.revision).toBeGreaterThan(before.data.revision);
    expect(body.data.queue).toHaveLength(3);
    // Re-applying on the fresh snapshot succeeds.
    const retry = await post('/queue/remove', {
      itemId: before.data.queue[0].itemId,
      expectedRevision: body.data.revision,
    });
    expect(retry.data.queue).toHaveLength(2);
  });

  it('applies a command with the same commandId only once', async () => {
    const before = await get('/session');
    const first = (await post('/queue/add', { track: mockTrack3, commandId: 'cmd-add-1' })).data;
    const retry = (await post('/queue/add', { track: mockTrack3, commandId: 'cmd-add-1' })).data;
    expect(first.queue).toHaveLength(before.data.queue.length + 1);
    expect(retry.revision).toBe(first.revision);
    expect(retry.queue).toHaveLength(first.queue.length);
    const now = await get('/session');
    expect(now.data.queue).toHaveLength(first.queue.length);
  });

  it('can clear queue (current track keeps playing, queue is empty everywhere)', async () => {
    await post('/queue/set', { tracks: [mockTrack1, mockTrack2], startIndex: 0 });
    await post('/play', { track: mockTrack1 });
    const { data } = await post('/queue/clear');
    expect(data.queue).toEqual([]);
    expect(data.currentItemId).toBeNull();
    expect(data.state.state).toBe('playing');
    expect(data.state.track.id).toBe('t1');
    const again = await get('/queue');
    expect(again.data).toEqual([]);
    // When the current track then ends, the session goes idle.
    expect(playbackService.advance()).toBeNull();
    expect(playbackService.getState().state).toBe('stopped');
  });
});

describe('Session snapshot and identity', () => {
  it('A → B → A → C plays every position in order (repeated track)', async () => {
    const { data: set } = await post('/queue/set', {
      tracks: [mockTrack1, mockTrack2, mockTrack1, mockTrack3],
      startIndex: 0,
      deviceId: 'browser',
    });
    expect(set.queueIndex).toBe(0);
    expect(set.controller).toMatchObject({ clientId: 'tab-a', deviceId: 'browser' });

    const visited: number[] = [];
    let snap = set;
    for (let i = 0; i < 3; i++) {
      snap = (await post('/next')).data ?? (await get('/session')).data;
      visited.push(snap.queueIndex);
    }
    expect(visited).toEqual([1, 2, 3]);
    expect(snap.state.track.id).toBe('t3');

    // The client reporting "I started the second A" must not send the index
    // back to the first A.
    await post('/queue/play', { itemId: set.queue[2].itemId });
    const reported = await post('/play', { track: mockTrack1, itemId: set.queue[2].itemId });
    expect(reported.data.track.id).toBe('t1');
    const after = await get('/session');
    expect(after.data.queueIndex).toBe(2);
    expect(after.data.currentItemId).toBe(set.queue[2].itemId);

    // Restart: the second occurrence is restored, not the first.
    const restarted = await get('/session');
    playbackService.initialize();
    const restored = playbackService.getSnapshot();
    expect(restored.queueIndex).toBe(2);
    expect(restored.currentItemId).toBe(restarted.data.currentItemId);
    expect(restored.revision).toBe(restarted.data.revision);
    expect(restored.queue.map((i) => i.trackId)).toEqual(['t1', 't2', 't1', 't3']);
  });

  it('previous steps back one occurrence and stops at the start', async () => {
    const before = await get('/session');
    expect(before.data.queueIndex).toBe(2);
    const { data } = await post('/previous');
    expect(data.queueIndex).toBe(1);
    await post('/previous');
    const start = await post('/previous');
    expect(start.data.queueIndex).toBe(0);
  });

  it('events carry the origin so other tabs only mirror', async () => {
    const io = (await import('../socketio.js')).getIO();
    const seen: Array<{ event: string; origin: { clientId: string | null } }> = [];
    const original = io.emit.bind(io);
    (io as unknown as { emit: typeof io.emit }).emit = ((event: string, payload: unknown) => {
      if (event.startsWith('playback:')) {
        seen.push({ event, origin: (payload as { origin: { clientId: string | null } }).origin });
      }
      return (original as unknown as (e: string, p: unknown) => boolean)(event, payload);
    }) as typeof io.emit;
    try {
      await post('/next', undefined, 'tab-b');
    } finally {
      (io as unknown as { emit: typeof io.emit }).emit = original;
    }
    expect(seen.some((s) => s.event === 'playback:track-changed')).toBe(true);
    expect(seen.every((s) => s.origin.clientId === 'tab-b')).toBe(true);
  });
});

describe('Shuffle & Repeat', () => {
  it('can set shuffle', async () => {
    const { data } = await post('/shuffle', { shuffle: true });
    expect(data.volume).toBeDefined(); // verify response format
    await post('/shuffle', { shuffle: false });
  });

  it('can set repeat', async () => {
    await post('/repeat', { repeat: 'all' });
    await post('/repeat', { repeat: 'one' });
    await post('/repeat', { repeat: 'off' });
    const { data } = await get('/now-playing');
    expect(data).toBeDefined();
  });
});

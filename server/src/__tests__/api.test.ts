import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { healthRouter } from '../routes/health.js';
import { devicesRouter } from '../routes/devices.js';
import { playbackRouter } from '../routes/playback.js';
import { initSocketIO } from '../socketio.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/health', healthRouter);
  app.use('/api/devices', devicesRouter);
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
});

describe('Health API', () => {
  // This test setup deliberately does NOT initialise the DB, so the health
  // endpoints must report the process as alive but not usable.
  it('liveness answers 200 without touching the database', async () => {
    const res = await fetch(`${baseUrl}/api/health/live`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.uptime).toBeGreaterThan(0);
  });

  it('readiness answers 503 while the database is unusable', async () => {
    const res = await fetch(`${baseUrl}/api/health/ready`);
    const data = await res.json();
    expect(res.status).toBe(503);
    expect(data.status).toBe('not_ready');
    expect(data.db.status).toBe('down');
    expect(data.db.error).toMatch(/not initialized/);
  });

  it('full health reports degraded with a 503 status code', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    const data = await res.json();
    expect(res.status).toBe(503);
    expect(data.status).toBe('degraded');
    expect(data.db).toMatchObject({ status: 'down', schemaVersion: null });
    expect(data.uptime).toBeGreaterThan(0);
    expect(data.timestamp).toBeTruthy();
    expect(data.port).toBeGreaterThan(0);
  });
});

describe('Devices API', () => {
  it('returns list of devices', { timeout: 15000 }, async () => {
    const res = await fetch(`${baseUrl}/api/devices`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.data).toBeInstanceOf(Array);
    expect(data.data.length).toBeGreaterThan(0);
  });

  it('each device has required fields', { timeout: 15000 }, async () => {
    const res = await fetch(`${baseUrl}/api/devices`);
    const { data } = await res.json();
    for (const device of data) {
      expect(device.id).toBeTruthy();
      expect(device.name).toBeTruthy();
      expect(device.type).toBeTruthy();
      expect(typeof device.isOnline).toBe('boolean');
    }
  });

  it('browser device is always online', { timeout: 15000 }, async () => {
    const res = await fetch(`${baseUrl}/api/devices`);
    const { data } = await res.json();
    const browser = (data as Array<{ id: string; isOnline: boolean }>).find(
      (device) => device.id === 'browser',
    );
    expect(browser).toBeTruthy();
    expect(browser?.isOnline).toBe(true);
  });
});

describe('Playback API', () => {
  it('returns stopped state initially', async () => {
    const res = await fetch(`${baseUrl}/api/playback/now-playing`);
    const { data } = await res.json();
    expect(data.state).toBe('stopped');
    expect(data.track).toBeNull();
  });

  it('can play a track', async () => {
    const track = {
      id: 'test-1',
      title: 'Test',
      artistName: 'Artist',
      albumTitle: 'Album',
      duration: 180,
    };
    const res = await fetch(`${baseUrl}/api/playback/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'api-test' },
      body: JSON.stringify({ track }),
    });
    const { data } = await res.json();
    expect(data.state).toBe('playing');
    expect(data.track.id).toBe('test-1');
    expect(data.duration).toBe(180);
  });

  it('can pause', async () => {
    const res = await fetch(`${baseUrl}/api/playback/pause`, {
      method: 'POST',
      headers: { 'X-Client-Id': 'api-test' },
    });
    const { data } = await res.json();
    expect(data.state).toBe('paused');
  });

  it('can set volume', async () => {
    const res = await fetch(`${baseUrl}/api/playback/volume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'api-test' },
      body: JSON.stringify({ volume: 75 }),
    });
    const { data } = await res.json();
    expect(data.volume).toBe(75);
  });

  it('returns queue', async () => {
    const res = await fetch(`${baseUrl}/api/playback/queue`);
    const { data } = await res.json();
    expect(data).toBeInstanceOf(Array);
  });

  it('can add to queue', async () => {
    const track = { id: 'q-1', title: 'Queued', artistName: 'A', albumTitle: 'B' };
    const res = await fetch(`${baseUrl}/api/playback/queue/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'api-test' },
      body: JSON.stringify({ track }),
    });
    const { data } = await res.json();
    expect(data.queue.length).toBe(1);
    expect(data.queue[0].trackId).toBe('q-1');
    expect(data.queue[0].itemId).toBeTruthy();
    expect(data.revision).toBeGreaterThan(0);
  });

  it('can clear queue', async () => {
    const res = await fetch(`${baseUrl}/api/playback/queue/clear`, {
      method: 'POST',
      headers: { 'X-Client-Id': 'api-test' },
    });
    const { data } = await res.json();
    expect(data.queue.length).toBe(0);
  });

  it('refuses queue mutations from a page without a client id (426)', async () => {
    const res = await fetch(`${baseUrl}/api/playback/queue/clear`, { method: 'POST' });
    expect(res.status).toBe(426);
    const body = await res.json();
    expect(body.error).toBe('UpgradeRequired');
  });
});

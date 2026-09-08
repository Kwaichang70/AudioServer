import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initSocketIO } from '../socketio.js';
import { deviceMonitor } from '../services/device-monitor.js';
import { getRawDb, initDatabase } from '../db/index.js';
import { createSession, revokeSession } from '../services/sessions.js';
import { playbackService } from '../services/playback.js';
import type { PlaybackSnapshot } from '../types/socket-events.js';

describe('Socket.IO device subscriptions', () => {
  let tmp: string;
  let httpServer: HttpServer;
  let client: ClientSocket | null = null;
  let subscribe: ReturnType<typeof vi.spyOn>;
  let unsubscribe: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-socket-subscriptions-'));
    await initDatabase(join(tmp, 'test.db'));
    getRawDb()
      .prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES ('user-1', 'socket-user', 'hash', 'user')",
      )
      .run();
    vi.spyOn(deviceMonitor, 'startHealthChecks').mockImplementation(() => undefined);
    subscribe = vi.spyOn(deviceMonitor, 'subscribe').mockImplementation(() => undefined);
    unsubscribe = vi.spyOn(deviceMonitor, 'unsubscribe').mockImplementation(() => undefined);

    httpServer = createServer();
    initSocketIO(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    client?.disconnect();
    deviceMonitor.stopAll();
    await new Promise<void>((resolve) => {
      if (!httpServer.listening) return resolve();
      httpServer.close(() => resolve());
    });
    vi.restoreAllMocks();
    getRawDb().close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function connect(token?: string): ClientSocket {
    const port = (httpServer.address() as AddressInfo).port;
    return connectClient(`http://127.0.0.1:${port}`, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
      auth: token ? { token } : {},
    });
  }

  it('refuses a handshake without a valid session token', async () => {
    const anonymous = connect();
    const err = await new Promise<Error>((resolve, reject) => {
      anonymous.once('connect_error', resolve);
      anonymous.once('connect', () => reject(new Error('connected without a token')));
    });
    expect(err.message).toBe('Authentication required');
    anonymous.disconnect();
  });

  it('closes the socket when its session is revoked', async () => {
    const { token, sessionId } = createSession('user-1');
    const socket = connect(token);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const notified = new Promise<void>((resolve) => socket.once('session:revoked', resolve));
    const disconnected = new Promise<string>((resolve) => socket.once('disconnect', resolve));

    revokeSession(sessionId);

    await notified;
    expect(await disconnected).toBe('io server disconnect');
    socket.disconnect();
  });

  it('sends the playback snapshot on connect and again on playback:sync (reconnect recovery)', async () => {
    playbackService.initialize();
    playbackService.setQueue(
      [
        { id: 'x1', title: 'One', artistName: 'A', albumTitle: 'B' },
        { id: 'x2', title: 'Two', artistName: 'A', albumTitle: 'B' },
      ],
      1,
      { clientId: 'tab-z', sessionId: null },
      'browser',
    );
    const socket = connect(createSession('user-1').token);
    const first = await new Promise<PlaybackSnapshot>((resolve, reject) => {
      socket.once('playback:snapshot', resolve);
      socket.once('connect_error', reject);
    });
    expect(first.queue.map((i) => i.trackId)).toEqual(['x1', 'x2']);
    expect(first.queueIndex).toBe(1);
    expect(first.controller.clientId).toBe('tab-z');
    expect(first.revision).toBe(playbackService.getRevision());

    // Something changes while this client was "away"; asking for a sync
    // yields the newer revision.
    playbackService.addToQueue({ id: 'x3', title: 'Three', artistName: 'A', albumTitle: 'B' });
    const second = await new Promise<PlaybackSnapshot>((resolve) => {
      socket.once('playback:snapshot', resolve);
      socket.emit('playback:sync');
    });
    expect(second.queue).toHaveLength(3);
    expect(second.revision).toBeGreaterThan(first.revision);
    socket.disconnect();
  });

  it('deduplicates subscriptions and cleans remaining devices on disconnect', async () => {
    client = connect(createSession('user-1').token);
    await new Promise<void>((resolve, reject) => {
      client!.once('connect', resolve);
      client!.once('connect_error', reject);
    });

    client.emit('device:subscribe', 'device-1');
    client.emit('device:subscribe', 'device-1');
    client.emit('device:subscribe', 'device-2');
    await vi.waitFor(() => {
      expect(subscribe).toHaveBeenCalledTimes(2);
    });

    client.emit('device:unsubscribe', 'device-1');
    client.emit('device:unsubscribe', 'device-1');
    await vi.waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenCalledWith('device-1');
    });

    client.disconnect();
    await vi.waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(2);
      expect(unsubscribe).toHaveBeenLastCalledWith('device-2');
    });
  });
});

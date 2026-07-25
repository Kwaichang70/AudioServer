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

describe('Socket.IO device subscriptions', () => {
  let tmp: string;
  let httpServer: HttpServer;
  let client: ClientSocket | null = null;
  let subscribe: ReturnType<typeof vi.spyOn>;
  let unsubscribe: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-socket-subscriptions-'));
    await initDatabase(join(tmp, 'test.db'));
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

  it('deduplicates subscriptions and cleans remaining devices on disconnect', async () => {
    const port = (httpServer.address() as AddressInfo).port;
    client = connectClient(`http://127.0.0.1:${port}`, {
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
    });
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

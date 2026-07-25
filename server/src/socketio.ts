import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { config } from './config.js';
import { logger } from './logger.js';
import { getExistingUserIdFromToken, isFirstRun } from './middleware/auth.js';
import { deviceMonitor } from './services/device-monitor.js';
import type { ServerToClientEvents, ClientToServerEvents } from './types/socket-events.js';

let io: SocketServer<ClientToServerEvents, ServerToClientEvents>;

export function isValidSocketToken(token: unknown): boolean {
  return getExistingUserIdFromToken(token) !== null;
}

export function initSocketIO(
  httpServer: HttpServer,
): SocketServer<ClientToServerEvents, ServerToClientEvents> {
  io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : '*',
      credentials: true,
    },
  });

  // Auth middleware
  io.use((socket, next) => {
    try {
      if (isFirstRun()) return next();

      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Authentication required'));

      if (!isValidSocketToken(token)) return next(new Error('Authentication failed'));
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    const deviceSubscriptions = new Set<string>();

    // Device monitoring subscriptions
    socket.on('device:subscribe', (deviceId: string) => {
      if (deviceSubscriptions.has(deviceId)) return;
      deviceSubscriptions.add(deviceId);
      logger.debug(`Client ${socket.id} subscribed to device ${deviceId}`);
      deviceMonitor.subscribe(deviceId);
      socket.join(`device:${deviceId}`);
    });

    socket.on('device:unsubscribe', (deviceId: string) => {
      if (!deviceSubscriptions.delete(deviceId)) return;
      logger.debug(`Client ${socket.id} unsubscribed from device ${deviceId}`);
      deviceMonitor.unsubscribe(deviceId);
      socket.leave(`device:${deviceId}`);
    });

    socket.on('disconnecting', () => {
      for (const deviceId of deviceSubscriptions) {
        deviceMonitor.unsubscribe(deviceId);
      }
      deviceSubscriptions.clear();
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  // Start device health checks
  deviceMonitor.startHealthChecks();

  return io;
}

export function getIO(): SocketServer<ClientToServerEvents, ServerToClientEvents> {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

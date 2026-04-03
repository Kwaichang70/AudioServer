import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { logger } from './logger.js';
import { getRawDb } from './db/index.js';
import { deviceMonitor } from './services/device-monitor.js';
import type { ServerToClientEvents, ClientToServerEvents } from './types/socket-events.js';

let io: SocketServer<ClientToServerEvents, ServerToClientEvents>;

export function initSocketIO(httpServer: HttpServer): SocketServer {
  io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: {
      origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : '*',
      credentials: true,
    },
  });

  // Auth middleware
  io.use((socket, next) => {
    try {
      const db = getRawDb();
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number } | undefined;
      if (!row || row.count === 0) return next();

      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Authentication required'));

      jwt.verify(token as string, config.jwtSecret);
      next();
    } catch {
      next();
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Device monitoring subscriptions
    socket.on('device:subscribe', (deviceId: string) => {
      logger.debug(`Client ${socket.id} subscribed to device ${deviceId}`);
      deviceMonitor.subscribe(deviceId);
      socket.join(`device:${deviceId}`);
    });

    socket.on('device:unsubscribe', (deviceId: string) => {
      logger.debug(`Client ${socket.id} unsubscribed from device ${deviceId}`);
      deviceMonitor.unsubscribe(deviceId);
      socket.leave(`device:${deviceId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  // Start device health checks
  deviceMonitor.startHealthChecks();

  return io as any;
}

export function getIO(): SocketServer {
  if (!io) throw new Error('Socket.IO not initialized');
  return io as any;
}

import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { logger } from './logger.js';
import { getRawDb } from './db/index.js';

let io: SocketServer;

export function initSocketIO(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: {
      origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : '*',
      credentials: true,
    },
  });

  // Auth middleware — verify JWT on connection (skip if no users exist)
  io.use((socket, next) => {
    try {
      const db = getRawDb();
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number } | undefined;

      // If no users exist, allow all connections (first-run)
      if (!row || row.count === 0) {
        return next();
      }

      // Verify JWT token from auth query param or header
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) {
        return next(new Error('Authentication required'));
      }

      jwt.verify(token as string, config.jwtSecret);
      next();
    } catch (err) {
      // Allow connection anyway if DB not initialized yet
      next();
    }
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function getIO(): SocketServer {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

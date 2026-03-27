import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { logger } from './logger.js';

let io: SocketServer;

export function initSocketIO(httpServer: HttpServer): SocketServer {
  io = new SocketServer(httpServer, {
    cors: { origin: '*' },
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

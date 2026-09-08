import { Server as SocketServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { config } from './config.js';
import { logger } from './logger.js';
import { getPrincipalFromToken } from './middleware/auth.js';
import { onSessionsRevoked } from './services/sessions.js';
import { deviceMonitor } from './services/device-monitor.js';
import type { ServerToClientEvents, ClientToServerEvents } from './types/socket-events.js';

interface SocketData {
  userId: string;
  sessionId: string;
}

let io: SocketServer<ClientToServerEvents, ServerToClientEvents, Record<never, never>, SocketData>;

export function isValidSocketToken(token: unknown): boolean {
  return getPrincipalFromToken(token) !== null;
}

export function initSocketIO(httpServer: HttpServer) {
  io = new SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<never, never>,
    SocketData
  >(httpServer, {
    cors: {
      origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : '*',
      credentials: true,
    },
  });

  // Auth middleware: a socket needs the same session a request needs. There
  // is no setup-mode bypass; nothing is pushed to anonymous sockets.
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Authentication required'));
      const principal = getPrincipalFromToken(token);
      if (!principal) return next(new Error('Authentication failed'));
      socket.data.userId = principal.userId;
      socket.data.sessionId = principal.sessionId;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  // A revoked session must lose its live connection as well, otherwise a
  // signed-out browser would keep receiving queue/state events.
  onSessionsRevoked((sessionIds) => disconnectSessions(sessionIds));

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

/** Close every socket bound to one of the given sessions. Returns how many were closed. */
export function disconnectSessions(sessionIds: string[]): number {
  if (!io || sessionIds.length === 0) return 0;
  const wanted = new Set(sessionIds);
  let closed = 0;
  for (const socket of io.sockets.sockets.values()) {
    if (wanted.has(socket.data.sessionId)) {
      socket.emit('session:revoked');
      socket.disconnect(true);
      closed++;
    }
  }
  if (closed > 0) logger.info(`Socket.IO: closed ${closed} connection(s) of revoked sessions`);
  return closed;
}

export function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

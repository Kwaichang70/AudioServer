import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { config, validateConfig } from './config.js';
import { logger } from './logger.js';
import { initSocketIO, getIO } from './socketio.js';
import { healthRouter } from './routes/health.js';
import { libraryRouter } from './routes/library.js';
import { devicesRouter } from './routes/devices.js';
import { playbackRouter } from './routes/playback.js';
import { historyRouter } from './routes/history.js';
import { authRouter } from './routes/auth.js';
import { providersRouter } from './routes/providers.js';
import { radioRouter } from './routes/radio.js';
import { librespotRouter } from './routes/librespot.js';
import { playlistsRouter } from './routes/playlists.js';
import { smartPlaylistsRouter } from './routes/smart-playlists.js';
import { scrobbleRouter } from './routes/scrobble.js';
import { listenbrainzRouter } from './routes/listenbrainz.js';
import { scrobbler } from './services/scrobbler.js';
import { closeDatabase, initDatabase } from './db/index.js';
import { providers } from './providers/registry.js';
import { autoStartLibrespot, stopLibrespot } from './services/librespot.js';
import { playbackService } from './services/playback.js';
import { startWatcher, stopWatcher } from './services/watcher.js';
import { deviceMonitor } from './services/device-monitor.js';
import { initServerPlayer, reconcileAfterRestart } from './services/server-player.js';
import { globalLimiter } from './middleware/rateLimiter.js';
import { requestLogger } from './middleware/requestLogger.js';
import { attachUser, requireAuth } from './middleware/auth.js';
import { announceSetupIfRequired } from './services/setup.js';
import { purgeExpiredSessions } from './services/sessions.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { openApiSpec } from './openapi.js';

const app = express();
app.set('trust proxy', config.trustProxy);
const httpServer = createServer(app);
initSocketIO(httpServer);

// Middleware
app.use(
  helmet({
    // Content-Security-Policy-Report-Only (V02.4): browsers report what an
    // enforcing policy WOULD block to /api/csp-report, without blocking
    // anything yet. Watch the server log for "CSP report" lines while using
    // the SPA (covers, radio streams, Spotify Web Playback SDK, OAuth
    // callbacks); when a full cycle stays quiet, flip reportOnly to false.
    contentSecurityPolicy: {
      reportOnly: true,
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        'frame-ancestors': ["'self'"],
        'form-action': ["'self'"],
        // Vite emits no inline scripts; the Spotify Web Playback SDK is the
        // only third-party script and it loads an iframe of its own.
        'script-src': ["'self'", 'https://sdk.scdn.co'],
        'frame-src': ["'self'", 'https://sdk.scdn.co', 'https://*.spotify.com'],
        // Tailwind is compiled, but React and the SDK set inline style attrs.
        'style-src': ["'self'", "'unsafe-inline'"],
        // Covers/artist images come from providers and radio directories.
        'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
        // Local streams are same-origin; radio and provider streams are not.
        'media-src': ["'self'", 'blob:', 'https:', 'http:'],
        'connect-src': [
          "'self'",
          'ws:',
          'wss:',
          'https://*.spotify.com',
          'https://*.scdn.co',
          'https://*.spotifycdn.com',
        ],
        'worker-src': ["'self'", 'blob:'],
        'manifest-src': ["'self'"],
        'report-uri': ['/api/csp-report'],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow <img src> from SPA origin
  }),
);
// CORS only on the API surface. Two important details:
//  1. Same-origin requests (Origin's host equals the server's Host header)
//     are always allowed. Browsers send Origin for non-safe methods even when
//     same-origin, and we don't want our own SPA to be blocked just because
//     the LAN hostname (e.g. http://diskstation:3001) isn't in the allowlist.
//  2. Disallowed cross-origin requests get { origin: false } instead of a
//     thrown Error. With Error(), the failure bubbles to errorHandler and
//     returns 500 BEFORE requestLogger / route handlers run. With
//     { origin: false } the server still answers the request (without CORS
//     headers); the browser blocks the response, but our server logs cleanly.
app.use(
  '/api',
  cors((req, callback) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    let sameOrigin = false;
    if (origin && host) {
      try {
        sameOrigin = new URL(origin).host === host;
      } catch {
        sameOrigin = false;
      }
    }
    if (!origin || sameOrigin || config.allowedOrigins.includes(origin)) {
      callback(null, { origin: true, credentials: true });
      return;
    }
    callback(null, { origin: false });
  }),
);
// CSP violation reports arrive as application/csp-report (report-uri) or
// application/reports+json (Reporting API); parse them as JSON too.
app.use(
  express.json({
    type: ['application/json', 'application/csp-report', 'application/reports+json'],
  }),
);
app.use(globalLimiter);
app.use(requestLogger);
app.use(attachUser);
app.use(requireAuth);

// Routes
// Machine-readable API description (public — it's documentation). View it in
// editor.swagger.io / Postman, or any OpenAPI-aware IDE.
app.get('/api/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});
// Public sink for Content-Security-Policy-Report-Only violations. Logged at
// warn level with the fields an operator needs to tune the policy; bodies
// are untrusted browser input, so only whitelisted fields are echoed.
app.post('/api/csp-report', (req, res) => {
  const body = req.body as
    | { 'csp-report'?: Record<string, unknown> }
    | Array<{ body?: Record<string, unknown> }>
    | undefined;
  const reports = Array.isArray(body)
    ? body.map((r) => r?.body ?? {})
    : [body?.['csp-report'] ?? (body as Record<string, unknown>) ?? {}];
  for (const r of reports) {
    const pick = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).slice(0, 300) : '');
    logger.warn(
      `CSP report: directive=${pick('violated-directive') || pick('effectiveDirective') || pick('effective-directive')} ` +
        `blocked=${pick('blocked-uri') || pick('blockedURL')} document=${pick('document-uri') || pick('documentURL')}`,
    );
  }
  res.status(204).end();
});
app.use('/api/auth', authRouter);
app.use('/api/health', healthRouter);
app.use('/api/library', libraryRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/playback', playbackRouter);
app.use('/api/history', historyRouter);
app.use('/api/providers', providersRouter);
app.use('/api/radio', radioRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/smart-playlists', smartPlaylistsRouter);
app.use('/api/scrobble', scrobbleRouter);
app.use('/api/listenbrainz', listenbrainzRouter);
app.use('/api/librespot', librespotRouter);

// API 404 must precede the SPA catch-all: otherwise an unknown GET /api/*
// route is answered with index.html and a misleading 200 in production.
app.use('/api', notFoundHandler);

// In production, serve client static files
if (config.nodeEnv === 'production') {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = resolve(__dirname, '../../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(resolve(clientDist, 'index.html'));
    });
    logger.info(`Serving client from ${clientDist}`);
  }
}

// Global error handler — must be LAST (Express recognises it by 4-arity)
app.use(errorHandler);

// ─── Startup ─────────────────────────────────────────────────────

async function main() {
  validateConfig();
  await initDatabase();
  const purged = purgeExpiredSessions();
  if (purged > 0) logger.info(`Sessions: purged ${purged} expired/revoked row(s)`);
  announceSetupIfRequired();
  await providers.initialize();
  playbackService.initialize();
  // Server-driven playback: pushes the next queue track to DLNA/Sonos devices
  // itself, so albums keep playing when every client (tablet) is asleep.
  initServerPlayer();
  // A queue survives a restart; whether the speaker is still playing it is
  // checked, not assumed (V04.3). Runs after listen() so readiness is not
  // delayed by a slow renderer.
  const reconcile = () =>
    reconcileAfterRestart().catch((err) => logger.warn(`ServerPlayer: reconcile failed: ${err}`));
  startWatcher();
  scrobbler.start();
  autoStartLibrespot().catch(() => {});

  httpServer.listen(config.port, '0.0.0.0', () => {
    void reconcile();
    logger.info(`AudioServer running on http://0.0.0.0:${config.port}`);
    logger.info(`Music library paths: ${config.musicLibraryPaths.join(', ')}`);
    logger.info(`Environment: ${config.nodeEnv}`);
  });
}

// ─── Graceful Shutdown ───────────────────────────────────────────

let shutdownPromise: Promise<void> | null = null;

function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    logger.info(`${signal} received, shutting down gracefully...`);
    const timeout = setTimeout(() => {
      logger.error('Shutdown timeout (10s), forcing exit');
      process.exit(1);
    }, 10_000);

    try {
      scrobbler.stop();
      deviceMonitor.stopAll();
      stopWatcher();
      stopLibrespot();

      await new Promise<void>((resolveSocketClose) => {
        try {
          getIO().close((error) => {
            if (error) logger.warn(`Socket.IO close reported: ${error.message}`);
            resolveSocketClose();
          });
        } catch {
          resolveSocketClose();
        }
      });

      if (httpServer.listening) {
        await new Promise<void>((resolveClose, rejectClose) => {
          httpServer.close((error) => {
            if (error) rejectClose(error);
            else resolveClose();
          });
        });
      }
      logger.info('HTTP server closed');
      closeDatabase();
      clearTimeout(timeout);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      clearTimeout(timeout);
      logger.error(`Shutdown failed: ${error}`);
      process.exit(1);
    }
  })();

  return shutdownPromise;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Route handlers are wrapped in asyncHandler, so a rejection that still
// reaches here comes from background work (scanner, device polls, providers).
// Node's default would terminate the process; a music server must not restart
// because one poll failed. Log it with its stack and carry on.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error(`Unhandled promise rejection: ${err.message}\n${err.stack ?? ''}`);
});

// A synchronous uncaught exception leaves state undefined: log it with its
// stack (the JSON log line is what the operator sees in `docker logs`) and let
// the supervisor restart the container.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}\n${err.stack ?? ''}`);
  process.exit(1);
});

main().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});

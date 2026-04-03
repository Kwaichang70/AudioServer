import express from 'express';
import cors from 'cors';
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
import { librespotRouter } from './routes/librespot.js';
import { playlistsRouter } from './routes/playlists.js';
import { initDatabase } from './db/index.js';
import { providers } from './providers/registry.js';
import { autoStartLibrespot, stopLibrespot } from './services/librespot.js';
import { playbackService } from './services/playback.js';
import { startWatcher, stopWatcher } from './services/watcher.js';
import { deviceMonitor } from './services/device-monitor.js';
import { globalLimiter } from './middleware/rateLimiter.js';
import { requestLogger } from './middleware/requestLogger.js';

const app = express();
const httpServer = createServer(app);
initSocketIO(httpServer);

// Middleware
app.use(cors());
app.use(express.json());
app.use(globalLimiter);
app.use(requestLogger);

// Routes
app.use('/api/auth', authRouter);
app.use('/api/health', healthRouter);
app.use('/api/library', libraryRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/playback', playbackRouter);
app.use('/api/history', historyRouter);
app.use('/api/providers', providersRouter);
app.use('/api/playlists', playlistsRouter);
app.use('/api/librespot', librespotRouter);

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

// ─── Startup ─────────────────────────────────────────────────────

async function main() {
  validateConfig();
  await initDatabase();
  await providers.initialize();
  playbackService.initialize();
  startWatcher();
  autoStartLibrespot().catch(() => {});

  httpServer.listen(config.port, '0.0.0.0', () => {
    logger.info(`AudioServer running on http://0.0.0.0:${config.port}`);
    logger.info(`Music library paths: ${config.musicLibraryPaths.join(', ')}`);
    logger.info(`Environment: ${config.nodeEnv}`);
  });
}

// ─── Graceful Shutdown ───────────────────────────────────────────

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down gracefully...`);

  const timeout = setTimeout(() => {
    logger.error('Shutdown timeout (10s), forcing exit');
    process.exit(1);
  }, 10_000);

  httpServer.close(() => {
    logger.info('HTTP server closed');
  });

  try { getIO().close(); } catch {}
  try { deviceMonitor.stopAll(); } catch {}
  try { stopWatcher(); } catch {}
  try { stopLibrespot(); } catch {}

  clearTimeout(timeout);
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});

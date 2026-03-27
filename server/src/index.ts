import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { config } from './config.js';
import { logger } from './logger.js';
import { initSocketIO } from './socketio.js';
import { healthRouter } from './routes/health.js';
import { libraryRouter } from './routes/library.js';
import { devicesRouter } from './routes/devices.js';
import { playbackRouter } from './routes/playback.js';
import { historyRouter } from './routes/history.js';
import { authRouter } from './routes/auth.js';
import { providersRouter } from './routes/providers.js';
import { playlistsRouter } from './routes/playlists.js';
import { initDatabase } from './db/index.js';

const app = express();
const httpServer = createServer(app);
initSocketIO(httpServer);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRouter);
app.use('/api/health', healthRouter);
app.use('/api/library', libraryRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/playback', playbackRouter);
app.use('/api/history', historyRouter);
app.use('/api/providers', providersRouter);
app.use('/api/playlists', playlistsRouter);

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

// Start
async function main() {
  await initDatabase();
  httpServer.listen(config.port, () => {
    logger.info(`AudioServer running on http://localhost:${config.port}`);
    logger.info(`Music library paths: ${config.musicLibraryPaths.join(', ')}`);
  });
}

main().catch((err) => {
  logger.error(`Failed to start: ${err}`);
  process.exit(1);
});

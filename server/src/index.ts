import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config } from './config.js';
import { logger } from './logger.js';
import { initSocketIO } from './socketio.js';
import { healthRouter } from './routes/health.js';
import { libraryRouter } from './routes/library.js';
import { devicesRouter } from './routes/devices.js';
import { playbackRouter } from './routes/playback.js';
import { historyRouter } from './routes/history.js';
import { initDatabase } from './db/index.js';

const app = express();
const httpServer = createServer(app);
initSocketIO(httpServer);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/health', healthRouter);
app.use('/api/library', libraryRouter);
app.use('/api/devices', devicesRouter);
app.use('/api/playback', playbackRouter);
app.use('/api/history', historyRouter);

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

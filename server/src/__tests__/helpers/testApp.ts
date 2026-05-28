import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDatabase, getRawDb } from '../../db/index.js';
import { attachUser, requireAuth } from '../../middleware/auth.js';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler.js';
import { authRouter } from '../../routes/auth.js';
import { healthRouter } from '../../routes/health.js';
import { libraryRouter } from '../../routes/library.js';
import { playbackRouter } from '../../routes/playback.js';
import { playlistsRouter } from '../../routes/playlists.js';
import { providersRouter } from '../../routes/providers.js';

/**
 * Build an isolated Express app + sqlite DB for a single test suite.
 * Returns a teardown function the caller must invoke in afterAll().
 *
 * The DB lives in a fresh tmp directory so suites can't see each other's state.
 * Most routes are mounted so end-to-end flows (auth → protected endpoint) work,
 * but heavy services (scanner, scrobbler, librespot) are intentionally NOT
 * started — tests should focus on HTTP behaviour, not on background jobs.
 */
export async function createTestApp() {
  const tmp = mkdtempSync(join(tmpdir(), 'audioserver-test-'));
  const dbPath = join(tmp, 'test.db');
  await initDatabase(dbPath);

  const app = express();
  app.use(express.json());
  app.use(attachUser);
  app.use(requireAuth);
  app.use('/api/auth', authRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/library', libraryRouter);
  app.use('/api/playback', playbackRouter);
  app.use('/api/playlists', playlistsRouter);
  app.use('/api/providers', providersRouter);
  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    dbPath,
    teardown() {
      try {
        getRawDb().close();
      } catch {
        // ignore — db may not be open
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

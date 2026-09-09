import { Router } from 'express';
import { getRawDb, getSchemaVersion, SCHEMA_VERSION } from '../db/index.js';
import { providers } from '../providers/registry.js';
import { getLibrespotState } from '../services/librespot.js';
import { config } from '../config.js';
import { getLanAddress } from '../utils/network.js';

export const healthRouter = Router();

// Lightweight liveness probe (no DB hit). Use this from container orchestrators
// where you just need to know the process is breathing.
healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/**
 * Readiness probe: can this process actually serve requests right now?
 * Answers 503 while the database is not open, not migrated, or unreadable, so
 * a container orchestrator (Docker HEALTHCHECK, compose, reverse proxy) can
 * tell "process alive" from "safe to route traffic to". Cheap on purpose: one
 * catalog read, no library statistics.
 */
healthRouter.get('/ready', (_req, res) => {
  const check = checkDatabase();
  if (check.status === 'ok') {
    res.json({
      status: 'ready',
      uptime: process.uptime(),
      db: {
        status: 'ok',
        schemaVersion: check.schemaVersion,
        expectedSchemaVersion: SCHEMA_VERSION,
      },
    });
    return;
  }
  res.status(503).json({
    status: 'not_ready',
    uptime: process.uptime(),
    db: { status: 'down', error: check.error, expectedSchemaVersion: SCHEMA_VERSION },
  });
});

type DbCheck = { status: 'ok'; schemaVersion: number } | { status: 'down'; error: string };

function checkDatabase(): DbCheck {
  try {
    const db = getRawDb();
    // `users` is created by the first migration; if it is missing the DB is
    // open but not migrated, which is just as unusable as a closed one.
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get() as { name: string } | undefined;
    if (!table) return { status: 'down', error: 'database is not migrated (users table missing)' };
    return { status: 'ok', schemaVersion: getSchemaVersion() };
  } catch (err) {
    return { status: 'down', error: err instanceof Error ? err.message : String(err) };
  }
}

healthRouter.get('/', (_req, res) => {
  const memUsage = process.memoryUsage();

  // DB health — separate from stats so callers can tell "DB is up but library
  // is empty" from "DB is unreachable".
  let dbStatus: 'ok' | 'down' = 'ok';
  let dbError: string | undefined;
  let dbStats: { artists: number; albums: number; tracks: number } = {
    artists: 0,
    albums: 0,
    tracks: 0,
  };
  let lastScanAt: number | null = null;
  let libraryStats: Record<string, unknown> | null = null;
  try {
    const db = getRawDb();
    dbStats = {
      artists: (db.prepare('SELECT COUNT(*) as c FROM artists').get() as { c: number })?.c ?? 0,
      albums: (db.prepare('SELECT COUNT(*) as c FROM albums').get() as { c: number })?.c ?? 0,
      tracks: (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as { c: number })?.c ?? 0,
    };

    // V06.3: the last scan that finished without failing, from scan_runs.
    lastScanAt =
      (
        db.prepare("SELECT MAX(finished_at) as t FROM scan_runs WHERE status = 'done'").get() as {
          t: number | null;
        }
      )?.t ?? null;

    const totalDuration =
      (db.prepare('SELECT COALESCE(SUM(duration), 0) as d FROM tracks').get() as { d: number })
        ?.d ?? 0;
    const formats = db
      .prepare(
        'SELECT format, COUNT(*) as count FROM tracks WHERE format IS NOT NULL GROUP BY format ORDER BY count DESC',
      )
      .all();
    const sampleRates = db
      .prepare(
        'SELECT sample_rate as sampleRate, COUNT(*) as count FROM tracks WHERE sample_rate IS NOT NULL GROUP BY sample_rate ORDER BY count DESC',
      )
      .all();
    const bitDepths = db
      .prepare(
        'SELECT bit_depth as bitDepth, COUNT(*) as count FROM tracks WHERE bit_depth IS NOT NULL GROUP BY bit_depth ORDER BY count DESC',
      )
      .all();
    const genres = db
      .prepare(
        "SELECT genre, COUNT(*) as count FROM albums WHERE genre IS NOT NULL AND genre != '' GROUP BY genre ORDER BY count DESC LIMIT 20",
      )
      .all();

    libraryStats = { totalDuration, formats, sampleRates, bitDepths, genres };
  } catch (err) {
    dbStatus = 'down';
    dbError = err instanceof Error ? err.message : String(err);
  }

  // Provider status — include "configured" + "available" + "authenticated" so a
  // dashboard can show why a provider isn't usable.
  const providerStatus = {
    local: { available: true, authenticated: true },
    spotify: {
      available: providers.spotify.isAvailable,
      authenticated: providers.spotify.auth.isAuthenticated,
      configured: !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    },
    tidal: {
      available: providers.tidal.isAvailable,
      authenticated: providers.tidal.auth.isAuthenticated,
      configured: !!(process.env.TIDAL_CLIENT_ID && process.env.TIDAL_CLIENT_SECRET),
    },
    qobuz: {
      ...providers.qobuz.getStatus(),
    },
  };

  const status = dbStatus === 'ok' ? 'ok' : 'degraded';

  // Degraded means the database is unusable: nothing behind this endpoint can
  // work, so say so with the status code as well as the body (curl -f, uptime
  // monitors and the Docker HEALTHCHECK only look at the code).
  res.status(status === 'ok' ? 200 : 503).json({
    status,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    lanAddress: getLanAddress(),
    port: config.port,
    environment: process.env.NODE_ENV || 'development',
    db: {
      status: dbStatus,
      ...(dbError ? { error: dbError } : {}),
      schemaVersion: dbStatus === 'ok' ? getSchemaVersion() : null,
      expectedSchemaVersion: SCHEMA_VERSION,
    },
    library: { ...dbStats, lastScanAt },
    libraryStats,
    providers: providerStatus,
    librespot: getLibrespotState(),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024),
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
    },
  });
});

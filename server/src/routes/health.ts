import { Router } from 'express';
import { networkInterfaces } from 'os';
import { getRawDb } from '../db/index.js';
import { providers } from '../providers/registry.js';
import { getLibrespotState } from '../services/librespot.js';

export const healthRouter = Router();

// Lightweight liveness probe (no DB hit). Use this from container orchestrators
// where you just need to know the process is breathing.
healthRouter.get('/live', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

healthRouter.get('/', (_req, res) => {
  const memUsage = process.memoryUsage();

  // DB health — separate from stats so callers can tell "DB is up but library
  // is empty" from "DB is unreachable".
  let dbStatus: 'ok' | 'down' = 'ok';
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

    // Most recent track creation = proxy for "when did the scanner last find something".
    // Cheaper than tracking scan runs in a dedicated table.
    lastScanAt =
      (db.prepare('SELECT MAX(created_at) as t FROM tracks').get() as { t: number | null })?.t ??
      null;

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
  } catch {
    dbStatus = 'down';
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
      available: providers.qobuz.isAvailable,
      authenticated: providers.qobuz.auth.isAuthenticated,
      configured: !!(process.env.QOBUZ_USERNAME && process.env.QOBUZ_PASSWORD),
    },
  };

  const status = dbStatus === 'ok' ? 'ok' : 'degraded';

  res.json({
    status,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    lanAddress: getLanAddress(),
    environment: process.env.NODE_ENV || 'development',
    db: { status: dbStatus },
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

function getLanAddress(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.')) return net.address;
      }
    }
  }
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

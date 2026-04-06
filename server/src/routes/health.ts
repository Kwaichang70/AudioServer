import { Router } from 'express';
import { networkInterfaces } from 'os';
import { getRawDb } from '../db/index.js';
import { providers } from '../providers/registry.js';
import { getLibrespotState } from '../services/librespot.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  const memUsage = process.memoryUsage();

  // DB stats
  let dbStats: any = { artists: 0, albums: 0, tracks: 0 };
  let libraryStats: any = null;
  try {
    const db = getRawDb();
    dbStats = {
      artists: (db.prepare('SELECT COUNT(*) as c FROM artists').get() as any)?.c ?? 0,
      albums: (db.prepare('SELECT COUNT(*) as c FROM albums').get() as any)?.c ?? 0,
      tracks: (db.prepare('SELECT COUNT(*) as c FROM tracks').get() as any)?.c ?? 0,
    };

    // Extended stats
    const totalDuration = (db.prepare('SELECT COALESCE(SUM(duration), 0) as d FROM tracks').get() as any)?.d ?? 0;
    const formats = db.prepare('SELECT format, COUNT(*) as count FROM tracks WHERE format IS NOT NULL GROUP BY format ORDER BY count DESC').all();
    const sampleRates = db.prepare('SELECT sample_rate as sampleRate, COUNT(*) as count FROM tracks WHERE sample_rate IS NOT NULL GROUP BY sample_rate ORDER BY count DESC').all();
    const bitDepths = db.prepare('SELECT bit_depth as bitDepth, COUNT(*) as count FROM tracks WHERE bit_depth IS NOT NULL GROUP BY bit_depth ORDER BY count DESC').all();
    const genres = db.prepare('SELECT genre, COUNT(*) as count FROM albums WHERE genre IS NOT NULL AND genre != \'\' GROUP BY genre ORDER BY count DESC LIMIT 20').all();

    libraryStats = { totalDuration, formats, sampleRates, bitDepths, genres };
  } catch {}

  // Provider status
  const providerStatus = {
    spotify: { authenticated: providers.spotify.auth.isAuthenticated },
    tidal: { authenticated: providers.tidal.auth.isAuthenticated },
    qobuz: { authenticated: providers.qobuz.auth.isAuthenticated },
  };

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    lanAddress: getLanAddress(),
    environment: process.env.NODE_ENV || 'development',
    library: dbStats,
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

import { Router } from 'express';
import { networkInterfaces } from 'os';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    lanAddress: getLanAddress(),
  });
});

function getLanAddress(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // Skip loopback and non-IPv4
      if (net.family === 'IPv4' && !net.internal) {
        // Prefer 192.168.x.x addresses
        if (net.address.startsWith('192.168.')) return net.address;
      }
    }
  }
  // Fallback to any non-internal IPv4
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

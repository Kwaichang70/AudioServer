import { networkInterfaces } from 'os';

/**
 * Best-guess LAN IPv4 address of this server. Used to build URLs that OTHER
 * devices on the network (DLNA renderers, Sonos) must be able to reach —
 * `localhost` or the Docker-internal address would not work for them.
 * Prefers a 192.168.x.x address, falls back to any non-internal IPv4.
 */
export function getLanAddress(): string | null {
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

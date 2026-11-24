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

/** Where a caller's address lies, as far as an address can tell. */
export type AddressClass = 'loopback' | 'tailscale' | 'private' | 'public';

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return numbers.every((x) => x >= 0 && x <= 255) ? numbers : null;
}

/**
 * Classify a caller's address (`req.ip`).
 *
 * - tailscale: 100.64.0.0/10, the range Tailscale hands out, and its IPv6
 *   range fd7a:115c:a1e0::/48. Only a device signed in to the tailnet can
 *   send from such an address over the Tailscale interface.
 * - private: the home network (10/8, 172.16/12, 192.168/16, fc00::/7, fe80::/10).
 * - loopback: this machine itself.
 * - public: everything else, and anything that is not an address.
 */
export function classifyAddress(raw: string | undefined | null): AddressClass {
  if (!raw) return 'public';
  let address = raw.trim().toLowerCase();
  if (address.startsWith('::ffff:')) address = address.slice(7); // IPv4 in IPv6 clothing
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b] = v4;
    if (a === 127) return 'loopback';
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    return 'public';
  }
  if (address === '::1') return 'loopback';
  if (address.startsWith('fd7a:115c:a1e0:')) return 'tailscale';
  if (/^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return 'private';
  return 'public';
}

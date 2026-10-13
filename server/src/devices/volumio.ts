import multicastDns from 'multicast-dns';
import { logger } from '../logger.js';
import type {
  DeviceController,
  OutputDevice,
  DevicePlaybackStatus,
  TrackMetadata,
} from '@audioserver/shared';

interface VolumioDevice {
  id: string;
  name: string;
  host: string;
  port: number;
  isOnline: boolean;
}

interface VolumioStateResponse {
  volume?: number;
  status?: string;
  seek?: number;
  duration?: number;
}

/** A Volumio that announced itself on the network (R09.4). */
export interface VolumioAnnouncement {
  host: string;
  port: number;
  /** The name set on the device ("Living room"), from its TXT record. */
  name?: string;
  uuid?: string;
}

/** What Volumio announces: `_Volumio._tcp` on port 3000 (volumiodiscovery plugin). */
export const VOLUMIO_SERVICE = '_Volumio._tcp.local';

interface MdnsRecord {
  name: string;
  type: string;
  data: unknown;
}

const txtValue = (data: unknown, key: string): string | undefined => {
  const entries = Array.isArray(data) ? data : [data];
  for (const entry of entries) {
    const text = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry ?? '');
    if (text.startsWith(`${key}=`)) return text.slice(key.length + 1);
  }
  return undefined;
};

/**
 * Turn mDNS answers into Volumio players: PTR names an instance, its SRV
 * gives the port and the host name, an A record gives the address, and the
 * TXT record the name the owner gave it. Records may arrive in any packet
 * and in any section, so all of them are pooled first.
 */
export function parseVolumioAnswers(records: MdnsRecord[]): VolumioAnnouncement[] {
  const lower = (name: string) => name.toLowerCase();
  const instances = new Set(
    records
      .filter((r) => r.type === 'PTR' && lower(r.name) === lower(VOLUMIO_SERVICE))
      .map((r) => String(r.data)),
  );
  const out = new Map<string, VolumioAnnouncement>();
  for (const instance of instances) {
    const srv = records.find((r) => r.type === 'SRV' && r.name === instance)?.data as
      | { port?: number; target?: string }
      | undefined;
    if (!srv?.target) continue;
    const address = records.find(
      (r) => r.type === 'A' && lower(r.name) === lower(srv.target!),
    )?.data;
    const host = typeof address === 'string' ? address : srv.target;
    const txt = records.find((r) => r.type === 'TXT' && r.name === instance)?.data;
    out.set(host, {
      host,
      port: srv.port || 3000,
      name: txtValue(txt, 'volumioName') ?? instance.split('.')[0],
      uuid: txtValue(txt, 'UUID'),
    });
  }
  return [...out.values()];
}

/** Ask the network who runs Volumio, and listen for a few seconds. */
function browseMdns(timeoutMs: number): Promise<MdnsRecord[]> {
  return new Promise((resolve) => {
    const records: MdnsRecord[] = [];
    let mdns: ReturnType<typeof multicastDns>;
    try {
      mdns = multicastDns();
    } catch (err) {
      logger.debug(`Volumio: mDNS unavailable: ${err}`);
      resolve([]);
      return;
    }
    mdns.on('error', (err) => logger.debug(`Volumio: mDNS error: ${err}`));
    mdns.on('response', (packet) => {
      for (const r of [...(packet.answers ?? []), ...(packet.additionals ?? [])]) {
        records.push({ name: r.name, type: r.type, data: (r as { data?: unknown }).data });
      }
    });
    mdns.query({ questions: [{ name: VOLUMIO_SERVICE, type: 'PTR' }] });
    setTimeout(() => {
      mdns.destroy();
      resolve(records);
    }, timeoutMs);
  });
}

let browse = browseMdns;

/** Tests replace the network with a fixed set of answers. */
export function configureVolumioDiscovery(fn: typeof browseMdns | null): void {
  browse = fn ?? browseMdns;
}

/**
 * Volumio controller using Volumio's native REST API (port 3000).
 * More reliable than DLNA for Volumio devices.
 *
 * Found two ways (R09.4): the players listed in VOLUMIO_DEVICES, and every
 * Volumio that answers an mDNS query on the network (set VOLUMIO_MDNS=false
 * to stop asking). mDNS needs the container on the host network, as SSDP
 * already does.
 *
 * Volumio's REST API has no "next track in advance" (no setNextUri here):
 * `addToQueue` exists, but whether it plays a stream url gaplessly after the
 * current one is unverified, so the server starts each track itself.
 */
export class VolumioController implements DeviceController {
  readonly deviceType = 'volumio' as const;
  private devices = new Map<string, VolumioDevice>();

  async discover(): Promise<OutputDevice[]> {
    this.devices.clear();

    // Probe known Volumio addresses from env
    const hosts = (process.env.VOLUMIO_DEVICES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    await Promise.allSettled(
      hosts.map(async (hostPort) => {
        const [host, port = '3000'] = hostPort.split(':');
        try {
          const res = await fetch(`http://${host}:${port}/api/v1/getState`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) return;
          const state = (await res.json()) as VolumioStateResponse;
          // If it responds with a valid state object, it's a Volumio
          if (typeof state.volume !== 'number') return;
          const id = `volumio-${host}`;
          const name = `Volumio (${host})`;

          this.devices.set(id, { id, name, host, port: parseInt(port), isOnline: true });
          logger.info(`Volumio found: ${name} at ${host}:${port}`);
        } catch {
          // Not reachable
        }
      }),
    );

    if (process.env.VOLUMIO_MDNS !== 'false') await this.discoverMdns();

    return this.getDeviceList();
  }

  /**
   * Players that announce themselves. The id is `volumio-<address>`, the same
   * as a configured one, so a room bound to a configured player keeps working
   * when it is found this way too; a player already configured is not added
   * twice. Each is asked for its state before it is listed, like the
   * configured ones.
   */
  private async discoverMdns(): Promise<void> {
    let found: VolumioAnnouncement[] = [];
    try {
      found = parseVolumioAnswers(await browse(3000));
    } catch (err) {
      logger.debug(`Volumio: mDNS discovery failed: ${err}`);
      return;
    }
    await Promise.allSettled(
      found.map(async ({ host, port, name }) => {
        const id = `volumio-${host}`;
        if (this.devices.has(id)) return;
        try {
          const res = await fetch(`http://${host}:${port}/api/v1/getState`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) return;
          const state = (await res.json()) as VolumioStateResponse;
          if (typeof state.volume !== 'number') return;
          const label = name ? `${name} (Volumio)` : `Volumio (${host})`;
          this.devices.set(id, { id, name: label, host, port, isOnline: true });
          logger.info(`Volumio announced itself: ${label} at ${host}:${port}`);
        } catch {
          // Announced but not answering: not listed.
        }
      }),
    );
  }

  private getDeviceList(): OutputDevice[] {
    return Array.from(this.devices.values()).map((d) => ({
      id: d.id,
      name: d.name,
      type: 'volumio' as const,
      host: d.host,
      isOnline: d.isOnline,
    }));
  }

  private getDevice(deviceId: string): VolumioDevice {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`Volumio device not found: ${deviceId}`);
    return device;
  }

  private baseUrl(device: VolumioDevice): string {
    return `http://${device.host}:${device.port}`;
  }

  async play(deviceId: string, streamUrl: string, metadata?: TrackMetadata): Promise<void> {
    const device = this.getDevice(deviceId);
    const base = this.baseUrl(device);

    const res = await fetch(`${base}/api/v1/replaceAndPlay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: {
          uri: streamUrl,
          title: metadata?.title || 'Unknown',
          artist: metadata?.artist || 'Unknown',
          album: metadata?.album || 'Unknown',
          service: 'webradio',
          type: 'webradio',
        },
      }),
    });

    if (!res.ok) throw new Error(`Volumio play failed: ${await res.text()}`);
    logger.info(`Volumio play: ${metadata?.title || 'track'} → ${device.name}`);
  }

  async pause(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await fetch(`${this.baseUrl(device)}/api/v1/commands/?cmd=pause`);
  }

  async resume(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await fetch(`${this.baseUrl(device)}/api/v1/commands/?cmd=play`);
  }

  async stop(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await fetch(`${this.baseUrl(device)}/api/v1/commands/?cmd=stop`);
  }

  /**
   * Jump inside the current track (R01.1). Volumio takes seconds directly,
   * so there is no REL_TIME string here.
   */
  async seek(deviceId: string, position: number): Promise<void> {
    const device = this.getDevice(deviceId);
    const res = await fetch(
      `${this.baseUrl(device)}/api/v1/commands/?cmd=seek&position=${Math.max(0, Math.floor(position))}`,
    );
    if (!res.ok) throw new Error(`${device.name} refused seek (HTTP ${res.status})`);
  }

  async next(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await fetch(`${this.baseUrl(device)}/api/v1/commands/?cmd=next`);
  }

  async previous(deviceId: string): Promise<void> {
    const device = this.getDevice(deviceId);
    await fetch(`${this.baseUrl(device)}/api/v1/commands/?cmd=prev`);
  }

  async setVolume(deviceId: string, volume: number): Promise<void> {
    const device = this.getDevice(deviceId);
    await fetch(`${this.baseUrl(device)}/api/v1/commands/?cmd=volume&volume=${Math.round(volume)}`);
  }

  async getVolume(deviceId: string): Promise<number> {
    const device = this.getDevice(deviceId);
    try {
      const res = await fetch(`${this.baseUrl(device)}/api/v1/getState`);
      const state = (await res.json()) as VolumioStateResponse;
      return state.volume ?? 50;
    } catch {
      return 50;
    }
  }

  async getPlaybackState(deviceId: string): Promise<DevicePlaybackStatus> {
    const device = this.getDevice(deviceId);
    const res = await fetch(`${this.baseUrl(device)}/api/v1/getState`);
    if (!res.ok) throw new Error(`Volumio status failed with HTTP ${res.status}`);
    const state = (await res.json()) as VolumioStateResponse;
    return {
      state: state.status === 'play' ? 'playing' : state.status === 'pause' ? 'paused' : 'stopped',
      position: (state.seek || 0) / 1000,
      duration: state.duration || 0,
      volume: state.volume || 50,
    };
  }
}

import { logger } from '../logger.js';
import type { DeviceController, OutputDevice, DevicePlaybackStatus, TrackMetadata } from '@audioserver/shared';

interface VolumioDevice {
  id: string;
  name: string;
  host: string;
  port: number;
  isOnline: boolean;
}

/**
 * Volumio controller using Volumio's native REST API (port 3000).
 * More reliable than DLNA for Volumio devices.
 */
export class VolumioController implements DeviceController {
  readonly deviceType = 'volumio' as const;
  private devices = new Map<string, VolumioDevice>();

  async discover(): Promise<OutputDevice[]> {
    this.devices.clear();

    // Probe known Volumio addresses from env
    const hosts = (process.env.VOLUMIO_DEVICES || '').split(',').map(s => s.trim()).filter(Boolean);

    await Promise.allSettled(
      hosts.map(async (hostPort) => {
        const [host, port = '3000'] = hostPort.split(':');
        try {
          const res = await fetch(`http://${host}:${port}/api/v1/getState`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) return;
          const state = await res.json() as any;
          // If it responds with a valid state object, it's a Volumio
          if (typeof state.volume !== 'number') return;
          const id = `volumio-${host}`;
          const name = `Volumio (${host})`;

          this.devices.set(id, { id, name, host, port: parseInt(port), isOnline: true });
          logger.info(`Volumio found: ${name} at ${host}:${port}`);
        } catch {
          // Not reachable
        }
      })
    );

    return this.getDeviceList();
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
      const state = await res.json() as any;
      return state.volume ?? 50;
    } catch {
      return 50;
    }
  }

  async getPlaybackState(deviceId: string): Promise<DevicePlaybackStatus> {
    const device = this.getDevice(deviceId);
    try {
      const res = await fetch(`${this.baseUrl(device)}/api/v1/getState`);
      const state = await res.json() as any;
      return {
        state: state.status === 'play' ? 'playing' : state.status === 'pause' ? 'paused' : 'stopped',
        position: (state.seek || 0) / 1000,
        duration: state.duration || 0,
        volume: state.volume || 50,
      };
    } catch {
      return { state: 'stopped', position: 0, duration: 0, volume: 50 };
    }
  }
}

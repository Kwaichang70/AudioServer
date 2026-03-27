import type { DeviceController, OutputDevice, DevicePlaybackStatus, TrackMetadata } from '@audioserver/shared';
import { DlnaController } from './dlna.js';
import { SonosController } from './sonos.js';
import { logger } from '../logger.js';

/**
 * Central device manager that aggregates all device controllers.
 * Always includes a "browser" virtual device for web playback.
 */
export class DeviceManager {
  private controllers: DeviceController[] = [];
  private cachedDevices: OutputDevice[] = [];
  private lastDiscovery = 0;
  private readonly CACHE_TTL = 30_000; // 30 seconds

  constructor() {
    this.controllers.push(new DlnaController());
    this.controllers.push(new SonosController());
  }

  async getDevices(forceRefresh = false): Promise<OutputDevice[]> {
    const now = Date.now();
    if (!forceRefresh && this.cachedDevices.length > 0 && now - this.lastDiscovery < this.CACHE_TTL) {
      return this.cachedDevices;
    }

    logger.info('Discovering devices...');
    const browser: OutputDevice = {
      id: 'browser',
      name: 'This Browser',
      type: 'browser',
      isOnline: true,
    };

    const discovered: OutputDevice[] = [browser];

    for (const controller of this.controllers) {
      try {
        const devices = await controller.discover();
        discovered.push(...devices);
        logger.info(`${controller.deviceType}: found ${devices.length} device(s)`);
      } catch (err) {
        logger.warn(`${controller.deviceType} discovery failed: ${err}`);
      }
    }

    this.cachedDevices = discovered;
    this.lastDiscovery = now;
    return discovered;
  }

  private getController(deviceType: string): DeviceController | undefined {
    return this.controllers.find((c) => c.deviceType === deviceType);
  }

  async play(deviceId: string, streamUrl: string, metadata?: TrackMetadata): Promise<void> {
    const device = (await this.getDevices()).find((d) => d.id === deviceId);
    if (!device || device.type === 'browser') return; // browser playback is client-side
    const controller = this.getController(device.type);
    if (controller) await controller.play(deviceId, streamUrl, metadata);
  }

  async pause(deviceId: string): Promise<void> {
    const device = (await this.getDevices()).find((d) => d.id === deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller) await controller.pause(deviceId);
  }

  async resume(deviceId: string): Promise<void> {
    const device = (await this.getDevices()).find((d) => d.id === deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller) await controller.resume(deviceId);
  }

  async stop(deviceId: string): Promise<void> {
    const device = (await this.getDevices()).find((d) => d.id === deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller) await controller.stop(deviceId);
  }

  async setVolume(deviceId: string, volume: number): Promise<void> {
    const device = (await this.getDevices()).find((d) => d.id === deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller) await controller.setVolume(deviceId, volume);
  }

  async getPlaybackState(deviceId: string): Promise<DevicePlaybackStatus> {
    const device = (await this.getDevices()).find((d) => d.id === deviceId);
    if (!device || device.type === 'browser') {
      return { state: 'stopped', position: 0, duration: 0, volume: 50 };
    }
    const controller = this.getController(device.type);
    if (controller) return controller.getPlaybackState(deviceId);
    return { state: 'stopped', position: 0, duration: 0, volume: 50 };
  }
}

// Singleton
export const deviceManager = new DeviceManager();

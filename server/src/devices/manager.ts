import type {
  DeviceController,
  OutputDevice,
  DevicePlaybackStatus,
  TrackMetadata,
} from '@audioserver/shared';
import { DlnaController } from './dlna.js';
import { SonosController } from './sonos.js';
import { VolumioController } from './volumio.js';
import { logger } from '../logger.js';
import { DeviceStateMachine } from './state-machine.js';

/**
 * Central device manager that aggregates all device controllers.
 * Always includes a "browser" virtual device for web playback.
 */
export class DeviceManager {
  private controllers: DeviceController[] = [];
  private cachedDevices: OutputDevice[] = [];
  private lastDiscovery = 0;
  private readonly CACHE_TTL = 300_000; // 5 minutes
  private readonly stateMachine = new DeviceStateMachine();

  constructor() {
    this.controllers.push(new VolumioController());
    this.controllers.push(new DlnaController());
    this.controllers.push(new SonosController());
  }

  async getDevices(forceRefresh = false): Promise<OutputDevice[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedDevices.length > 0 &&
      now - this.lastDiscovery < this.CACHE_TTL
    ) {
      return this.withSessionState(this.cachedDevices);
    }

    logger.info('Discovering devices...');
    const browser: OutputDevice = {
      id: 'browser',
      name: 'This Browser',
      type: 'browser',
      isOnline: true,
    };

    const discovered: OutputDevice[] = [browser];

    if (
      process.env.NODE_ENV === 'test' &&
      process.env.AUDIOSERVER_DISCOVER_DEVICES_IN_TESTS !== 'true'
    ) {
      this.cachedDevices = discovered;
      this.lastDiscovery = now;
      return this.withSessionState(discovered);
    }

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
    return this.withSessionState(discovered);
  }

  private getController(deviceType: string): DeviceController | undefined {
    return this.controllers.find((c) => c.deviceType === deviceType);
  }

  /** Find device in cache without triggering discovery */
  private findCachedDevice(deviceId: string): OutputDevice | undefined {
    return this.cachedDevices.find((d) => d.id === deviceId);
  }

  async play(deviceId: string, streamUrl: string, metadata?: TrackMetadata): Promise<void> {
    const device = this.findCachedDevice(deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (!controller) throw new Error(`No controller for device type: ${device.type}`);

    this.stateMachine.transition(deviceId, 'loading', { track: metadata });
    try {
      await controller.play(deviceId, streamUrl, metadata);
      this.stateMachine.transition(deviceId, 'playing', { track: metadata });
    } catch (err) {
      // Retry once
      logger.warn(`Device play failed on ${device.name}, retrying: ${err}`);
      try {
        await new Promise((r) => setTimeout(r, 1000));
        this.stateMachine.transition(deviceId, 'loading', { track: metadata });
        await controller.play(deviceId, streamUrl, metadata);
        this.stateMachine.transition(deviceId, 'playing', { track: metadata });
      } catch (retryErr) {
        logger.error(`Device play retry failed on ${device.name}: ${retryErr}`);
        this.stateMachine.transition(deviceId, 'error', { error: retryErr, track: metadata });
        throw retryErr;
      }
    }
  }

  async setNextUri(deviceId: string, streamUrl: string, metadata?: TrackMetadata): Promise<void> {
    const device = this.findCachedDevice(deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller?.setNextUri) {
      await controller.setNextUri(deviceId, streamUrl, metadata);
    }
  }

  async pause(deviceId: string): Promise<void> {
    const device = this.findCachedDevice(deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller) {
      await controller.pause(deviceId);
      this.stateMachine.transition(deviceId, 'paused');
    }
  }

  async resume(deviceId: string): Promise<void> {
    const device = this.findCachedDevice(deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller) {
      await controller.resume(deviceId);
      this.stateMachine.transition(deviceId, 'playing');
    }
  }

  async stop(deviceId: string): Promise<void> {
    const device = this.findCachedDevice(deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller) {
      await controller.stop(deviceId);
      this.stateMachine.transition(deviceId, 'stopped');
    }
  }

  async setVolume(deviceId: string, volume: number): Promise<void> {
    const device = this.findCachedDevice(deviceId);
    if (!device || device.type === 'browser') return;
    const controller = this.getController(device.type);
    if (controller) await controller.setVolume(deviceId, volume);
  }

  async getPlaybackState(deviceId: string): Promise<DevicePlaybackStatus> {
    const device = this.findCachedDevice(deviceId);
    if (!device || device.type === 'browser') {
      return { state: 'stopped', position: 0, duration: 0, volume: 50 };
    }
    const controller = this.getController(device.type);
    if (controller) {
      const status = await controller.getPlaybackState(deviceId);
      const session = this.stateMachine.reconcilePlaybackState(deviceId, status.state);
      return { ...status, deviceState: session.state, lastError: session.lastError };
    }
    return { state: 'stopped', position: 0, duration: 0, volume: 50 };
  }

  private withSessionState(devices: OutputDevice[]): OutputDevice[] {
    return devices.map((device) => {
      const session = this.stateMachine.get(device.id);
      return {
        ...device,
        playbackState: session.state,
        playbackStateUpdatedAt: session.updatedAt,
        lastError: session.lastError,
      };
    });
  }
}

// Singleton
export const deviceManager = new DeviceManager();

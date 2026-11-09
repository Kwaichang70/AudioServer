import type {
  DeviceController,
  OutputDevice,
  DevicePlaybackStatus,
  TrackMetadata,
} from '@audioserver/shared';
import { DlnaController } from './dlna.js';
import { SonosController } from './sonos.js';
import { VolumioController } from './volumio.js';
import { noteSeek } from '../services/seek-log.js';
import { logger } from '../logger.js';
import { DeviceStateMachine } from './state-machine.js';

/**
 * Central device manager that aggregates all device controllers.
 * Always includes a "browser" virtual device for web playback.
 */
/** The server cannot reach this device: not found, also not after a fresh discovery. */
export class DeviceUnavailableError extends Error {
  constructor(public deviceId: string) {
    super(`${deviceId} is not on the network (not found after a fresh search)`);
    this.name = 'DeviceUnavailableError';
  }
}

/** Options for starting a stream on a speaker. */
export interface PlayOptions {
  /** Aborts the attempt when the caller gave up on it (P06). */
  signal?: AbortSignal;
  /**
   * Try once more after a failure (default true, for a tab that asks once).
   * The server player retries itself with a fresh URL, so it passes false:
   * two retry layers on one speaker sent overlapping Stop/SetURI/Play.
   */
  retry?: boolean;
}

/** Outputs the device manager does not drive: the tab plays, or Spotify does. */
function isUnmanaged(deviceId: string): boolean {
  return deviceId === 'browser' || deviceId.startsWith('spotify-connect:');
}

const IDLE_STATUS: DevicePlaybackStatus = {
  state: 'stopped',
  position: 0,
  duration: 0,
  volume: 50,
};

export class DeviceManager {
  private controllers: DeviceController[];
  private cachedDevices: OutputDevice[] = [];
  private lastDiscovery = 0;
  private readonly CACHE_TTL = 300_000; // 5 minutes
  private readonly stateMachine = new DeviceStateMachine();
  /** The discovery under way, shared by everyone who asks meanwhile (P10). */
  private discovery: Promise<OutputDevice[]> | null = null;
  /** Tests hand in their own controllers; those always run, also under NODE_ENV=test. */
  private readonly injected: boolean;

  constructor(controllers?: DeviceController[]) {
    this.injected = controllers !== undefined;
    this.controllers = controllers ?? [
      new VolumioController(),
      new DlnaController(),
      new SonosController(),
    ];
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
    this.discovery ??= this.discoverAll().finally(() => {
      this.discovery = null;
    });
    return this.withSessionState(await this.discovery);
  }

  /**
   * Ask every controller at once (P10): one after the other took DLNA 4 s +
   * Sonos 5 s + mDNS 3 s. Each controller keeps what it knew until its own
   * answer is in, so commands keep working while a search runs (P01).
   */
  private async discoverAll(): Promise<OutputDevice[]> {
    const browser: OutputDevice = {
      id: 'browser',
      name: 'This Browser',
      type: 'browser',
      isOnline: true,
    };
    const discovered: OutputDevice[] = [browser];

    if (
      !this.injected &&
      process.env.NODE_ENV === 'test' &&
      process.env.AUDIOSERVER_DISCOVER_DEVICES_IN_TESTS !== 'true'
    ) {
      this.cachedDevices = discovered;
      this.lastDiscovery = Date.now();
      return discovered;
    }

    logger.info('Discovering devices...');
    const results = await Promise.allSettled(this.controllers.map((c) => c.discover()));
    results.forEach((result, i) => {
      const type = this.controllers[i].deviceType;
      if (result.status === 'fulfilled') {
        discovered.push(...result.value);
        const silent = result.value.filter((d) => !d.isOnline).length;
        logger.info(
          `${type}: found ${result.value.length - silent} device(s)` +
            (silent > 0 ? `, ${silent} known but silent this round` : ''),
        );
      } else {
        logger.warn(`${type} discovery failed: ${result.reason}`);
      }
    });

    this.cachedDevices = discovered;
    this.lastDiscovery = Date.now();
    return discovered;
  }

  private getController(deviceType: string): DeviceController | undefined {
    return this.controllers.find((c) => c.deviceType === deviceType);
  }

  /** The controller driving a device type, for code that asks it what it supports (V11.1). */
  controllerFor(deviceType: string): DeviceController | undefined {
    return this.getController(deviceType);
  }

  /** The kind of output a device is ('sonos', 'dlna', …), from the last discovery. */
  deviceType(deviceId: string): OutputDevice['type'] | null {
    return this.findCachedDevice(deviceId)?.type ?? null;
  }

  /** Find device in cache without triggering discovery */
  private findCachedDevice(deviceId: string): OutputDevice | undefined {
    return this.cachedDevices.find((d) => d.id === deviceId);
  }

  /**
   * A device the server must send a command to. Not known (yet) — after a
   * restart, or it dropped off the network — means one fresh discovery
   * (shared with any search already under way), then a clear failure:
   * reporting success for a command that went nowhere made the server
   * believe a speaker played that never got the track, or stopped while it
   * played on (P01).
   */
  private async requireDevice(deviceId: string): Promise<OutputDevice | null> {
    if (isUnmanaged(deviceId)) return null;
    let device = this.findCachedDevice(deviceId);
    if (!device) {
      await this.getDevices(true);
      device = this.findCachedDevice(deviceId);
    }
    if (!device) throw new DeviceUnavailableError(deviceId);
    return device.type === 'browser' ? null : device;
  }

  async play(
    deviceId: string,
    streamUrl: string,
    metadata?: TrackMetadata,
    options: PlayOptions = {},
  ): Promise<void> {
    const device = await this.requireDevice(deviceId);
    if (!device) return;
    const controller = this.getController(device.type);
    if (!controller) throw new Error(`No controller for device type: ${device.type}`);
    const { signal, retry = true } = options;

    this.stateMachine.transition(deviceId, 'loading', { track: metadata });
    try {
      await controller.play(deviceId, streamUrl, metadata, signal);
      this.stateMachine.transition(deviceId, 'playing', { track: metadata });
    } catch (err) {
      if (!retry || signal?.aborted) {
        this.stateMachine.transition(deviceId, 'error', { error: err, track: metadata });
        throw err;
      }
      // Retry once
      logger.warn(`Device play failed on ${device.name}, retrying: ${err}`);
      try {
        await new Promise((r) => setTimeout(r, 1000));
        this.stateMachine.transition(deviceId, 'loading', { track: metadata });
        await controller.play(deviceId, streamUrl, metadata, signal);
        this.stateMachine.transition(deviceId, 'playing', { track: metadata });
      } catch (retryErr) {
        logger.error(`Device play retry failed on ${device.name}: ${retryErr}`);
        this.stateMachine.transition(deviceId, 'error', { error: retryErr, track: metadata });
        throw retryErr;
      }
    }
  }

  async setNextUri(
    deviceId: string,
    streamUrl: string,
    metadata?: TrackMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    const device = await this.requireDevice(deviceId);
    if (!device) return;
    const controller = this.getController(device.type);
    // A controller without the action must say so: returning quietly would
    // make the server believe the next track was handed over, and then wait
    // for a device that never starts it (Volumio stopped after one track).
    if (!controller?.setNextUri) {
      throw new Error(`${device.name} does not take the next track in advance`);
    }
    await controller.setNextUri(deviceId, streamUrl, metadata, signal);
  }

  /**
   * Jump inside the current track on a speaker (R01.1). Returns false when
   * this output has no seek at all — the browser seeks itself, and a
   * controller without the method cannot be asked. A device that has the
   * method but refuses throws, because that is a failure the caller must
   * report rather than swallow.
   */
  async seek(deviceId: string, position: number): Promise<boolean> {
    const device = this.findCachedDevice(deviceId);
    if (!device || device.type === 'browser') return false;
    const controller = this.getController(device.type);
    if (!controller?.seek) return false;
    // Noted before asking: the next status poll may already see 0:01.
    noteSeek(deviceId);
    await controller.seek(deviceId, position);
    return true;
  }

  async pause(deviceId: string): Promise<void> {
    const device = await this.requireDevice(deviceId);
    if (!device) return;
    const controller = this.getController(device.type);
    if (controller) {
      await controller.pause(deviceId);
      this.stateMachine.transition(deviceId, 'paused');
    }
  }

  async resume(deviceId: string): Promise<void> {
    const device = await this.requireDevice(deviceId);
    if (!device) return;
    const controller = this.getController(device.type);
    if (controller) {
      await controller.resume(deviceId);
      this.stateMachine.transition(deviceId, 'playing');
    }
  }

  async stop(deviceId: string): Promise<void> {
    const device = await this.requireDevice(deviceId);
    if (!device) return;
    const controller = this.getController(device.type);
    if (controller) {
      await controller.stop(deviceId);
      this.stateMachine.transition(deviceId, 'stopped');
    }
  }

  async setVolume(deviceId: string, volume: number): Promise<void> {
    const device = await this.requireDevice(deviceId);
    if (!device) return;
    const controller = this.getController(device.type);
    if (controller) await controller.setVolume(deviceId, volume);
  }

  /**
   * What the speaker reports. A speaker the server does not know is an
   * error, not "stopped" (P01): a made-up "stopped" for a speaker that plays
   * on closed its listening session, and near the end of a track advanced
   * the queue and skipped one. The status poll runs every few seconds, so
   * this does not search the network itself; the monitor counts failures.
   */
  async getPlaybackState(deviceId: string): Promise<DevicePlaybackStatus> {
    if (isUnmanaged(deviceId)) return { ...IDLE_STATUS };
    const device = this.findCachedDevice(deviceId);
    if (!device) throw new DeviceUnavailableError(deviceId);
    if (device.type === 'browser') return { ...IDLE_STATUS };
    const controller = this.getController(device.type);
    if (!controller) throw new Error(`No controller for device type: ${device.type}`);
    const status = await controller.getPlaybackState(deviceId);
    const session = this.stateMachine.reconcilePlaybackState(deviceId, status.state);
    return { ...status, deviceState: session.state, lastError: session.lastError };
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

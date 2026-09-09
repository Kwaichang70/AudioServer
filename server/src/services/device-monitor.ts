import { deviceManager } from '../devices/manager.js';
import { playbackService } from './playback.js';
import { getIO } from '../socketio.js';
import { logger } from '../logger.js';
import type { DevicePlaybackStatus, OutputDevice } from '@audioserver/shared';
import type { DevicePlaybackUpdate, ServerToClientEvents } from '../types/socket-events.js';

interface DeviceMonitorIo {
  emit: <EventName extends keyof ServerToClientEvents>(
    event: EventName,
    ...args: Parameters<ServerToClientEvents[EventName]>
  ) => boolean | void;
}

interface PlaybackStateSync {
  setState(updates: {
    deviceId?: string;
    state?: 'playing' | 'paused' | 'stopped';
    position?: number;
  }): void;
  /** The device the household session is bound to; other monitored devices only feed the UI. */
  getActiveDeviceId?(): string;
}

interface DeviceMonitorDependencies {
  getDevices: () => Promise<OutputDevice[]>;
  getPlaybackState: (deviceId: string) => Promise<DevicePlaybackStatus>;
  getIO: () => DeviceMonitorIo;
  playback: PlaybackStateSync;
  logger: Pick<typeof logger, 'info' | 'debug'>;
  /** Called once when a pinned (server-driven) device stays unreachable and polling gives up. */
  onUnreachable?: (deviceId: string, errors: number) => void;
  /** Milliseconds between polls (tests shorten it). */
  pollIntervalMs?: number;
  /** A single status request slower than this counts as a failure. */
  pollTimeoutMs?: number;
}

const defaultDependencies: DeviceMonitorDependencies = {
  getDevices: () => deviceManager.getDevices(),
  getPlaybackState: (deviceId) => deviceManager.getPlaybackState(deviceId),
  getIO,
  playback: playbackService,
  logger,
};

/**
 * Server-side device monitor that polls active devices for playback status
 * and pushes updates via Socket.IO. Replaces client-side polling.
 */
export class DeviceMonitor {
  private pollingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private lastStates = new Map<string, DevicePlaybackUpdate>();
  private subscriberCounts = new Map<string, number>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  // Devices with server-driven playback (see services/server-player.ts). Their
  // polling must survive client disconnects — the whole point is that the
  // queue keeps advancing while the tablet sleeps — so unsubscribe/stop only
  // applies to devices that are not pinned.
  private pinnedDevices = new Set<string>();
  private consecutiveErrors = new Map<string, number>();
  // Polls that have not returned yet. A slow renderer must not pile up
  // overlapping requests (V04.3); the next tick simply waits.
  private inFlight = new Set<string>();

  constructor(private deps: DeviceMonitorDependencies = defaultDependencies) {}

  /** Hook up the server player after construction (avoids an import cycle). */
  setUnreachableHandler(handler: (deviceId: string, errors: number) => void): void {
    this.deps = { ...this.deps, onUnreachable: handler };
  }

  isPinned(deviceId: string): boolean {
    return this.pinnedDevices.has(deviceId);
  }

  /** Start monitoring a device (called when a client subscribes) */
  subscribe(deviceId: string): void {
    const count = (this.subscriberCounts.get(deviceId) || 0) + 1;
    this.subscriberCounts.set(deviceId, count);

    if (!this.pollingIntervals.has(deviceId) && deviceId !== 'browser') {
      this.startPolling(deviceId);
    }
  }

  /** Stop monitoring a device (called when last client unsubscribes) */
  unsubscribe(deviceId: string): void {
    const count = Math.max(0, (this.subscriberCounts.get(deviceId) || 0) - 1);
    this.subscriberCounts.set(deviceId, count);

    if (count === 0 && !this.pinnedDevices.has(deviceId)) {
      this.stopPolling(deviceId);
    }
  }

  /** Keep polling this device regardless of connected clients. */
  pin(deviceId: string): void {
    if (deviceId === 'browser') return;
    this.pinnedDevices.add(deviceId);
    if (!this.pollingIntervals.has(deviceId)) {
      this.startPolling(deviceId);
    }
  }

  /** Release a pin; polling stops unless a client is still subscribed. */
  unpin(deviceId: string): void {
    this.pinnedDevices.delete(deviceId);
    if ((this.subscriberCounts.get(deviceId) || 0) === 0) {
      this.stopPolling(deviceId);
    }
  }

  /** Start periodic health checks for all known devices */
  startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      try {
        const devices = await this.deps.getDevices();
        const io = this.deps.getIO();

        for (const device of devices) {
          if (device.type === 'browser') continue;

          const wasOnline = device.isOnline;
          try {
            await this.deps.getPlaybackState(device.id);
            if (!wasOnline) {
              io.emit('device:discovered', { id: device.id, name: device.name, type: device.type });
              this.deps.logger.info(`Device back online: ${device.name}`);
            }
          } catch {
            if (wasOnline) {
              io.emit('device:lost', { id: device.id, name: device.name });
              this.deps.logger.info(`Device offline: ${device.name}`);
            }
          }
        }
      } catch {}
    }, 60_000);
  }

  stopAll(): void {
    for (const [deviceId] of this.pollingIntervals) {
      this.stopPolling(deviceId);
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private startPolling(deviceId: string): void {
    this.deps.logger.info(`DeviceMonitor: start polling ${deviceId}`);
    this.consecutiveErrors.set(deviceId, 0);

    const interval = setInterval(() => void this.tick(deviceId), this.deps.pollIntervalMs ?? 2000);

    this.pollingIntervals.set(deviceId, interval);
  }

  /** One poll cycle; never overlaps with a previous one for the same device. */
  async tick(deviceId: string): Promise<void> {
    if (this.inFlight.has(deviceId)) return;
    this.inFlight.add(deviceId);
    try {
      await withTimeout(this.pollDeviceOnce(deviceId), this.deps.pollTimeoutMs ?? 5000);
      this.consecutiveErrors.set(deviceId, 0);
    } catch {
      // Pinned devices (server-driven playback) tolerate transient failures
      // — one Wi-Fi hiccup must not kill the engine that advances the queue
      // overnight. Unpinned monitoring keeps the old fail-fast behavior.
      const errors = (this.consecutiveErrors.get(deviceId) || 0) + 1;
      this.consecutiveErrors.set(deviceId, errors);
      const pinned = this.pinnedDevices.has(deviceId);
      const limit = pinned ? 10 : 1;
      if (errors >= limit) {
        this.deps.logger.debug(
          `DeviceMonitor: ${deviceId} unreachable (${errors}x), stopping poll`,
        );
        this.pinnedDevices.delete(deviceId);
        this.stopPolling(deviceId);
        // Long outage: the session must not stay "playing" on a dead device.
        if (pinned) this.deps.onUnreachable?.(deviceId, errors);
      }
    } finally {
      this.inFlight.delete(deviceId);
    }
  }

  private stopPolling(deviceId: string): void {
    const interval = this.pollingIntervals.get(deviceId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(deviceId);
      this.lastStates.delete(deviceId);
      this.consecutiveErrors.delete(deviceId);
      this.deps.logger.info(`DeviceMonitor: stop polling ${deviceId}`);
    }
  }

  async pollDeviceOnce(deviceId: string): Promise<void> {
    const status = await this.deps.getPlaybackState(deviceId);
    const update: DevicePlaybackUpdate = {
      deviceId,
      state: normalizeDeviceState(status.state),
      position: status.position,
      duration: status.duration,
      volume: status.volume,
    };

    const last = this.lastStates.get(deviceId);
    const changed =
      !last ||
      last.state !== update.state ||
      Math.abs(last.position - update.position) > 3 ||
      last.duration !== update.duration ||
      last.volume !== update.volume;

    if (!changed) return;

    this.lastStates.set(deviceId, update);
    this.deps.getIO().emit('device:playback-update', update);
    this.syncPlaybackState(update, last);
  }

  private syncPlaybackState(update: DevicePlaybackUpdate, last?: DevicePlaybackUpdate): void {
    // Session binding (V03.3): a second speaker that someone merely opened in
    // the device picker is monitored for its own status, but it must not
    // pause/advance the household session that plays on another device.
    const active = this.deps.playback.getActiveDeviceId?.();
    if (active !== undefined && active !== update.deviceId) return;

    const lastAtEnd = !!last && isAtEnd(last);
    const updateAtEnd = isAtEnd(update);
    const ended =
      last?.state === 'playing' && update.state === 'stopped' && (lastAtEnd || updateAtEnd);

    if (ended) {
      this.deps.logger.info(`DeviceMonitor: track ended on ${update.deviceId}, advancing queue`);
      this.deps.playback.setState({
        deviceId: update.deviceId,
        state: 'stopped',
        position: update.duration || last.duration || update.position,
      });
      return;
    }

    this.deps.playback.setState({
      deviceId: update.deviceId,
      state: update.state,
      position: update.position,
    });
  }
}

export const deviceMonitor = new DeviceMonitor();

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`device status timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isAtEnd(update: DevicePlaybackUpdate): boolean {
  return update.duration > 0 && update.position >= Math.max(0, update.duration - 2);
}

function normalizeDeviceState(state: DevicePlaybackStatus['state']): DevicePlaybackUpdate['state'] {
  if (state === 'paused') return 'paused';
  if (state === 'playing' || state === 'buffering') return 'playing';
  return 'stopped';
}

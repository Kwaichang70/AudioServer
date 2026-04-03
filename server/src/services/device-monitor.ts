import { deviceManager } from '../devices/manager.js';
import { playbackService } from './playback.js';
import { getIO } from '../socketio.js';
import { logger } from '../logger.js';
import type { DevicePlaybackUpdate } from '../types/socket-events.js';

/**
 * Server-side device monitor that polls active devices for playback status
 * and pushes updates via Socket.IO. Replaces client-side polling.
 */
class DeviceMonitor {
  private pollingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private lastStates = new Map<string, DevicePlaybackUpdate>();
  private subscriberCounts = new Map<string, number>();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

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

    if (count === 0) {
      this.stopPolling(deviceId);
    }
  }

  /** Start periodic health checks for all known devices */
  startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      try {
        const devices = await deviceManager.getDevices();
        const io = getIO();

        for (const device of devices) {
          if (device.type === 'browser') continue;

          const wasOnline = device.isOnline;
          try {
            await deviceManager.getPlaybackState(device.id);
            if (!wasOnline) {
              io.emit('device:discovered', { id: device.id, name: device.name, type: device.type });
              logger.info(`Device back online: ${device.name}`);
            }
          } catch {
            if (wasOnline) {
              io.emit('device:lost', { id: device.id, name: device.name });
              logger.info(`Device offline: ${device.name}`);
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
    logger.info(`DeviceMonitor: start polling ${deviceId}`);

    const interval = setInterval(async () => {
      try {
        const status = await deviceManager.getPlaybackState(deviceId);
        const update: DevicePlaybackUpdate = {
          deviceId,
          state: status.state as any,
          position: status.position,
          duration: status.duration,
          volume: status.volume,
        };

        // Compare with last known state
        const last = this.lastStates.get(deviceId);
        const changed = !last ||
          last.state !== update.state ||
          Math.abs(last.position - update.position) > 3 ||
          last.duration !== update.duration ||
          last.volume !== update.volume;

        if (changed) {
          this.lastStates.set(deviceId, update);
          getIO().emit('device:playback-update', update);
        }

        // Detect track ended: was playing, now stopped
        if (last?.state === 'playing' && update.state === 'stopped') {
          const nearEnd = last.duration > 0 && last.position >= last.duration - 2;
          if (nearEnd || update.position === 0) {
            logger.info(`DeviceMonitor: track ended on ${deviceId}, advancing queue`);
            playbackService.advance();
            // The track-changed event is emitted by PlaybackService.advance()
          }
        }
      } catch (err) {
        // Device unreachable, stop polling
        logger.debug(`DeviceMonitor: ${deviceId} unreachable, stopping poll`);
        this.stopPolling(deviceId);
      }
    }, 2000);

    this.pollingIntervals.set(deviceId, interval);
  }

  private stopPolling(deviceId: string): void {
    const interval = this.pollingIntervals.get(deviceId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(deviceId);
      this.lastStates.delete(deviceId);
      logger.info(`DeviceMonitor: stop polling ${deviceId}`);
    }
  }
}

export const deviceMonitor = new DeviceMonitor();

import { deviceManager } from '../devices/manager.js';
import { zones } from './zones.js';
import { getIO } from '../socketio.js';
import { logger } from '../logger.js';
import type { DevicePlaybackStatus, OutputDevice } from '@audioserver/shared';
import type {
  DevicePlaybackUpdate,
  DispatchStatus,
  ServerToClientEvents,
} from '../types/socket-events.js';

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
    /** The device stopped because the track finished, not because someone stopped it. */
    ended?: boolean;
  }): void;
  /** A poll that carried no news; only the silent-renderer rule cares (V09 fix). */
  noteIdlePoll?(deviceId: string, state: 'playing' | 'paused' | 'stopped', position: number): void;
  /** The device the household session is bound to; other monitored devices only feed the UI. */
  getActiveDeviceId?(): string;
  /** How far the server got handing the current item to that device (V04). */
  getDispatch?(deviceId: string): DispatchStatus | undefined;
}

interface DeviceMonitorDependencies {
  getDevices: () => Promise<OutputDevice[]>;
  getPlaybackState: (deviceId: string) => Promise<DevicePlaybackStatus>;
  getIO: () => DeviceMonitorIo;
  playback: PlaybackStateSync;
  logger: Pick<typeof logger, 'info' | 'debug'>;
  /** Called once when a pinned (server-driven) device stays unreachable and polling gives up. */
  onUnreachable?: (deviceId: string, errors: number) => void;
  /**
   * The device started a new track by itself (V11.3): it was handed the next
   * url in advance. The queue has to follow without anyone dispatching again.
   */
  onDeviceAdvanced?: (deviceId: string) => void;
  /** Milliseconds between polls (tests shorten it). */
  pollIntervalMs?: number;
  /** A single status request slower than this counts as a failure. */
  pollTimeoutMs?: number;
  /**
   * How close to the end of a track a renderer has to have got for a later
   * "stopped" to count as "the track finished" instead of "somebody stopped
   * it". Defaults to two poll intervals plus a margin — see syncPlaybackState.
   */
  endGraceSeconds?: number;
  /** How long a freshly dispatched track may report "stopped" while it loads. */
  startGraceMs?: number;
}

/**
 * Status of a device goes to the zone that owns it (V10) — never to "the"
 * session, so a poll of the kitchen speaker cannot pause the living room.
 * A device no zone claimed is monitored for the UI only.
 */
const zoneRouter: PlaybackStateSync = {
  setState: (updates) => {
    if (!updates.deviceId) return;
    zones.sessionForDevice(updates.deviceId)?.setState(updates);
  },
  getDispatch: (deviceId) => zones.sessionForDevice(deviceId)?.getDispatch(),
  noteIdlePoll: (deviceId, state, position) => {
    zones.sessionForDevice(deviceId)?.noteIdlePoll(deviceId, state, position);
  },
};

const defaultDependencies: DeviceMonitorDependencies = {
  getDevices: () => deviceManager.getDevices(),
  getPlaybackState: (deviceId) => deviceManager.getPlaybackState(deviceId),
  getIO,
  playback: zoneRouter,
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
  // The furthest a device was confirmed playing in the track it is playing
  // now. A renderer that reaches the end of a track resets its transport
  // counters to 0/0 in the same breath as it reports "stopped", so the only
  // evidence that the track finished is what it told us just before.
  private playingPeaks = new Map<string, { position: number; duration: number; at: number }>();

  constructor(private deps: DeviceMonitorDependencies = defaultDependencies) {}

  /** Hook up the server player after construction (avoids an import cycle). */
  setUnreachableHandler(handler: (deviceId: string, errors: number) => void): void {
    this.deps = { ...this.deps, onUnreachable: handler };
  }

  /** Same, for a device that moves to the next track on its own (V11.3). */
  setDeviceAdvancedHandler(handler: (deviceId: string) => void): void {
    this.deps = { ...this.deps, onDeviceAdvanced: handler };
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
      this.playingPeaks.delete(deviceId);
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

    if (!changed) {
      // A renderer that answers "PLAYING, 0:00 of 0:00" for the whole album
      // never produces a change; the session times the track itself and needs
      // to hear that the device is still saying the same thing.
      this.deps.playback.noteIdlePoll?.(deviceId, update.state, update.position);
      return;
    }

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

    if (update.state === 'playing') {
      // A position that falls back to the start while the device keeps
      // playing means it began a new track by itself — the one it was handed
      // in advance (V11.3). The handler only acts when something really was
      // armed, so a listener seeking back to 0:00 changes nothing.
      const peak = this.playingPeaks.get(update.deviceId);
      if (peak && peak.position > 30 && update.position <= 5) {
        this.deps.logger.info(
          `DeviceMonitor: ${update.deviceId} restarted its position after ${Math.round(peak.position)}s; the device moved to the next track itself`,
        );
        this.playingPeaks.delete(update.deviceId);
        this.deps.onDeviceAdvanced?.(update.deviceId);
      }
      this.rememberProgress(update);
    }

    if (update.state === 'stopped') {
      const peak = this.playingPeaks.get(update.deviceId);

      // Between "here is the next url" and the first frame of audio, a DLNA
      // renderer answers STOPPED at 0:00. Writing that into the session would
      // stop the very track the server just dispatched, so a stop inside the
      // start grace window — before the device ever confirmed playing — is
      // ignored. (Danny, 9 Sept 2026: album stuck at 0:00 on track 1.)
      if (!peak && this.isDispatchSettling(update.deviceId)) {
        this.deps.logger.debug(
          `DeviceMonitor: ${update.deviceId} still loading, ignoring stopped at 0:00`,
        );
        return;
      }

      // End of track. The renderer's own numbers are unusable here (most
      // reset to 0/0 on stop), so judge by the last confirmed playing sample:
      // polls are 2 s apart and only stored when the position moved more than
      // 3 s, so "playing" can legitimately lag several seconds behind the real
      // end. Anything closer to the end than the grace window finished; a stop
      // earlier than that is somebody pressing stop.
      const heard = peak ?? (last?.state === 'playing' ? last : undefined);
      const grace = this.endGraceSeconds();
      if (heard && heard.duration > 0 && heard.position >= heard.duration - grace) {
        this.deps.logger.info(
          `DeviceMonitor: track ended on ${update.deviceId} at ${Math.round(heard.position)}/${Math.round(heard.duration)}s, advancing queue`,
        );
        this.playingPeaks.delete(update.deviceId);
        this.deps.playback.setState({
          deviceId: update.deviceId,
          state: 'stopped',
          position: Math.max(heard.duration, heard.position),
          ended: true,
        });
        return;
      }
      this.playingPeaks.delete(update.deviceId);
      // Not the end as far as we can tell — but hand over the furthest
      // position we saw rather than the 0:00 the renderer resets to, so the
      // session can still judge it against the track's real length.
      this.deps.playback.setState({
        deviceId: update.deviceId,
        state: 'stopped',
        position: Math.max(update.position, heard?.position ?? 0),
      });
      return;
    }

    this.deps.playback.setState({
      deviceId: update.deviceId,
      state: update.state,
      position: update.position,
    });
  }

  /** Keep the furthest position seen in the track the device plays now. */
  private rememberProgress(update: DevicePlaybackUpdate): void {
    const peak = this.playingPeaks.get(update.deviceId);
    // A different duration, or a position that jumped backwards, means a new
    // track (or a seek): start counting again instead of carrying the old
    // track's end position into the next one. A duration of 0 says nothing —
    // renderers answer 0:00:00 while they are still working it out — so it
    // never counts as "a different track" and never erases what we knew.
    const sameTrack =
      peak &&
      (update.duration === 0 || peak.duration === update.duration) &&
      update.position + 5 >= peak.position;
    this.playingPeaks.set(update.deviceId, {
      position: sameTrack ? Math.max(peak.position, update.position) : update.position,
      duration: sameTrack ? peak.duration || update.duration : update.duration,
      at: Date.now(),
    });
  }

  private endGraceSeconds(): number {
    if (this.deps.endGraceSeconds !== undefined) return this.deps.endGraceSeconds;
    return ((this.deps.pollIntervalMs ?? 2000) / 1000) * 2 + 4;
  }

  /** True while the server is handing a track to this device and it has not started yet. */
  private isDispatchSettling(deviceId: string): boolean {
    const dispatch = this.deps.playback.getDispatch?.(deviceId);
    if (!dispatch || dispatch.deviceId !== deviceId) return false;
    if (dispatch.state !== 'loading' && dispatch.state !== 'playing') return false;
    return Date.now() - dispatch.updatedAt < (this.deps.startGraceMs ?? 15_000);
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

function normalizeDeviceState(state: DevicePlaybackStatus['state']): DevicePlaybackUpdate['state'] {
  if (state === 'paused') return 'paused';
  if (state === 'playing' || state === 'buffering') return 'playing';
  return 'stopped';
}

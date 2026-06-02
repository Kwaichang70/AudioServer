import type { DeviceSessionState, TrackMetadata } from '@audioserver/shared';

export interface DeviceSessionSnapshot {
  deviceId: string;
  state: DeviceSessionState;
  updatedAt: number;
  previousState?: DeviceSessionState;
  lastError?: string;
  currentTrack?: TrackMetadata;
}

interface TransitionDetails {
  track?: TrackMetadata;
  error?: unknown;
}

const ALLOWED_TRANSITIONS: Record<DeviceSessionState, DeviceSessionState[]> = {
  idle: ['loading', 'playing', 'paused', 'stopped', 'error'],
  loading: ['playing', 'paused', 'stopped', 'error'],
  playing: ['loading', 'paused', 'stopped', 'error'],
  paused: ['playing', 'stopped', 'loading', 'error'],
  stopped: ['loading', 'playing', 'paused', 'idle', 'error'],
  error: ['loading', 'playing', 'paused', 'stopped', 'idle'],
};

export class InvalidDeviceStateTransitionError extends Error {
  constructor(from: DeviceSessionState, to: DeviceSessionState) {
    super(`Invalid device state transition: ${from} -> ${to}`);
    this.name = 'InvalidDeviceStateTransitionError';
  }
}

export class DeviceStateMachine {
  private sessions = new Map<string, DeviceSessionSnapshot>();

  get(deviceId: string): DeviceSessionSnapshot {
    const existing = this.sessions.get(deviceId);
    if (existing) return existing;

    const initial: DeviceSessionSnapshot = {
      deviceId,
      state: 'idle',
      updatedAt: Date.now(),
    };
    this.sessions.set(deviceId, initial);
    return initial;
  }

  transition(
    deviceId: string,
    nextState: DeviceSessionState,
    details: TransitionDetails = {},
  ): DeviceSessionSnapshot {
    const current = this.get(deviceId);
    if (current.state !== nextState && !ALLOWED_TRANSITIONS[current.state].includes(nextState)) {
      throw new InvalidDeviceStateTransitionError(current.state, nextState);
    }

    const next: DeviceSessionSnapshot = {
      deviceId,
      state: nextState,
      previousState: current.state,
      updatedAt: Date.now(),
      currentTrack:
        details.track ??
        (nextState === 'idle' || nextState === 'stopped' ? undefined : current.currentTrack),
      lastError: nextState === 'error' ? stringifyError(details.error) : undefined,
    };
    this.sessions.set(deviceId, next);
    return next;
  }

  reconcilePlaybackState(
    deviceId: string,
    playbackState: 'playing' | 'paused' | 'stopped' | 'buffering',
  ): DeviceSessionSnapshot {
    if (playbackState === 'buffering') return this.transition(deviceId, 'loading');
    if (playbackState === 'playing') return this.transition(deviceId, 'playing');
    if (playbackState === 'paused') return this.transition(deviceId, 'paused');
    return this.transition(deviceId, 'stopped');
  }

  clear(deviceId: string): void {
    this.sessions.delete(deviceId);
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

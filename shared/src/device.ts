import type { PlaybackState } from './types.js';

// ─── Output Device Interface ─────────────────────────────────────
// Every playback target (Cocktail Audio, Volumio, Sonos, browser) implements this.

export type DeviceType = 'dlna' | 'sonos' | 'volumio' | 'browser';
export type DeviceSessionState = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error';

export interface OutputDevice {
  id: string;
  name: string;
  type: DeviceType;
  host?: string; // network address
  isOnline: boolean;
  playbackState?: DeviceSessionState;
  playbackStateUpdatedAt?: number;
  lastError?: string;
  groupId?: string;
  groupName?: string;
  isGroupCoordinator?: boolean;
}

export interface DeviceController {
  readonly deviceType: DeviceType;

  // Discovery
  discover(): Promise<OutputDevice[]>;

  // Transport controls
  /**
   * Start a stream. `signal` aborts the requests still on their way when the
   * caller gave up (its own time limit ran out), so a late attempt does not
   * keep sending commands next to the caller's retry (P06).
   */
  play(
    deviceId: string,
    streamUrl: string,
    metadata?: TrackMetadata,
    signal?: AbortSignal,
  ): Promise<void>;
  pause(deviceId: string): Promise<void>;
  resume(deviceId: string): Promise<void>;
  stop(deviceId: string): Promise<void>;
  next(deviceId: string): Promise<void>;
  previous(deviceId: string): Promise<void>;
  setNextUri?(
    deviceId: string,
    streamUrl: string,
    metadata?: TrackMetadata,
    signal?: AbortSignal,
  ): Promise<void>;
  /**
   * Jump to `position` seconds inside the current track (R01.1). Optional:
   * a renderer may not implement it, and `output-capabilities` asks the
   * device itself rather than assuming. A controller that offers this method
   * still throws when the device refuses the action.
   */
  seek?(deviceId: string, position: number): Promise<void>;

  // Volume
  setVolume(deviceId: string, volume: number): Promise<void>;
  getVolume(deviceId: string): Promise<number>;

  // Status
  getPlaybackState(deviceId: string): Promise<DevicePlaybackStatus>;
}

export interface TrackMetadata {
  title: string;
  artist: string;
  album: string;
  coverUrl?: string;
  duration?: number;
}

export interface DevicePlaybackStatus {
  state: PlaybackState;
  position: number;
  duration: number;
  volume: number;
  /** The URL the renderer plays now (GetPositionInfo TrackURI), when it says. */
  trackUri?: string;
  currentTrack?: TrackMetadata;
  deviceState?: DeviceSessionState;
  lastError?: string;
}

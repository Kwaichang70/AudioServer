import type { PlaybackState } from './types.js';

// ─── Output Device Interface ─────────────────────────────────────
// Every playback target (Cocktail Audio, Volumio, Sonos, browser) implements this.

export type DeviceType = 'dlna' | 'sonos' | 'volumio' | 'browser';

export interface OutputDevice {
  id: string;
  name: string;
  type: DeviceType;
  host?: string; // network address
  isOnline: boolean;
}

export interface DeviceController {
  readonly deviceType: DeviceType;

  // Discovery
  discover(): Promise<OutputDevice[]>;

  // Transport controls
  play(deviceId: string, streamUrl: string, metadata?: TrackMetadata): Promise<void>;
  pause(deviceId: string): Promise<void>;
  resume(deviceId: string): Promise<void>;
  stop(deviceId: string): Promise<void>;
  next(deviceId: string): Promise<void>;
  previous(deviceId: string): Promise<void>;

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
  currentTrack?: TrackMetadata;
}

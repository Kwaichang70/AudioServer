import type { NowPlaying, PlaybackState } from '@audioserver/shared';

export interface DevicePlaybackUpdate {
  deviceId: string;
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  duration: number;
  volume: number;
}

export interface ServerToClientEvents {
  'playback:state': (state: NowPlaying) => void;
  'playback:queue': (queue: any[]) => void;
  'playback:track-changed': (track: any) => void;
  'device:playback-update': (update: DevicePlaybackUpdate) => void;
  'device:discovered': (device: { id: string; name: string; type: string }) => void;
  'device:lost': (device: { id: string; name: string }) => void;
  'library:scan-progress': (progress: any) => void;
}

export interface ClientToServerEvents {
  'device:subscribe': (deviceId: string) => void;
  'device:unsubscribe': (deviceId: string) => void;
}

import type { NowPlaying } from '@audioserver/shared';

export interface PlaybackTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
}

export interface PlaybackQueueEntry {
  trackId: string;
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
  position: number;
}

export interface DevicePlaybackUpdate {
  deviceId: string;
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  duration: number;
  volume: number;
}

export interface ServerToClientEvents {
  'playback:state': (state: NowPlaying) => void;
  'playback:queue': (queue: PlaybackQueueEntry[]) => void;
  'playback:track-changed': (track: PlaybackTrack) => void;
  'device:playback-update': (update: DevicePlaybackUpdate) => void;
  'device:discovered': (device: { id: string; name: string; type: string }) => void;
  'device:lost': (device: { id: string; name: string }) => void;
  'library:scan-progress': (progress: Record<string, unknown>) => void;
}

export interface ClientToServerEvents {
  'device:subscribe': (deviceId: string) => void;
  'device:unsubscribe': (deviceId: string) => void;
}

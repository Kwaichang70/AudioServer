import type { NowPlaying } from '@audioserver/shared';
import type { ScanStatus } from '../services/scanner.js';

export interface PlaybackTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
  metadata?: Record<string, unknown>;
}

/** One occurrence in the queue. `itemId` is the stable identity (V03.1). */
export interface PlaybackQueueEntry {
  itemId: string;
  trackId: string;
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
  metadata?: Record<string, unknown>;
  position: number;
}

/** Who caused a change: a browser tab (clientId) in a login session, or the server itself. */
export interface PlaybackOrigin {
  clientId: string | null;
  sessionId: string | null;
  server?: boolean;
}

/**
 * What the SERVER-side player is doing with the current item on the active
 * device (V04.2). `client` means a connected browser tab has to play it
 * (Spotify); `skipped` means the unplayable-policy moved on.
 */
export interface DispatchStatus {
  state: 'idle' | 'loading' | 'playing' | 'client' | 'skipped' | 'error';
  deviceId: string | null;
  itemId: string | null;
  trackId: string | null;
  code?: string;
  message?: string;
  attempts: number;
  updatedAt: number;
}

export interface PlaybackSnapshot {
  revision: number;
  queue: PlaybackQueueEntry[];
  currentItemId: string | null;
  queueIndex: number;
  state: NowPlaying;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  controller: { clientId: string | null; deviceId: string; serverManaged: boolean };
  dispatch: DispatchStatus;
}

export interface PlaybackStateEvent extends NowPlaying {
  revision: number;
  currentItemId: string | null;
  origin: PlaybackOrigin;
}

export interface PlaybackQueueEvent {
  revision: number;
  queue: PlaybackQueueEntry[];
  currentItemId: string | null;
  queueIndex: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  origin: PlaybackOrigin;
}

export interface PlaybackTrackChangedEvent {
  track: PlaybackTrack;
  itemId: string | null;
  revision: number;
  deviceId: string;
  /** The tab that owns the session; it is the one that plays provider tracks the server cannot stream. */
  controllerClientId: string | null;
  origin: PlaybackOrigin;
}

export interface DevicePlaybackUpdate {
  deviceId: string;
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  duration: number;
  volume: number;
}

export interface ServerToClientEvents {
  /** Full session state; sent to every socket right after it connects (and on request). */
  'playback:snapshot': (snapshot: PlaybackSnapshot) => void;
  'playback:state': (state: PlaybackStateEvent) => void;
  'playback:queue': (queue: PlaybackQueueEvent) => void;
  'playback:track-changed': (event: PlaybackTrackChangedEvent) => void;
  'playback:dispatch': (status: DispatchStatus) => void;
  'device:playback-update': (update: DevicePlaybackUpdate) => void;
  'device:discovered': (device: { id: string; name: string; type: string }) => void;
  'device:lost': (device: { id: string; name: string }) => void;
  'library:scan-progress': (progress: ScanStatus) => void;
  /** Sent right before the server closes a socket whose login session was revoked. */
  'session:revoked': () => void;
}

export interface ClientToServerEvents {
  'device:subscribe': (deviceId: string) => void;
  'device:unsubscribe': (deviceId: string) => void;
  /** Ask for a fresh snapshot (after a reconnect the server sends one anyway). */
  'playback:sync': () => void;
}

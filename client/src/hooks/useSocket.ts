import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { SOCKET_RECONNECT_ATTEMPTS, SOCKET_RECONNECT_DELAY, STORAGE_KEYS } from '../constants.js';
import { SESSION_LOST_EVENT } from '../context/AuthContext.js';
import { getClientId } from '../api/client.js';
import type {
  DispatchStatus,
  PlaybackQueueEvent,
  PlaybackSnapshot,
  PlaybackStateEvent,
  PlaybackTrackChangedEvent,
  ZoneSummary,
} from '../api/types.js';

interface DevicePlaybackUpdate {
  deviceId: string;
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  duration: number;
  volume: number;
}

export interface LibraryScanProgress {
  isScanning: boolean;
  phase: 'idle' | 'discovering' | 'scanning' | 'cleaning' | 'done';
  processedFiles: number;
  totalFiles: number;
  newTracks: number;
  updatedTracks: number;
  removedTracks: number;
  artists: number;
  albums: number;
  tracks: number;
  errors: number;
  currentDir?: string;
  currentFile?: string;
  relinkedTracks?: number;
  missingTracks?: number;
  recoveredTracks?: number;
  doubtfulTracks?: number;
  failedRoots?: Array<{ path: string; error: string; failedDirs: string[] }>;
}

interface ServerToClientEvents {
  'playback:snapshot': (snapshot: PlaybackSnapshot) => void;
  'playback:queue': (event: PlaybackQueueEvent) => void;
  'playback:state': (event: PlaybackStateEvent) => void;
  'playback:track-changed': (event: PlaybackTrackChangedEvent) => void;
  'playback:dispatch': (status: DispatchStatus) => void;
  'device:playback-update': (update: DevicePlaybackUpdate) => void;
  'library:scan-progress': (progress: LibraryScanProgress) => void;
  'zones:changed': (zones: ZoneSummary[]) => void;
  'session:revoked': () => void;
}

interface ClientToServerEvents {
  'device:subscribe': (deviceId: string) => void;
  'device:unsubscribe': (deviceId: string) => void;
  'playback:sync': () => void;
}

interface UseSocketReturn {
  connected: boolean;
  /** The rooms the server knows about (V10). */
  zones: ZoneSummary[];
  deviceUpdate: DevicePlaybackUpdate | null;
  /** Full session state, delivered on every (re)connect and on requestSync(). */
  snapshot: PlaybackSnapshot | null;
  queueEvent: PlaybackQueueEvent | null;
  stateEvent: PlaybackStateEvent | null;
  trackChanged: PlaybackTrackChangedEvent | null;
  /** Server-side dispatch progress/errors for the active device. */
  dispatch: DispatchStatus | null;
  scanProgress: LibraryScanProgress | null;
  subscribeDevice: (deviceId: string) => void;
  unsubscribeDevice: (deviceId: string) => void;
  requestSync: () => void;
  /**
   * Only keep playback events of this room (V10). Every zone broadcasts on
   * the same socket; without the filter the kitchen's queue would land in the
   * living room's UI.
   */
  setZoneFilter: (zoneId: string | null) => void;
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const [connected, setConnected] = useState(false);
  const [deviceUpdate, setDeviceUpdate] = useState<DevicePlaybackUpdate | null>(null);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [queueEvent, setQueueEvent] = useState<PlaybackQueueEvent | null>(null);
  const [stateEvent, setStateEvent] = useState<PlaybackStateEvent | null>(null);
  const [trackChanged, setTrackChanged] = useState<PlaybackTrackChangedEvent | null>(null);
  const [dispatch, setDispatch] = useState<DispatchStatus | null>(null);
  const [scanProgress, setScanProgress] = useState<LibraryScanProgress | null>(null);
  const [zones, setZones] = useState<ZoneSummary[]>([]);
  const subscribedDeviceRef = useRef<string | null>(null);
  const zoneRef = useRef<string | null>(null);

  /** Events of another room are not ours; one without a zone is (pre-V10 server). */
  const mine = useCallback(
    <T extends { zoneId?: string }>(setter: Dispatch<SetStateAction<T | null>>) =>
      (event: T): void => {
        if (event.zoneId && zoneRef.current && event.zoneId !== zoneRef.current) return;
        setter(event);
      },
    [],
  );

  useEffect(() => {
    const token = localStorage.getItem(STORAGE_KEYS.authToken);
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      auth: { token, clientId: getClientId() },
      reconnection: true,
      reconnectionDelay: SOCKET_RECONNECT_DELAY,
      reconnectionAttempts: SOCKET_RECONNECT_ATTEMPTS,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      // Re-subscribe to device after reconnect
      if (subscribedDeviceRef.current) {
        socket.emit('device:subscribe', subscribedDeviceRef.current);
      }
    });

    socket.on('disconnect', () => setConnected(false));

    // The server closes sockets whose login session was revoked (logout on
    // another device, admin reset). Tell AuthContext so the UI shows the
    // login screen instead of silently reconnecting forever.
    const sessionLost = () => window.dispatchEvent(new Event(SESSION_LOST_EVENT));
    socket.on('session:revoked', sessionLost);
    socket.on('connect_error', (err: Error) => {
      if (/authentication/i.test(err.message)) sessionLost();
    });

    socket.on('device:playback-update', setDeviceUpdate);
    socket.on('playback:snapshot', mine(setSnapshot));
    socket.on('playback:queue', mine(setQueueEvent));
    socket.on('playback:state', mine(setStateEvent));
    socket.on('playback:track-changed', mine(setTrackChanged));
    socket.on('playback:dispatch', mine(setDispatch));
    socket.on('zones:changed', setZones);
    socket.on('library:scan-progress', setScanProgress);

    return () => {
      socket.disconnect();
    };
    // `mine` is stable (useCallback with no dependencies); the socket is set
    // up once for the life of the provider.
  }, [mine]);

  const subscribeDevice = useCallback((deviceId: string) => {
    // Unsubscribe from previous device
    if (subscribedDeviceRef.current && subscribedDeviceRef.current !== deviceId) {
      socketRef.current?.emit('device:unsubscribe', subscribedDeviceRef.current);
    }
    subscribedDeviceRef.current = deviceId;
    if (deviceId !== 'browser') {
      socketRef.current?.emit('device:subscribe', deviceId);
    }
  }, []);

  const unsubscribeDevice = useCallback((deviceId: string) => {
    socketRef.current?.emit('device:unsubscribe', deviceId);
    if (subscribedDeviceRef.current === deviceId) {
      subscribedDeviceRef.current = null;
    }
  }, []);

  const requestSync = useCallback(() => {
    socketRef.current?.emit('playback:sync');
  }, []);

  const setZoneFilter = useCallback((zoneId: string | null) => {
    if (zoneRef.current === zoneId) return;
    zoneRef.current = zoneId;
    // The room changed: ask for its snapshot instead of showing the old one.
    socketRef.current?.emit('playback:sync');
  }, []);

  // Foreground again (V08.4): the phone may have missed every event while
  // asleep. Ask for a fresh snapshot instead of trusting stale state; a
  // socket that dropped meanwhile reconnects on its own and gets one too.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const s = socketRef.current;
      if (!s) return;
      if (s.connected) s.emit('playback:sync');
      else s.connect();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return useMemo(
    () => ({
      connected,
      zones,
      deviceUpdate,
      snapshot,
      queueEvent,
      stateEvent,
      trackChanged,
      dispatch,
      scanProgress,
      subscribeDevice,
      unsubscribeDevice,
      requestSync,
      setZoneFilter,
    }),
    [
      connected,
      zones,
      deviceUpdate,
      snapshot,
      queueEvent,
      stateEvent,
      trackChanged,
      dispatch,
      scanProgress,
      subscribeDevice,
      unsubscribeDevice,
      requestSync,
      setZoneFilter,
    ],
  );
}

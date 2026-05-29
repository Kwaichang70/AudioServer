import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { SOCKET_RECONNECT_ATTEMPTS, SOCKET_RECONNECT_DELAY, STORAGE_KEYS } from '../constants.js';

interface DevicePlaybackUpdate {
  deviceId: string;
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  duration: number;
  volume: number;
}

interface PlaybackTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
}

interface ServerToClientEvents {
  'device:playback-update': (update: DevicePlaybackUpdate) => void;
  'playback:track-changed': (track: PlaybackTrack) => void;
}

interface ClientToServerEvents {
  'device:subscribe': (deviceId: string) => void;
  'device:unsubscribe': (deviceId: string) => void;
}

interface UseSocketReturn {
  connected: boolean;
  deviceUpdate: DevicePlaybackUpdate | null;
  trackChanged: PlaybackTrack | null;
  subscribeDevice: (deviceId: string) => void;
  unsubscribeDevice: (deviceId: string) => void;
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const [connected, setConnected] = useState(false);
  const [deviceUpdate, setDeviceUpdate] = useState<DevicePlaybackUpdate | null>(null);
  const [trackChanged, setTrackChanged] = useState<PlaybackTrack | null>(null);
  const subscribedDeviceRef = useRef<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem(STORAGE_KEYS.authToken);
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
      auth: { token },
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

    socket.on('device:playback-update', setDeviceUpdate);
    socket.on('playback:track-changed', setTrackChanged);

    return () => {
      socket.disconnect();
    };
  }, []);

  const subscribeDevice = (deviceId: string) => {
    // Unsubscribe from previous device
    if (subscribedDeviceRef.current && subscribedDeviceRef.current !== deviceId) {
      socketRef.current?.emit('device:unsubscribe', subscribedDeviceRef.current);
    }
    subscribedDeviceRef.current = deviceId;
    if (deviceId !== 'browser') {
      socketRef.current?.emit('device:subscribe', deviceId);
    }
  };

  const unsubscribeDevice = (deviceId: string) => {
    socketRef.current?.emit('device:unsubscribe', deviceId);
    if (subscribedDeviceRef.current === deviceId) {
      subscribedDeviceRef.current = null;
    }
  };

  return { connected, deviceUpdate, trackChanged, subscribeDevice, unsubscribeDevice };
}

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

interface DevicePlaybackUpdate {
  deviceId: string;
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  duration: number;
  volume: number;
}

interface UseSocketReturn {
  connected: boolean;
  deviceUpdate: DevicePlaybackUpdate | null;
  subscribeDevice: (deviceId: string) => void;
  unsubscribeDevice: (deviceId: string) => void;
}

export function useSocket(): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [deviceUpdate, setDeviceUpdate] = useState<DevicePlaybackUpdate | null>(null);
  const subscribedDeviceRef = useRef<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('audioserver_token');
    const socket = io({
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
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

    socket.on('device:playback-update' as any, (update: DevicePlaybackUpdate) => {
      setDeviceUpdate(update);
    });

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

  return { connected, deviceUpdate, subscribeDevice, unsubscribeDevice };
}

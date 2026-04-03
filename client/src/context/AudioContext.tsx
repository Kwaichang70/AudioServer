import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useAudio } from '../hooks/useAudio.js';
import { useSocket } from '../hooks/useSocket.js';
import { api } from '../api/client.js';
import { useToast } from '../components/Toast.js';

interface TrackInfo {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
}

interface AudioContextValue {
  currentTrack: TrackInfo | null;
  isPlaying: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  queue: TrackInfo[];
  queueIndex: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  selectedDeviceId: string;
  playTrack: (track: TrackInfo) => void;
  playAlbum: (tracks: TrackInfo[]) => void;
  addToQueue: (track: TrackInfo) => void;
  clearQueue: () => void;
  playNext: () => void;
  playPrevious: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setVolume: (v: number) => void;
  seek: (time: number) => void;
  setSelectedDeviceId: (id: string) => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
}

const AudioCtx = createContext<AudioContextValue | null>(null);

export function AudioProvider({ children }: { children: ReactNode }) {
  const audio = useAudio();
  const socket = useSocket();
  const [currentTrack, setCurrentTrack] = useState<TrackInfo | null>(null);
  const [queue, setQueue] = useState<TrackInfo[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [selectedDeviceId, setSelectedDeviceId] = useState('browser');
  const [isLoading, setIsLoading] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<'off' | 'all' | 'one'>('off');
  const [devicePosition, setDevicePosition] = useState(0);
  const [deviceDuration, setDeviceDuration] = useState(0);
  const [deviceIsPlaying, setDeviceIsPlaying] = useState(false);
  const { toast } = useToast();

  // Use refs so callbacks always see the latest values
  const selectedDeviceRef = useRef(selectedDeviceId);
  selectedDeviceRef.current = selectedDeviceId;
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const lanAddressRef = useRef<string | null>(null);
  const playNextRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => {
      if (d.lanAddress) lanAddressRef.current = d.lanAddress;
    }).catch(() => {});
  }, []);

  // Subscribe to device updates via WebSocket (replaces client-side polling)
  useEffect(() => {
    if (selectedDeviceId === 'browser') {
      socket.unsubscribeDevice(selectedDeviceId);
      setDevicePosition(0);
      setDeviceDuration(0);
      setDeviceIsPlaying(false);
      return;
    }
    socket.subscribeDevice(selectedDeviceId);
    return () => socket.unsubscribeDevice(selectedDeviceId);
  }, [selectedDeviceId]);

  // Process WebSocket device updates
  const prevDeviceState = useRef<string>('stopped');
  useEffect(() => {
    if (!socket.deviceUpdate || socket.deviceUpdate.deviceId !== selectedDeviceRef.current) return;

    const u = socket.deviceUpdate;
    setDevicePosition(u.position);
    setDeviceDuration(u.duration);
    setDeviceIsPlaying(u.state === 'playing');

    // Auto-advance: device was playing, now stopped → next track
    if (prevDeviceState.current === 'playing' && u.state === 'stopped') {
      const nearEnd = u.duration > 0 && u.position >= u.duration - 2;
      if (nearEnd || u.position === 0) {
        console.log(`[AudioServer] Track ended via WebSocket, advancing`);
        playNextRef.current?.();
      }
    }
    prevDeviceState.current = u.state;
  }, [socket.deviceUpdate]);

  // Fallback: if WebSocket disconnected, use polling
  useEffect(() => {
    if (socket.connected || selectedDeviceId === 'browser' || !currentTrack) return;
    if (currentTrack.id.startsWith('spotify:')) return;

    const poll = setInterval(() => {
      api.getDeviceStatus(selectedDeviceId).then((res) => {
        setDevicePosition(res.data.position || 0);
        setDeviceDuration(res.data.duration || 0);
        setDeviceIsPlaying(res.data.state === 'playing');
      }).catch(() => {});
    }, 2000);

    return () => clearInterval(poll);
  }, [socket.connected, currentTrack, selectedDeviceId]);

  const startTrack = useCallback((track: TrackInfo) => {
    setCurrentTrack(track);
    setIsLoading(true);

    const deviceId = selectedDeviceRef.current;
    const isSpotify = track.id.startsWith('spotify:');
    const isQobuz = track.id.startsWith('qobuz:');

    console.log(`[AudioServer] Playing "${track.title}" on device: ${deviceId}, spotify: ${isSpotify}`);

    if (isSpotify) {
      const spotifyTrackUri = `spotify:track:${track.id.replace('spotify:', '')}`;

      const playSpotify = async () => {
        try {
          // Strategy 1: If external device selected, try librespot (streams to any device)
          if (deviceId !== 'browser') {
            try {
              const lsStatus = await api.librespotStatus();
              if (lsStatus.data.isRunning) {
                // Librespot is running — route through it
                // First tell Spotify to play on the "AudioServer" librespot device
                const devRes = await api.spotifyConnectDevices();
                const audioServerDevice = (devRes.data || []).find((d: any) =>
                  d.name === 'AudioServer'
                );
                if (audioServerDevice) {
                  await api.spotifyConnectPlay(spotifyTrackUri, audioServerDevice.id);
                  // Then route the librespot stream to the target device
                  await api.librespotPlayToDevice(spotifyTrackUri, deviceId);
                  setIsLoading(false);
                  toastRef.current('Streaming Spotify via AudioServer to device', 'success');
                  return;
                }
              }
            } catch {
              // Librespot not available, fall through to Spotify Connect
            }

            // Strategy 2: Try matching with Spotify Connect device (e.g. Cocktail Audio)
            const devRes = await api.spotifyConnectDevices();
            const connectDevices = devRes.data || [];
            const match = connectDevices.find((d: any) =>
              d.name.toLowerCase().includes('cocktail') ||
              d.name.toLowerCase().includes('x35')
            );
            if (match) {
              await api.spotifyConnectPlay(spotifyTrackUri, match.id);
              setIsLoading(false);
              toastRef.current(`Playing via Spotify Connect on ${match.name}`, 'success');
              return;
            }
          }

          // Strategy 3: Default — play on whatever active Spotify device
          await api.spotifyConnectPlay(spotifyTrackUri);
          setIsLoading(false);
          toastRef.current('Playing via Spotify Connect', 'success');
        } catch (err) {
          setIsLoading(false);
          setCurrentTrack(null);
          const msg = String(err);
          if (msg.includes('404') || msg.includes('No active device') || msg.includes('NO_ACTIVE_DEVICE')) {
            toastRef.current('Open Spotify on a device first, or start Librespot in Settings', 'error');
          } else {
            toastRef.current(`Spotify: ${(err as Error).message || msg}`, 'error');
          }
        }
      };

      playSpotify();
      return;
    }

    if (isQobuz) {
      // Qobuz: get direct stream URL from API, then play like a local track
      const qobuzId = track.id.replace('qobuz:', '');
      const playQobuz = async () => {
        try {
          const res = await fetch(`/api/providers/qobuz/tracks/${qobuzId}/stream`);
          const data = await res.json();
          if (!data.data?.url) {
            throw new Error('No stream URL from Qobuz');
          }
          const qobuzStreamUrl = data.data.url;

          if (deviceId === 'browser') {
            audio.play(qobuzStreamUrl);
          } else {
            // Send Qobuz CDN URL directly to DLNA/Volumio (no proxy needed)
            await api.devicePlay(deviceId, qobuzStreamUrl, {
              title: track.title,
              artist: track.artistName,
              album: track.albumTitle,
              duration: track.duration,
            });
          }
          setIsLoading(false);
          toastRef.current('Playing from Qobuz', 'success');
        } catch (err) {
          setIsLoading(false);
          setCurrentTrack(null);
          toastRef.current(`Qobuz: ${(err as Error).message || err}`, 'error');
        }
      };
      playQobuz();
      return;
    }

    const streamUrl = api.getStreamUrl(track.id);

    if (deviceId === 'browser') {
      audio.play(streamUrl);
      setIsLoading(false);
    } else {
      // External device: build LAN URL and send via backend
      const lanIp = lanAddressRef.current || window.location.hostname;
      const absoluteUrl = `http://${lanIp}:3001${streamUrl}`;
      console.log(`[AudioServer] Sending to device ${deviceId}: ${absoluteUrl}`);

      api.devicePlay(deviceId, absoluteUrl, {
        title: track.title,
        artist: track.artistName,
        album: track.albumTitle,
        duration: track.duration,
      }, track.id)
        .then(() => {
          setIsLoading(false);
          toastRef.current(`Playing on external device`, 'success');
        })
        .catch((err) => {
          console.error('Device play failed:', err);
          toastRef.current(`Device error: ${err.message || err}`, 'error');
          // Fallback to browser
          audio.play(streamUrl);
          setIsLoading(false);
        });
    }

    // Record in history
    api.play(track, deviceId).catch(() => {});
    api.recordPlay(track.id, track.albumId || '', '').catch(() => {});
  }, [audio]);

  const playTrack = useCallback((track: TrackInfo) => {
    startTrack(track);
  }, [startTrack]);

  const playAlbum = useCallback((tracks: TrackInfo[]) => {
    if (tracks.length === 0) return;
    setQueue(tracks);
    setQueueIndex(0);
    startTrack(tracks[0]);
  }, [startTrack]);

  const addToQueue = useCallback((track: TrackInfo) => {
    setQueue((q) => [...q, track]);
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
    setQueueIndex(-1);
  }, []);

  const playNext = useCallback(() => {
    if (queue.length === 0) return;

    if (repeat === 'one') {
      // Repeat current track
      if (queue[queueIndex]) startTrack(queue[queueIndex]);
      return;
    }

    let nextIndex: number;
    if (shuffle) {
      // Random next track (avoid repeating current)
      nextIndex = Math.floor(Math.random() * queue.length);
      if (nextIndex === queueIndex && queue.length > 1) {
        nextIndex = (nextIndex + 1) % queue.length;
      }
    } else {
      nextIndex = queueIndex + 1;
    }

    if (nextIndex < queue.length) {
      setQueueIndex(nextIndex);
      startTrack(queue[nextIndex]);
    } else if (repeat === 'all') {
      // Loop back to start
      setQueueIndex(0);
      startTrack(queue[0]);
    }
  }, [queue, queueIndex, startTrack, shuffle, repeat]);
  playNextRef.current = playNext;

  const playPrevious = useCallback(() => {
    if (queue.length === 0) return;
    if (audio.currentTime > 3) {
      audio.seek(0);
      return;
    }
    const prevIndex = queueIndex - 1;
    if (prevIndex >= 0) {
      setQueueIndex(prevIndex);
      startTrack(queue[prevIndex]);
    }
  }, [queue, queueIndex, startTrack, audio]);

  const devicePause = useCallback(() => {
    setIsLoading(true);
    const deviceId = selectedDeviceRef.current;
    const isSpotify = currentTrackRef.current?.id.startsWith('spotify:');

    if (isSpotify) {
      api.spotifyConnectPause().then(() => setIsLoading(false)).catch(() => setIsLoading(false));
    } else if (deviceId === 'browser') {
      audio.pause();
      setIsLoading(false);
    } else {
      api.devicePause(deviceId).then(() => setIsLoading(false)).catch(() => setIsLoading(false));
    }
  }, [audio]);

  const deviceResume = useCallback(() => {
    setIsLoading(true);
    const deviceId = selectedDeviceRef.current;
    const isSpotify = currentTrackRef.current?.id.startsWith('spotify:');

    if (isSpotify) {
      api.spotifyConnectResume().then(() => setIsLoading(false)).catch(() => setIsLoading(false));
    } else if (deviceId === 'browser') {
      audio.resume();
      setIsLoading(false);
    } else {
      api.deviceResume(deviceId).then(() => setIsLoading(false)).catch(() => setIsLoading(false));
    }
  }, [audio]);

  const deviceSetVolume = useCallback((v: number) => {
    audio.setVolume(v);
    const deviceId = selectedDeviceRef.current;
    const isSpotify = currentTrackRef.current?.id.startsWith('spotify:');

    if (isSpotify) {
      api.spotifyConnectVolume(Math.round(v * 100)).catch(() => {});
    } else if (deviceId !== 'browser') {
      api.deviceVolume(deviceId, Math.round(v * 100)).catch(() => {});
    }
  }, [audio]);

  const deviceStop = useCallback(() => {
    const deviceId = selectedDeviceRef.current;
    const isSpotify = currentTrackRef.current?.id.startsWith('spotify:');

    if (isSpotify) {
      api.spotifyConnectPause().catch(() => {});
    } else if (deviceId === 'browser') {
      audio.pause();
    } else {
      api.deviceStop(deviceId).catch(() => {});
    }
    setCurrentTrack(null);
    setIsLoading(false);
  }, [audio]);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const toggleRepeat = useCallback(() => {
    setRepeat((r) => r === 'off' ? 'all' : r === 'all' ? 'one' : 'off');
  }, []);

  // Auto-advance to next track when current ends
  audio.setOnEnded(playNext);

  return (
    <AudioCtx.Provider
      value={{
        currentTrack,
        isPlaying: selectedDeviceId === 'browser' ? audio.isPlaying : deviceIsPlaying,
        isLoading,
        currentTime: selectedDeviceId === 'browser' ? audio.currentTime : devicePosition,
        duration: selectedDeviceId === 'browser' ? audio.duration : deviceDuration,
        volume: audio.volume,
        queue,
        queueIndex,
        shuffle,
        repeat,
        selectedDeviceId,
        playTrack,
        playAlbum,
        addToQueue,
        clearQueue,
        playNext,
        playPrevious,
        pause: devicePause,
        resume: deviceResume,
        stop: deviceStop,
        setVolume: deviceSetVolume,
        seek: audio.seek,
        setSelectedDeviceId,
        toggleShuffle,
        toggleRepeat,
      }}
    >
      {children}
    </AudioCtx.Provider>
  );
}

export function useAudioContext() {
  const ctx = useContext(AudioCtx);
  if (!ctx) throw new Error('useAudioContext must be used within AudioProvider');
  return ctx;
}

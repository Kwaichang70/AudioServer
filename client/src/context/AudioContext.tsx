import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useAudio } from '../hooks/useAudio.js';
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
}

const AudioCtx = createContext<AudioContextValue | null>(null);

export function AudioProvider({ children }: { children: ReactNode }) {
  const audio = useAudio();
  const [currentTrack, setCurrentTrack] = useState<TrackInfo | null>(null);
  const [queue, setQueue] = useState<TrackInfo[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [selectedDeviceId, setSelectedDeviceId] = useState('browser');
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  // Use refs so callbacks always see the latest values
  const selectedDeviceRef = useRef(selectedDeviceId);
  selectedDeviceRef.current = selectedDeviceId;
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const lanAddressRef = useRef<string | null>(null);

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => {
      if (d.lanAddress) lanAddressRef.current = d.lanAddress;
    }).catch(() => {});
  }, []);

  const startTrack = useCallback((track: TrackInfo) => {
    setCurrentTrack(track);
    setIsLoading(true);

    const deviceId = selectedDeviceRef.current;
    const isSpotify = track.id.startsWith('spotify:');

    console.log(`[AudioServer] Playing "${track.title}" on device: ${deviceId}, spotify: ${isSpotify}`);

    if (isSpotify) {
      const spotifyTrackUri = `spotify:track:${track.id.replace('spotify:', '')}`;
      api.spotifyConnectPlay(spotifyTrackUri)
        .then(() => {
          setIsLoading(false);
          toastRef.current(`Playing on Spotify Connect`, 'success');
        })
        .catch((err) => {
          setIsLoading(false);
          setCurrentTrack(null);
          const msg = String(err);
          if (msg.includes('404') || msg.includes('No active device') || msg.includes('NO_ACTIVE_DEVICE')) {
            toastRef.current('Open Spotify on your phone or desktop first, then try again', 'error');
          } else {
            toastRef.current(`Spotify: ${err.message || msg}`, 'error');
          }
        });
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
    const nextIndex = queueIndex + 1;
    if (nextIndex < queue.length) {
      setQueueIndex(nextIndex);
      startTrack(queue[nextIndex]);
    }
  }, [queue, queueIndex, startTrack]);

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

  const isSpotifyTrack = currentTrackRef.current?.id.startsWith('spotify:') ?? false;

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

  // Auto-advance to next track when current ends
  audio.setOnEnded(playNext);

  return (
    <AudioCtx.Provider
      value={{
        currentTrack,
        isPlaying: audio.isPlaying,
        isLoading,
        currentTime: audio.currentTime,
        duration: audio.duration,
        volume: audio.volume,
        queue,
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

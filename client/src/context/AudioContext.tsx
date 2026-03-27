import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useAudio } from '../hooks/useAudio.js';
import { api } from '../api/client.js';

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
  const lanAddressRef = useRef<string | null>(null);

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => {
      if (d.lanAddress) lanAddressRef.current = d.lanAddress;
    }).catch(() => {});
  }, []);

  const startTrack = useCallback((track: TrackInfo) => {
    setCurrentTrack(track);
    setIsLoading(true);

    const isSpotify = track.id.startsWith('spotify:');

    if (isSpotify) {
      // Play via Spotify Connect
      const spotifyTrackUri = `spotify:track:${track.id.replace('spotify:', '')}`;
      api.spotifyConnectPlay(spotifyTrackUri)
        .then(() => setIsLoading(false))
        .catch((err) => {
          console.error('Spotify Connect play failed:', err);
          setIsLoading(false);
        });
      return;
    }

    const streamUrl = api.getStreamUrl(track.id);

    if (selectedDeviceId === 'browser') {
      audio.play(streamUrl);
      setIsLoading(false);
    } else {
      // External devices need the backend URL on the LAN (not 127.0.0.1 or Vite proxy)
      const lanIp = lanAddressRef.current || window.location.hostname;
      const absoluteUrl = `http://${lanIp}:3001${streamUrl}`;
      api.devicePlay(selectedDeviceId, absoluteUrl, {
        title: track.title,
        artist: track.artistName,
        album: track.albumTitle,
        duration: track.duration,
      }).then(() => setIsLoading(false))
        .catch((err) => {
          console.error('Device play failed, falling back to browser:', err);
          audio.play(streamUrl);
          setIsLoading(false);
        });
    }

    // Notify server + record in history
    api.play(track, selectedDeviceId).catch(() => {});
    api.recordPlay(track.id, track.albumId || '', '').catch(() => {});
  }, [audio, selectedDeviceId]);

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

  const isSpotifyTrack = currentTrack?.id.startsWith('spotify:') ?? false;

  const devicePause = useCallback(() => {
    setIsLoading(true);
    if (isSpotifyTrack) {
      api.spotifyConnectPause().then(() => setIsLoading(false)).catch(() => setIsLoading(false));
    } else if (selectedDeviceId === 'browser') {
      audio.pause();
      setIsLoading(false);
    } else {
      api.devicePause(selectedDeviceId).then(() => setIsLoading(false)).catch(() => setIsLoading(false));
    }
  }, [audio, selectedDeviceId, isSpotifyTrack]);

  const deviceResume = useCallback(() => {
    setIsLoading(true);
    if (isSpotifyTrack) {
      api.spotifyConnectResume().then(() => setIsLoading(false)).catch(() => setIsLoading(false));
    } else if (selectedDeviceId === 'browser') {
      audio.resume();
      setIsLoading(false);
    } else {
      api.deviceResume(selectedDeviceId).then(() => setIsLoading(false)).catch(() => setIsLoading(false));
    }
  }, [audio, selectedDeviceId, isSpotifyTrack]);

  const deviceSetVolume = useCallback((v: number) => {
    audio.setVolume(v);
    if (isSpotifyTrack) {
      api.spotifyConnectVolume(Math.round(v * 100)).catch(() => {});
    } else if (selectedDeviceId !== 'browser') {
      // DLNA/Sonos use 0-100, browser uses 0-1
      api.deviceVolume(selectedDeviceId, Math.round(v * 100)).catch(() => {});
    }
  }, [audio, selectedDeviceId]);

  const deviceStop = useCallback(() => {
    if (isSpotifyTrack) {
      api.spotifyConnectPause().catch(() => {});
    } else if (selectedDeviceId === 'browser') {
      audio.pause();
    } else {
      api.deviceStop(selectedDeviceId).catch(() => {});
    }
    setCurrentTrack(null);
    setIsLoading(false);
  }, [audio, selectedDeviceId, isSpotifyTrack]);

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

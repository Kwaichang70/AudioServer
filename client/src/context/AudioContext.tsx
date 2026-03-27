import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
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
  currentTime: number;
  duration: number;
  volume: number;
  queue: TrackInfo[];
  playTrack: (track: TrackInfo) => void;
  playAlbum: (tracks: TrackInfo[]) => void;
  addToQueue: (track: TrackInfo) => void;
  clearQueue: () => void;
  playNext: () => void;
  playPrevious: () => void;
  pause: () => void;
  resume: () => void;
  setVolume: (v: number) => void;
  seek: (time: number) => void;
}

const AudioCtx = createContext<AudioContextValue | null>(null);

export function AudioProvider({ children }: { children: ReactNode }) {
  const audio = useAudio();
  const [currentTrack, setCurrentTrack] = useState<TrackInfo | null>(null);
  const [queue, setQueue] = useState<TrackInfo[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);

  const startTrack = useCallback((track: TrackInfo) => {
    setCurrentTrack(track);
    audio.play(api.getStreamUrl(track.id));
  }, [audio]);

  const playTrack = useCallback((track: TrackInfo) => {
    startTrack(track);
    // Don't modify queue when playing a single track
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
    // If more than 3 seconds in, restart current track
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

  // Auto-advance to next track when current ends
  audio.setOnEnded(playNext);

  return (
    <AudioCtx.Provider
      value={{
        currentTrack,
        isPlaying: audio.isPlaying,
        currentTime: audio.currentTime,
        duration: audio.duration,
        volume: audio.volume,
        queue,
        playTrack,
        playAlbum,
        addToQueue,
        clearQueue,
        playNext,
        playPrevious,
        pause: audio.pause,
        resume: audio.resume,
        setVolume: audio.setVolume,
        seek: audio.seek,
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

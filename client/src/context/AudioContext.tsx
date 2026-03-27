import { createContext, useContext, useState, type ReactNode } from 'react';
import { useAudio } from '../hooks/useAudio.js';
import { api } from '../api/client.js';

interface TrackInfo {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  duration?: number;
}

interface AudioContextValue {
  currentTrack: TrackInfo | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  playTrack: (track: TrackInfo) => void;
  pause: () => void;
  resume: () => void;
  setVolume: (v: number) => void;
  seek: (time: number) => void;
}

const AudioCtx = createContext<AudioContextValue | null>(null);

export function AudioProvider({ children }: { children: ReactNode }) {
  const audio = useAudio();
  const [currentTrack, setCurrentTrack] = useState<TrackInfo | null>(null);

  const playTrack = (track: TrackInfo) => {
    setCurrentTrack(track);
    audio.play(api.getStreamUrl(track.id));
  };

  return (
    <AudioCtx.Provider
      value={{
        currentTrack,
        isPlaying: audio.isPlaying,
        currentTime: audio.currentTime,
        duration: audio.duration,
        volume: audio.volume,
        playTrack,
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

import { useState, useRef, useCallback, useEffect } from 'react';

interface AudioState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
}

export function useAudio() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const nextAudioRef = useRef<HTMLAudioElement | null>(null);
  const onEndedRef = useRef<(() => void) | null>(null);
  const crossfadeDurationRef = useRef(0); // 0 = gapless, >0 = crossfade seconds
  const crossfadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<AudioState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 0.7,
  });

  useEffect(() => {
    const audio = new Audio();
    audio.volume = 0.7;
    audioRef.current = audio;

    audio.addEventListener('timeupdate', () => {
      setState((s) => ({ ...s, currentTime: audio.currentTime, duration: audio.duration || 0 }));

      // Crossfade trigger: start fading when near end
      const crossfade = crossfadeDurationRef.current;
      if (crossfade > 0 && audio.duration > 0) {
        const remaining = audio.duration - audio.currentTime;
        if (remaining <= crossfade && remaining > crossfade - 0.5 && !crossfadeTimerRef.current) {
          crossfadeTimerRef.current = setTimeout(() => {
            crossfadeTimerRef.current = null;
          }, crossfade * 1000);
          onEndedRef.current?.();
        }
      }
    });

    audio.addEventListener('ended', () => {
      setState((s) => ({ ...s, isPlaying: false }));
      if (crossfadeDurationRef.current === 0) {
        onEndedRef.current?.();
      }
    });

    return () => {
      audio.pause();
      audio.src = '';
      nextAudioRef.current?.pause();
    };
  }, []);

  const play = useCallback((url: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    // If crossfading, fade out old audio
    const crossfade = crossfadeDurationRef.current;
    if (crossfade > 0 && audio.src && !audio.paused) {
      const oldAudio = audio;
      const startVol = oldAudio.volume;
      const fadeStep = 50; // ms
      const volStep = startVol / (crossfade * 1000 / fadeStep);
      const fadeInterval = setInterval(() => {
        oldAudio.volume = Math.max(0, oldAudio.volume - volStep);
        if (oldAudio.volume <= 0) {
          clearInterval(fadeInterval);
          oldAudio.pause();
          oldAudio.src = '';
        }
      }, fadeStep);

      // Play new track on a fresh element
      const newAudio = new Audio();
      newAudio.volume = 0;
      newAudio.src = url;
      newAudio.play();

      // Fade in new audio
      const fadeInInterval = setInterval(() => {
        newAudio.volume = Math.min(state.volume, newAudio.volume + volStep);
        if (newAudio.volume >= state.volume) {
          clearInterval(fadeInInterval);
        }
      }, fadeStep);

      // Swap refs
      audioRef.current = newAudio;
      nextAudioRef.current = oldAudio;

      // Re-attach events
      newAudio.addEventListener('timeupdate', () => {
        setState((s) => ({ ...s, currentTime: newAudio.currentTime, duration: newAudio.duration || 0 }));

        const remaining = newAudio.duration - newAudio.currentTime;
        if (crossfadeDurationRef.current > 0 && remaining <= crossfadeDurationRef.current && remaining > crossfadeDurationRef.current - 0.5 && !crossfadeTimerRef.current) {
          crossfadeTimerRef.current = setTimeout(() => { crossfadeTimerRef.current = null; }, crossfadeDurationRef.current * 1000);
          onEndedRef.current?.();
        }
      });
      newAudio.addEventListener('ended', () => {
        setState((s) => ({ ...s, isPlaying: false }));
        if (crossfadeDurationRef.current === 0) onEndedRef.current?.();
      });
    } else {
      // Gapless: preload and switch immediately
      audio.src = url;
      audio.play();
    }

    setState((s) => ({ ...s, isPlaying: true }));
  }, [state.volume]);

  const preloadNext = useCallback((url: string) => {
    // Pre-buffer next track for gapless playback
    if (nextAudioRef.current) {
      nextAudioRef.current.pause();
      nextAudioRef.current.src = '';
    }
    const next = new Audio();
    next.preload = 'auto';
    next.src = url;
    next.volume = state.volume;
    nextAudioRef.current = next;
  }, [state.volume]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play();
    setState((s) => ({ ...s, isPlaying: true }));
  }, []);

  const setVolume = useCallback((v: number) => {
    if (audioRef.current) audioRef.current.volume = v;
    setState((s) => ({ ...s, volume: v }));
  }, []);

  const seek = useCallback((time: number) => {
    if (audioRef.current) audioRef.current.currentTime = time;
  }, []);

  const setOnEnded = useCallback((cb: (() => void) | null) => {
    onEndedRef.current = cb;
  }, []);

  const setCrossfadeDuration = useCallback((seconds: number) => {
    crossfadeDurationRef.current = seconds;
  }, []);

  return { ...state, play, pause, resume, setVolume, seek, setOnEnded, preloadNext, setCrossfadeDuration };
}

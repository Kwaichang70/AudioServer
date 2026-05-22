import { useState, useRef, useCallback, useEffect } from 'react';
import { setProgress, resetProgress } from '../context/ProgressStore.js';

// currentTime/duration live in an external store (ProgressStore) — see that
// module for why. This hook's React state only holds the "expensive to update"
// fields (isPlaying, volume) that consumers tend to read directly.
interface AudioState {
  isPlaying: boolean;
  volume: number;
}

// timeupdate fires ~4x/sec; without a per-track guard the crossfade window
// (remaining ∈ (crossfade-0.5, crossfade]) would fire onEnded multiple times
// for the same track. We track which audio element has already fired so the
// next track resets cleanly (vs. the previous timer-based guard which could
// suppress the next track if the timer was still running).
function shouldTriggerCrossfade(audio: HTMLAudioElement, crossfade: number): boolean {
  if (crossfade <= 0 || !Number.isFinite(audio.duration) || audio.duration <= 0) return false;
  const remaining = audio.duration - audio.currentTime;
  return remaining > 0 && remaining <= crossfade;
}

export function useAudio() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const nextAudioRef = useRef<HTMLAudioElement | null>(null);
  const onEndedRef = useRef<(() => void) | null>(null);
  const crossfadeDurationRef = useRef(0); // 0 = gapless, >0 = crossfade seconds
  const crossfadeFiredRef = useRef<WeakSet<HTMLAudioElement>>(new WeakSet());
  const [state, setState] = useState<AudioState>({
    isPlaying: false,
    volume: 0.7,
  });
  // Mirror volume in a ref so callbacks that depend on the latest value can
  // read it without becoming reactive to state.volume changes.
  const volumeRef = useRef(0.7);

  // Attach standard listeners to an audio element (used for the initial element
  // and for each fresh element created during a crossfade swap).
  const attachListeners = useCallback((audio: HTMLAudioElement) => {
    audio.addEventListener('loadedmetadata', () => {
      // New track loaded → allow it to trigger crossfade once.
      crossfadeFiredRef.current.delete(audio);
    });

    audio.addEventListener('timeupdate', () => {
      // Write to the external progress store — no React re-render triggered here.
      setProgress(audio.currentTime, audio.duration || 0);
      const crossfade = crossfadeDurationRef.current;
      if (shouldTriggerCrossfade(audio, crossfade) && !crossfadeFiredRef.current.has(audio)) {
        crossfadeFiredRef.current.add(audio);
        onEndedRef.current?.();
      }
    });

    audio.addEventListener('durationchange', () => {
      // duration becomes known *after* loadedmetadata for some formats; keep
      // the store in sync without waiting for the next timeupdate.
      setProgress(audio.currentTime, audio.duration || 0);
    });

    audio.addEventListener('ended', () => {
      setState((s) => ({ ...s, isPlaying: false }));
      // ended means the track finished naturally — gapless mode triggers the
      // next track here. (Crossfade mode already fired onEnded from timeupdate.)
      if (crossfadeDurationRef.current === 0) {
        onEndedRef.current?.();
      }
      crossfadeFiredRef.current.delete(audio);
    });
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.volume = 0.7;
    audioRef.current = audio;
    attachListeners(audio);

    return () => {
      audio.pause();
      audio.src = '';
      nextAudioRef.current?.pause();
      resetProgress();
    };
  }, [attachListeners]);

  const play = useCallback(
    (url: string) => {
      const audio = audioRef.current;
      if (!audio) return;

      const crossfade = crossfadeDurationRef.current;
      if (crossfade > 0 && audio.src && !audio.paused) {
        // Crossfade: fade out current, fade in new on a fresh element.
        const oldAudio = audio;
        const startVol = oldAudio.volume;
        const fadeStep = 50; // ms
        const volStep = startVol / ((crossfade * 1000) / fadeStep);
        const fadeInterval = setInterval(() => {
          oldAudio.volume = Math.max(0, oldAudio.volume - volStep);
          if (oldAudio.volume <= 0) {
            clearInterval(fadeInterval);
            oldAudio.pause();
            oldAudio.src = '';
            crossfadeFiredRef.current.delete(oldAudio);
          }
        }, fadeStep);

        const newAudio = new Audio();
        newAudio.volume = 0;
        attachListeners(newAudio);
        newAudio.src = url;
        newAudio.play();

        const fadeInInterval = setInterval(() => {
          newAudio.volume = Math.min(state.volume, newAudio.volume + volStep);
          if (newAudio.volume >= state.volume) clearInterval(fadeInInterval);
        }, fadeStep);

        audioRef.current = newAudio;
        nextAudioRef.current = oldAudio;
      } else {
        // Gapless: swap src on the existing element so we don't leak listeners.
        crossfadeFiredRef.current.delete(audio);
        audio.src = url;
        audio.play();
      }

      setState((s) => ({ ...s, isPlaying: true }));
    },
    [state.volume, attachListeners],
  );

  const preloadNext = useCallback(
    (url: string) => {
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
    },
    [state.volume],
  );

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
    volumeRef.current = v;
    setState((s) => ({ ...s, volume: v }));
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    // Seek backwards beyond the crossfade window should re-arm the trigger.
    if (audio.duration > 0 && audio.duration - time > crossfadeDurationRef.current) {
      crossfadeFiredRef.current.delete(audio);
    }
  }, []);

  const setOnEnded = useCallback((cb: (() => void) | null) => {
    onEndedRef.current = cb;
  }, []);

  // Imperative getter for handlers that need the live position without subscribing
  // to ProgressStore re-renders (e.g. "previous track" needs the current time
  // *at the moment of the button press*, not a subscription).
  const getCurrentTime = useCallback((): number => audioRef.current?.currentTime ?? 0, []);
  const getDuration = useCallback((): number => audioRef.current?.duration ?? 0, []);

  const setCrossfadeDuration = useCallback((seconds: number) => {
    crossfadeDurationRef.current = seconds;
  }, []);

  return {
    ...state,
    play,
    pause,
    resume,
    setVolume,
    seek,
    setOnEnded,
    preloadNext,
    setCrossfadeDuration,
    getCurrentTime,
    getDuration,
  };
}

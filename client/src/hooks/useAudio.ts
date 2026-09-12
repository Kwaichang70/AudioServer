import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { setProgress, resetProgress } from '../context/ProgressStore.js';

// currentTime/duration live in an external store (ProgressStore) — see that
// module for why. This hook's React state only holds the "expensive to update"
// fields (isPlaying, volume) that consumers tend to read directly.
interface AudioState {
  isPlaying: boolean;
  /**
   * The browser refused to start audio (autoplay policy, or a decode/network
   * error) after we asked it to. The UI turns this into "press play again"
   * instead of showing a playing state that is not true (V08.3).
   */
  playbackBlocked: 'autoplay' | 'error' | null;
  volume: number;
  /**
   * The last track boundary made in this tab (V11.4): whether the next
   * element was already prepared, and how long the handover took measured in
   * the page. Not a statement about the sound at the speaker.
   */
  lastHandover?: { how: 'preloaded' | 'reloaded'; gapMs: number; at: number };
}

export type ReplayGainMode = 'off' | 'track' | 'album';

export interface ReplayGainData {
  trackGain?: number | null; // dB
  trackPeak?: number | null; // 0..1 ratio
  albumGain?: number | null;
  albumPeak?: number | null;
}

// timeupdate fires ~4x/sec; without a per-track guard the crossfade window
// (remaining ∈ (crossfade-0.5, crossfade]) would fire onEnded multiple times.
function shouldTriggerCrossfade(audio: HTMLAudioElement, crossfade: number): boolean {
  if (crossfade <= 0 || !Number.isFinite(audio.duration) || audio.duration <= 0) return false;
  const remaining = audio.duration - audio.currentTime;
  return remaining > 0 && remaining <= crossfade;
}

// dB → linear amplitude. RG metadata uses dB; the Web Audio GainNode wants amp.
function dbToAmp(db: number): number {
  return Math.pow(10, db / 20);
}

// Cross-origin sources fed to a Web Audio MediaElementSourceNode produce zeros
// (silent output) unless the remote server sends CORS Access-Control-Allow-Origin.
// Tidal/Spotify CDNs don't. So we only route same-origin audio through Web Audio;
// cross-origin URLs play via plain HTML5 <audio> with audio.volume (no ReplayGain).
function isSameOriginUrl(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true; // root-relative
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function classifyPlayError(err: unknown): 'autoplay' | 'error' {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' ? 'autoplay' : 'error';
}

export function useAudio() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const nextAudioRef = useRef<HTMLAudioElement | null>(null);
  /** Which url the preloaded element holds, so play() can recognise it (V11.2). */
  const preloadedUrlRef = useRef<string | null>(null);
  /** When the current track ended, to measure the handover to the next (V11.4). */
  const endedAtRef = useRef<number | null>(null);
  const onEndedRef = useRef<(() => void) | null>(null);
  const crossfadeDurationRef = useRef(0); // 0 = gapless, >0 = crossfade seconds
  const crossfadeFiredRef = useRef<WeakSet<HTMLAudioElement>>(new WeakSet());
  const [state, setState] = useState<AudioState>({
    isPlaying: false,
    volume: 0.7,
    playbackBlocked: null,
  });
  const volumeRef = useRef(0.7);

  // ─── Web Audio + ReplayGain ────────────────────────────────────
  // Lazily created the first time RG is requested. Once an HTMLAudioElement
  // has been wired through createMediaElementSource, audio.volume is bypassed
  // and the GainNode becomes the single volume control for that element.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainMapRef = useRef<WeakMap<HTMLAudioElement, GainNode>>(new WeakMap());
  const rgModeRef = useRef<ReplayGainMode>('off');
  const rgPreampRef = useRef(0); // dB
  const currentRGRef = useRef<ReplayGainData>({});

  const ensureAudioCtx = useCallback((): AudioContext | null => {
    if (audioCtxRef.current) return audioCtxRef.current;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      audioCtxRef.current = new Ctx();
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }, []);

  const attachGain = useCallback(
    (audio: HTMLAudioElement): GainNode | null => {
      const existing = gainMapRef.current.get(audio);
      if (existing) return existing;
      const ctx = ensureAudioCtx();
      if (!ctx) return null;
      try {
        const source = ctx.createMediaElementSource(audio);
        const gain = ctx.createGain();
        source.connect(gain).connect(ctx.destination);
        gainMapRef.current.set(audio, gain);
        // Once routed through Web Audio, GainNode is the volume control —
        // pin element.volume to 1 and let GainNode multiply.
        audio.volume = 1.0;
        return gain;
      } catch (err) {
        // createMediaElementSource throws if Web Audio is unsupported or the
        // element was already attached to a different context. Fall back to
        // HTML5 volume in that case.

        console.warn('[useAudio] Web Audio attach failed', err);
        return null;
      }
    },
    [ensureAudioCtx],
  );

  const computeReplayGainAmp = useCallback((): number => {
    const mode = rgModeRef.current;
    const preampDb = rgPreampRef.current;
    if (mode === 'off') return dbToAmp(preampDb);

    const data = currentRGRef.current;
    const gain = mode === 'album' ? data.albumGain : data.trackGain;
    const peak = mode === 'album' ? data.albumPeak : data.trackPeak;
    if (gain == null) return dbToAmp(preampDb); // no RG tag → preamp only

    let amp = dbToAmp(gain + preampDb);
    // Prevent inter-sample peaks from clipping after gain is applied.
    if (peak != null && peak > 0 && peak * amp > 1) amp = 1 / peak;
    return amp;
  }, []);

  const applyVolume = useCallback(
    (audio: HTMLAudioElement | null): void => {
      if (!audio) return;
      const gain = gainMapRef.current.get(audio);
      if (gain) {
        gain.gain.value = volumeRef.current * computeReplayGainAmp();
      } else {
        audio.volume = volumeRef.current;
      }
    },
    [computeReplayGainAmp],
  );

  // Attach the standard event listeners to an audio element.
  const attachListeners = useCallback((audio: HTMLAudioElement) => {
    audio.addEventListener('loadedmetadata', () => {
      crossfadeFiredRef.current.delete(audio);
    });

    audio.addEventListener('timeupdate', () => {
      setProgress(audio.currentTime, audio.duration || 0);
      const crossfade = crossfadeDurationRef.current;
      if (shouldTriggerCrossfade(audio, crossfade) && !crossfadeFiredRef.current.has(audio)) {
        crossfadeFiredRef.current.add(audio);
        onEndedRef.current?.();
      }
    });

    audio.addEventListener('durationchange', () => {
      setProgress(audio.currentTime, audio.duration || 0);
    });

    audio.addEventListener('ended', () => {
      setState((s) => ({ ...s, isPlaying: false }));
      // The boundary starts here; play() of the next track closes it (V11.4).
      endedAtRef.current = performance.now();
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
      // Don't close audioCtxRef — let the browser GC it. close() is permanent
      // and would break the app if the component unmounts during HMR.
    };
  }, [attachListeners]);

  // Set ramped gain via a Web Audio GainNode (preferred) or fall back to
  // setting audio.volume on a tick. Returns a Promise<void> that resolves
  // when the fade finishes so callers can clean up.
  const fadeVia = useCallback(
    (audio: HTMLAudioElement, from: number, to: number, ms: number): Promise<void> => {
      const gain = gainMapRef.current.get(audio);
      if (gain && audioCtxRef.current) {
        const ctx = audioCtxRef.current;
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(from, now);
        gain.gain.linearRampToValueAtTime(to, now + ms / 1000);
        return new Promise((resolve) => setTimeout(resolve, ms));
      }
      // HTML5 fallback: step every 50ms.
      return new Promise((resolve) => {
        const step = 50;
        const steps = Math.max(1, Math.floor(ms / step));
        const delta = (to - from) / steps;
        let i = 0;
        audio.volume = from;
        const id = setInterval(() => {
          i++;
          audio.volume = Math.max(0, Math.min(1, from + delta * i));
          if (i >= steps) {
            clearInterval(id);
            resolve();
          }
        }, step);
      });
    },
    [],
  );

  /**
   * How the last boundary was made and how long it took, measured in the page
   * (V11.4). This is the handover inside the browser — from the end of one
   * element to the start of the next — not the sound coming out of a speaker:
   * a real gapless verdict still needs a recording.
   */
  const handedOver = useCallback((how: 'preloaded' | 'reloaded'): void => {
    const endedAt = endedAtRef.current;
    endedAtRef.current = null;
    if (endedAt === null) return; // a manual start, not a boundary
    const gapMs = Math.max(0, Math.round(performance.now() - endedAt));
    setState((s) => ({ ...s, lastHandover: { how, gapMs, at: Date.now() } }));
  }, []);

  /**
   * `HTMLMediaElement.play()` returns a promise that rejects when the browser
   * blocks autoplay (NotAllowedError) or cannot play the source. An
   * unhandled rejection used to leave isPlaying=true with silent speakers.
   */
  const startPlayback = useCallback((element: HTMLAudioElement): void => {
    let result: Promise<void> | undefined;
    try {
      result = element.play() as Promise<void> | undefined;
    } catch (err) {
      setState((s) => ({ ...s, isPlaying: false, playbackBlocked: classifyPlayError(err) }));
      return;
    }
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => {
        setState((s) => ({ ...s, isPlaying: false, playbackBlocked: classifyPlayError(err) }));
      });
    }
  }, []);

  const play = useCallback(
    (url: string) => {
      let audio = audioRef.current;
      if (!audio) return;

      // iOS Safari starts the AudioContext suspended; resume it inside a user
      // gesture (play click counts).
      audioCtxRef.current?.resume().catch(() => {});

      const sameOrigin = isSameOriginUrl(url);

      // If the current audio element has been routed through Web Audio (from a
      // prior local play) but the next URL is cross-origin, the MediaElementSource
      // would silence the output. Swap in a fresh element that bypasses Web Audio.
      if (!sameOrigin && gainMapRef.current.has(audio)) {
        audio.pause();
        audio.src = '';
        const fresh = new Audio();
        attachListeners(fresh);
        audioRef.current = fresh;
        audio = fresh;
      }

      const crossfade = crossfadeDurationRef.current;
      if (crossfade > 0 && audio.src && !audio.paused) {
        // Crossfade: fade out current, fade in new on a fresh element.
        const oldAudio = audio;
        const fadeMs = crossfade * 1000;
        fadeVia(oldAudio, volumeRef.current, 0, fadeMs).then(() => {
          oldAudio.pause();
          oldAudio.src = '';
          crossfadeFiredRef.current.delete(oldAudio);
        });

        const newAudio = new Audio();
        attachListeners(newAudio);
        newAudio.src = url;
        // Only route same-origin sources through Web Audio (CORS would zero
        // out cross-origin streams like Tidal/Spotify CDNs).
        if (audioCtxRef.current && sameOrigin) attachGain(newAudio);
        if (gainMapRef.current.has(newAudio)) {
          gainMapRef.current.get(newAudio)!.gain.value = 0;
        } else {
          newAudio.volume = 0;
        }
        startPlayback(newAudio);
        fadeVia(newAudio, 0, volumeRef.current * computeReplayGainAmp(), fadeMs);

        audioRef.current = newAudio;
        nextAudioRef.current = oldAudio;
      } else {
        // Take over the element that was preloaded for exactly this url
        // (V11.2). Until now the buffer was prepared and then thrown away by
        // assigning a new src, which is why the browser still had to fetch
        // and decode at the boundary. `readyState >= HAVE_CURRENT_DATA` means
        // it can start on the spot; anything less and loading it again is no
        // worse than what we had.
        const prepared =
          preloadedUrlRef.current === url &&
          nextAudioRef.current &&
          nextAudioRef.current.readyState >= 2
            ? nextAudioRef.current
            : null;

        if (prepared) {
          audio.pause();
          audio.src = '';
          crossfadeFiredRef.current.delete(audio);
          nextAudioRef.current = null;
          preloadedUrlRef.current = null;
          audioRef.current = prepared;
          applyVolume(prepared);
          startPlayback(prepared);
          handedOver('preloaded');
        } else {
          // Gapless: swap src on the existing element.
          crossfadeFiredRef.current.delete(audio);
          audio.src = url;
          if (audioCtxRef.current && sameOrigin) attachGain(audio);
          applyVolume(audio);
          startPlayback(audio);
          handedOver('reloaded');
        }
      }

      setState((s) => ({ ...s, isPlaying: true, playbackBlocked: null }));
    },
    [
      applyVolume,
      attachGain,
      attachListeners,
      computeReplayGainAmp,
      fadeVia,
      handedOver,
      startPlayback,
    ],
  );

  const preloadNext = useCallback(
    (url: string) => {
      if (preloadedUrlRef.current === url && nextAudioRef.current) return;
      if (nextAudioRef.current) {
        nextAudioRef.current.pause();
        nextAudioRef.current.src = '';
      }
      const next = new Audio();
      next.preload = 'auto';
      // The element must carry the same listeners as the current one: once
      // play() takes it over (V11.2) it IS the current one, and without them
      // progress, crossfade and end-of-track would go silent.
      attachListeners(next);
      next.src = url;
      // Same caveat as in play(): skip Web Audio for cross-origin (would silence).
      if (audioCtxRef.current && isSameOriginUrl(url)) attachGain(next);
      applyVolume(next);
      nextAudioRef.current = next;
      preloadedUrlRef.current = url;
    },
    [applyVolume, attachGain, attachListeners],
  );

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState((s) => ({ ...s, isPlaying: false }));
  }, []);

  const resume = useCallback(() => {
    audioCtxRef.current?.resume().catch(() => {});
    if (audioRef.current) startPlayback(audioRef.current);
    setState((s) => ({ ...s, isPlaying: true, playbackBlocked: null }));
  }, [startPlayback]);

  const setVolume = useCallback(
    (v: number) => {
      volumeRef.current = v;
      applyVolume(audioRef.current);
      setState((s) => ({ ...s, volume: v }));
    },
    [applyVolume],
  );

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = time;
    if (audio.duration > 0 && audio.duration - time > crossfadeDurationRef.current) {
      crossfadeFiredRef.current.delete(audio);
    }
  }, []);

  const setOnEnded = useCallback((cb: (() => void) | null) => {
    onEndedRef.current = cb;
  }, []);

  const getCurrentTime = useCallback((): number => audioRef.current?.currentTime ?? 0, []);
  const getDuration = useCallback((): number => audioRef.current?.duration ?? 0, []);
  const isPaused = useCallback((): boolean => audioRef.current?.paused ?? true, []);

  const setCrossfadeDuration = useCallback((seconds: number) => {
    crossfadeDurationRef.current = seconds;
  }, []);

  /**
   * Configure replay-gain. Mode and preamp are global; track/album RG comes
   * from the current track's DB record. Call this from AudioContext on track
   * change and when the user changes the Settings UI sliders.
   */
  const setReplayGain = useCallback(
    (opts: { mode?: ReplayGainMode; preampDb?: number; data?: ReplayGainData }) => {
      if (opts.mode != null) rgModeRef.current = opts.mode;
      if (opts.preampDb != null) rgPreampRef.current = opts.preampDb;
      if (opts.data) currentRGRef.current = opts.data;

      // Activating RG → make sure Web Audio is wired up for the current track.
      const needsWebAudio = rgModeRef.current !== 'off' || rgPreampRef.current !== 0;
      const currentUrl = audioRef.current?.currentSrc || audioRef.current?.src || '';
      if (
        needsWebAudio &&
        audioRef.current &&
        isSameOriginUrl(currentUrl) &&
        !gainMapRef.current.has(audioRef.current)
      ) {
        attachGain(audioRef.current);
      }
      applyVolume(audioRef.current);
    },
    [applyVolume, attachGain],
  );

  return useMemo(
    () => ({
      ...state,
      play,
      pause,
      resume,
      setVolume,
      seek,
      setOnEnded,
      preloadNext,
      setCrossfadeDuration,
      setReplayGain,
      getCurrentTime,
      getDuration,
      isPaused,
    }),
    [
      state,
      play,
      pause,
      resume,
      setVolume,
      seek,
      setOnEnded,
      preloadNext,
      setCrossfadeDuration,
      setReplayGain,
      getCurrentTime,
      getDuration,
      isPaused,
    ],
  );
}

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useAudio } from '../hooks/useAudio.js';
import { useMediaSession } from '../hooks/useMediaSession.js';
import { useSocket } from '../hooks/useSocket.js';
import { useSpotifyWebPlayback } from '../hooks/useSpotifyWebPlayback.js';
import { useTrackPlayback } from '../hooks/useTrackPlayback.js';
import { api } from '../api/client.js';
import { useToast } from '../components/Toast.js';
import { setProgress } from './ProgressStore.js';
import { DEVICE_POLL_INTERVAL, STORAGE_KEYS } from '../constants.js';
import type { TrackInfo } from '../types/playback.js';

// Re-export so consumers can keep importing from this module.
export { useProgress } from './ProgressStore.js';
export type { TrackInfo } from '../types/playback.js';

export type ReplayGainMode = 'off' | 'track' | 'album';

interface AudioContextValue {
  currentTrack: TrackInfo | null;
  isPlaying: boolean;
  isLoading: boolean;
  // currentTime/duration are intentionally NOT here — use `useProgress()` for
  // those (it subscribes to a leaner external store so consumers that only need
  // the rest of the context don't re-render at the timeupdate rate).
  volume: number;
  queue: TrackInfo[];
  queueIndex: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  crossfade: number;
  setCrossfade: (seconds: number) => void;
  replayGainMode: ReplayGainMode;
  setReplayGainMode: (mode: ReplayGainMode) => void;
  replayGainPreamp: number; // dB
  setReplayGainPreamp: (db: number) => void;
  selectedDeviceId: string;
  playTrack: (track: TrackInfo) => void;
  playAlbum: (tracks: TrackInfo[]) => void;
  addToQueue: (track: TrackInfo) => void;
  clearQueue: () => void;
  removeFromQueue: (index: number) => void;
  moveInQueue: (from: number, to: number) => void;
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
  const { subscribeDevice, unsubscribeDevice } = socket;
  // Spotify Web Playback SDK: only loaded once the user actually plays a
  // Spotify track in the browser (lazy — keeps the SDK script + token polling
  // off the table for users who never touch Spotify). Requires Premium + a
  // completed Spotify OAuth connection.
  const [spotifyWebWanted, setSpotifyWebWanted] = useState(false);
  const spotifyWeb = useSpotifyWebPlayback(spotifyWebWanted);
  const spotifyWebSetVolumeRef = useRef(spotifyWeb.setVolume);
  spotifyWebSetVolumeRef.current = spotifyWeb.setVolume;
  const [currentTrack, setCurrentTrack] = useState<TrackInfo | null>(null);
  const [queue, setQueue] = useState<TrackInfo[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState(
    () => localStorage.getItem(STORAGE_KEYS.selectedDevice) || 'browser',
  );

  const setSelectedDeviceId = useCallback((id: string) => {
    setSelectedDeviceIdState(id);
    localStorage.setItem(STORAGE_KEYS.selectedDevice, id);
  }, []);
  const [isLoading, setIsLoading] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<'off' | 'all' | 'one'>('off');
  const [crossfade, setCrossfadeState] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.crossfade);
    return saved ? Number(saved) : 0;
  });
  // ReplayGain: mode (off/track/album) + preamp in dB. Persisted across sessions.
  const [replayGainMode, setReplayGainModeState] = useState<ReplayGainMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.replayGainMode);
    return saved === 'track' || saved === 'album' ? saved : 'off';
  });
  const [replayGainPreamp, setReplayGainPreampState] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.replayGainPreamp);
    return saved ? Number(saved) : 0;
  });

  const setReplayGainMode = useCallback(
    (mode: ReplayGainMode) => {
      setReplayGainModeState(mode);
      localStorage.setItem(STORAGE_KEYS.replayGainMode, mode);
      audio.setReplayGain({ mode });
    },
    [audio],
  );

  const setReplayGainPreamp = useCallback(
    (db: number) => {
      setReplayGainPreampState(db);
      localStorage.setItem(STORAGE_KEYS.replayGainPreamp, String(db));
      audio.setReplayGain({ preampDb: db });
    },
    [audio],
  );

  // Apply persisted RG settings to the player on mount so the first play()
  // already has them set.
  useEffect(() => {
    audio.setReplayGain({ mode: replayGainMode, preampDb: replayGainPreamp });
    // Only on mount — subsequent changes flow through setReplayGainMode/Preamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCrossfade = useCallback(
    (seconds: number) => {
      setCrossfadeState(seconds);
      localStorage.setItem(STORAGE_KEYS.crossfade, String(seconds));
      audio.setCrossfadeDuration(seconds);
    },
    [audio],
  );
  const [deviceIsPlaying, setDeviceIsPlaying] = useState(false);
  const [deviceVolume, setDeviceVolume] = useState<number | null>(null);
  const { toast } = useToast();

  // Use refs so callbacks always see the latest values
  const selectedDeviceRef = useRef(selectedDeviceId);
  selectedDeviceRef.current = selectedDeviceId;
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // External local renderers (DLNA/Sonos, not the browser and not a Spotify
  // Connect target). For these the SERVER owns queue advancement — see the
  // queue-sync effect below and server/src/services/server-player.ts.
  const isExternalLocalDevice = (deviceId: string) =>
    deviceId !== 'browser' && !deviceId.startsWith('spotify-connect:');

  // Surface Web Playback SDK init failures (most commonly "Premium required")
  // so browser-Spotify doesn't fail silently.
  useEffect(() => {
    if (spotifyWeb.error) {
      toastRef.current(`Spotify browser player: ${spotifyWeb.error}`, 'error');
    }
  }, [spotifyWeb.error]);

  const fallbackToBrowserPlayback = useCallback(
    (streamUrl: string, reason: string) => {
      selectedDeviceRef.current = 'browser';
      setSelectedDeviceIdState('browser');
      localStorage.setItem(STORAGE_KEYS.selectedDevice, 'browser');
      setProgress(0, 0);
      setDeviceIsPlaying(false);
      setDeviceVolume(null);
      audio.play(streamUrl);
      setIsLoading(false);
      toastRef.current(`${reason}; switched to browser playback`, 'info');
    },
    [audio],
  );

  // Subscribe to device updates via WebSocket (replaces client-side polling)
  useEffect(() => {
    if (selectedDeviceId === 'browser' || selectedDeviceId.startsWith('spotify-connect:')) {
      // Browser playback and Spotify Connect targets aren't backend-registered
      // DLNA devices — there's no device status to subscribe to.
      unsubscribeDevice(selectedDeviceId);
      setProgress(0, 0);
      setDeviceIsPlaying(false);
      setDeviceVolume(null);
      return;
    }
    subscribeDevice(selectedDeviceId);
    // Fetch initial device status (volume etc.) so the slider reflects reality
    api
      .getDeviceStatus(selectedDeviceId)
      .then((res) => {
        if (selectedDeviceRef.current !== selectedDeviceId) return;
        if (typeof res?.data?.volume === 'number') {
          setDeviceVolume(res.data.volume / 100);
        }
      })
      .catch(() => {});
    return () => unsubscribeDevice(selectedDeviceId);
  }, [selectedDeviceId, subscribeDevice, unsubscribeDevice]);

  // Process WebSocket device updates: mirror external-device state into the
  // transport UI. Track-end advancement for external local devices is handled
  // SERVER-side (device-monitor → playbackService.advance → server-player
  // streams the next track), so it keeps working while this client sleeps —
  // we deliberately do NOT advance the queue from here anymore, that would
  // double-advance. The playback:track-changed effect below mirrors the
  // server's advances into the UI.
  useEffect(() => {
    if (!socket.deviceUpdate || socket.deviceUpdate.deviceId !== selectedDeviceRef.current) return;

    const u = socket.deviceUpdate;
    setDeviceIsPlaying(u.state === 'playing');
    if (typeof u.volume === 'number') setDeviceVolume(u.volume / 100);
    if (selectedDeviceRef.current !== 'browser') {
      // Mirror device position into ProgressStore so useProgress() works
      // regardless of whether the user picked the browser or a remote device.
      setProgress(u.position, u.duration);
    }
  }, [socket.deviceUpdate]);

  // Fallback: if WebSocket disconnected, use polling
  useEffect(() => {
    if (socket.connected || selectedDeviceId === 'browser' || !currentTrack) return;
    if (selectedDeviceId.startsWith('spotify-connect:')) return;
    if (currentTrack.id.startsWith('spotify:')) return;

    const poll = setInterval(() => {
      api
        .getDeviceStatus(selectedDeviceId)
        .then((res) => {
          if (selectedDeviceRef.current !== selectedDeviceId) return;
          const pos = res.data.position || 0;
          const dur = res.data.duration || 0;
          setDeviceIsPlaying(res.data.state === 'playing');
          setProgress(pos, dur);
        })
        .catch(() => {});
    }, DEVICE_POLL_INTERVAL);

    return () => clearInterval(poll);
  }, [socket.connected, currentTrack, selectedDeviceId]);

  const { startTrack, cancelPendingPlayback } = useTrackPlayback({
    audio,
    selectedDeviceId,
    spotifyWebDeviceId: spotifyWeb.deviceId,
    pauseSpotifyWeb: spotifyWeb.pause,
    setSelectedDeviceId,
    setSpotifyWebWanted,
    setCurrentTrack,
    setIsLoading,
    fallbackToBrowserPlayback,
    toast,
    getQueue: () => queueRef.current,
  });

  const playTrack = useCallback(
    (track: TrackInfo) => {
      // Always seed a queue so shuffle/repeat/next/prev have something to act on.
      setQueue([track]);
      setQueueIndex(0);
      startTrack(track);
    },
    [startTrack],
  );

  // Mirror server-side queue advances. For external local devices the server
  // has ALREADY streamed the track to the device (server-player), so only the
  // UI updates here; re-dispatching would restart the track. Provider tracks
  // (spotify:/qobuz:) can't be served from the NAS disk — the server skips
  // them and this awake client routes them through its provider path instead.
  // Ref-equality guard: `queue` is a dependency, so without it a queue edit
  // would re-run this effect with the same event and re-trigger playback.
  const handledTrackChangeRef = useRef<object | null>(null);
  useEffect(() => {
    if (!socket.trackChanged || socket.trackChanged === handledTrackChangeRef.current) return;
    handledTrackChangeRef.current = socket.trackChanged;

    const nextTrack = socket.trackChanged;
    const nextIndex = queue.findIndex((track) => track.id === nextTrack.id);
    if (nextIndex >= 0) setQueueIndex(nextIndex);

    const serverManaged =
      isExternalLocalDevice(selectedDeviceRef.current) && !nextTrack.id.includes(':');
    if (serverManaged) {
      setCurrentTrack((prev) => (prev?.id === nextTrack.id ? prev : { ...nextTrack }));
      setIsLoading(false);
      return;
    }
    startTrack(nextTrack);
  }, [socket.trackChanged, queue, startTrack]);

  // Hand the queue to the server whenever an external local device is in
  // charge. From that moment the NAS advances the album itself (device-monitor
  // detects track end → next track is streamed server-side), so playback
  // continues when this tablet goes to sleep. Keyed to avoid re-posting the
  // identical state; queueIndex changes re-sync so the server stays aligned
  // after manual next/previous too.
  const queueSyncKeyRef = useRef('');
  useEffect(() => {
    if (!isExternalLocalDevice(selectedDeviceId) || queue.length === 0) return;
    const key = [
      selectedDeviceId,
      queueIndex,
      shuffle,
      repeat,
      queue.map((t) => t.id).join(','),
    ].join('§');
    if (queueSyncKeyRef.current === key) return;
    queueSyncKeyRef.current = key;
    api
      .setServerQueue(queue, Math.max(0, queueIndex), selectedDeviceId, shuffle, repeat)
      .catch(() => {
        // Allow a retry on the next state change
        queueSyncKeyRef.current = '';
      });
  }, [queue, queueIndex, shuffle, repeat, selectedDeviceId]);

  const playAlbum = useCallback(
    (tracks: TrackInfo[]) => {
      if (tracks.length === 0) return;
      setQueue(tracks);
      setQueueIndex(0);
      startTrack(tracks[0]);
    },
    [startTrack],
  );

  const addToQueue = useCallback((track: TrackInfo) => {
    setQueue((q) => [...q, track]);
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
    setQueueIndex(-1);
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    setQueue((q) => {
      const newQueue = [...q];
      newQueue.splice(index, 1);
      return newQueue;
    });
    setQueueIndex((curr) => {
      if (index < curr) return curr - 1;
      // The removed track can keep playing until it ends. Point just before
      // its former successor so playNext() advances to that successor instead
      // of skipping it in the shortened queue.
      if (index === curr) return curr - 1;
      return curr;
    });
  }, []);

  const moveInQueue = useCallback((from: number, to: number) => {
    setQueue((q) => {
      const newQueue = [...q];
      const [item] = newQueue.splice(from, 1);
      newQueue.splice(to, 0, item);
      return newQueue;
    });
    setQueueIndex((curr) => {
      if (curr === from) return to;
      if (from < curr && to >= curr) return curr - 1;
      if (from > curr && to <= curr) return curr + 1;
      return curr;
    });
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

  // Mirror playNext in a ref so the Spotify-SDK state effect can call the
  // latest version without re-subscribing on every queue change.
  const playNextRef = useRef(playNext);
  playNextRef.current = playNext;

  // Feed Spotify Web Playback SDK state into the rest of the app when a Spotify
  // track is playing in the browser: progress bar (ProgressStore), the playing
  // indicator, and auto-advance when a track finishes. Without this the SDK
  // plays but the transport UI is dead (it's driven by the <audio> element,
  // which the SDK bypasses).
  const spotifyEndedGuardRef = useRef(false);
  const spotifyPlaybackRef = useRef<{
    trackId: string;
    hasPlayed: boolean;
    position: number;
    duration: number;
  } | null>(null);
  useEffect(() => {
    const pb = spotifyWeb.playback;
    const isSpotifyBrowser =
      selectedDeviceRef.current === 'browser' &&
      !!currentTrackRef.current?.id.startsWith('spotify:');
    if (!isSpotifyBrowser) {
      spotifyPlaybackRef.current = null;
      spotifyEndedGuardRef.current = false;
      return;
    }

    const expectedTrackId = currentTrackRef.current!.id.slice('spotify:'.length);
    const previous = spotifyPlaybackRef.current;

    // At natural end some SDK/browser combinations emit a null state instead
    // of the more common paused-at-zero snapshot. Only treat that as ended if
    // this same track was playing and its last observed position was near the
    // duration; disconnects and manual stops must not skip the queue.
    if (!pb) {
      const endedWithEmptyState =
        previous?.trackId === expectedTrackId &&
        previous.hasPlayed &&
        previous.duration > 0 &&
        previous.position >= previous.duration - 2;
      if (endedWithEmptyState && !spotifyEndedGuardRef.current) {
        spotifyEndedGuardRef.current = true;
        playNextRef.current();
      }
      return;
    }

    // Ignore a final, stale SDK event from the preceding track while the next
    // Spotify URI is being transferred to the web player.
    if (pb.trackId && pb.trackId !== expectedTrackId) return;

    setProgress(pb.position, pb.duration);

    const trackedId = pb.trackId ?? expectedTrackId;
    const sameTrack = previous?.trackId === trackedId;
    const hasPlayed = !pb.paused || (sameTrack && previous?.hasPlayed === true);
    spotifyPlaybackRef.current = {
      trackId: trackedId,
      hasPlayed,
      position: pb.position,
      duration: pb.duration,
    };

    // Spotify uses both paused-at-zero and paused-at-duration for a naturally
    // completed single-track URI. Requiring evidence that this track actually
    // played prevents an initial paused-at-zero SDK snapshot from skipping it.
    const ended =
      pb.paused &&
      hasPlayed &&
      pb.duration > 0 &&
      (pb.position <= 0.25 || pb.position >= pb.duration - 1.5);
    if (ended && !spotifyEndedGuardRef.current) {
      spotifyEndedGuardRef.current = true;
      playNextRef.current();
    } else if (!pb.paused) {
      spotifyEndedGuardRef.current = false;
    }
  }, [spotifyWeb.playback, currentTrack?.id, selectedDeviceId]);

  // External Spotify Connect playback (Sonos, CocktailAudio): Spotify streams
  // straight to the speaker, so there's no <audio> element or SDK to read. Poll
  // Spotify's own player state to drive the transport UI (progress bar +
  // play/pause indicator + volume), interpolating locally between polls so the
  // bar advances smoothly, and auto-advance our queue when the track ends (we
  // send single-track URIs, so the speaker would otherwise just stop).
  useEffect(() => {
    const active =
      selectedDeviceId.startsWith('spotify-connect:') && !!currentTrack?.id.startsWith('spotify:');
    if (!active) return;

    let pos = 0;
    let dur = 0;
    let playing = false;
    let endedFired = false;

    // Fail-safe end detection: only advance when the last known position was
    // genuinely at the end of the track (≥ dur − 1.5s). A manual stop or pause
    // mid-track leaves pos well short of the end, so it never mis-skips.
    const advanceIfEnded = () => {
      if (!endedFired && dur > 0 && pos >= dur - 1.5) {
        endedFired = true;
        playNextRef.current();
        return true;
      }
      return false;
    };

    const poll = () => {
      api
        .spotifyConnectState()
        .then((res) => {
          const st = res.data;
          // Speaker went idle (single-track URI finished) — advance if we were
          // at the end.
          if (!st || !st.item) {
            advanceIfEnded();
            return;
          }
          // Stopped exactly at the end (some devices freeze at dur, others
          // reset) — advance.
          if (!st.is_playing && advanceIfEnded()) return;
          if (st.is_playing) endedFired = false;
          pos = (st.progress_ms ?? 0) / 1000;
          dur = (st.item.duration_ms ?? 0) / 1000;
          playing = !!st.is_playing;
          setDeviceIsPlaying(playing);
          if (dur > 0) setProgress(pos, dur);
          if (typeof st.device?.volume_percent === 'number') {
            setDeviceVolume(st.device.volume_percent / 100);
          }
          // Album-context playback: Spotify advances tracks on the speaker
          // itself (no client involved). Mirror whatever Spotify reports as
          // the playing item into our UI so title/queue highlight follow.
          const polledUriId = st.item.uri?.split(':').pop();
          if (playing && polledUriId) {
            const polledId = `spotify:${polledUriId}`;
            if (polledId !== currentTrackRef.current?.id) {
              endedFired = false;
              const queued = queueRef.current.find((t) => t.id === polledId);
              const idx = queueRef.current.findIndex((t) => t.id === polledId);
              if (idx >= 0) setQueueIndex(idx);
              setCurrentTrack(
                queued ?? {
                  id: polledId,
                  title: st.item.name ?? 'Spotify',
                  artistName: st.item.artists?.[0]?.name ?? '',
                  albumTitle: st.item.album?.name ?? '',
                  duration: dur || undefined,
                },
              );
            }
          }
        })
        .catch(() => {});
    };

    poll();
    const pollId = setInterval(poll, 3000);
    const tickId = setInterval(() => {
      if (playing && dur > 0) {
        pos = Math.min(dur, pos + 1);
        setProgress(pos, dur);
      }
    }, 1000);

    return () => {
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, [selectedDeviceId, currentTrack]);

  const playPrevious = useCallback(() => {
    if (queue.length === 0) return;
    if (audio.getCurrentTime() > 3) {
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
      api
        .spotifyConnectPause()
        .then(() => setIsLoading(false))
        .catch(() => setIsLoading(false));
    } else if (deviceId === 'browser') {
      audio.pause();
      setIsLoading(false);
    } else {
      api
        .devicePause(deviceId)
        .then(() => setIsLoading(false))
        .catch(() => setIsLoading(false));
    }
  }, [audio]);

  const deviceResume = useCallback(() => {
    setIsLoading(true);
    const deviceId = selectedDeviceRef.current;
    const isSpotify = currentTrackRef.current?.id.startsWith('spotify:');

    if (isSpotify) {
      api
        .spotifyConnectResume()
        .then(() => setIsLoading(false))
        .catch(() => setIsLoading(false));
    } else if (deviceId === 'browser') {
      audio.resume();
      setIsLoading(false);
    } else {
      api
        .deviceResume(deviceId)
        .then(() => setIsLoading(false))
        .catch(() => setIsLoading(false));
    }
  }, [audio]);

  const deviceSetVolume = useCallback(
    (v: number) => {
      const deviceId = selectedDeviceRef.current;
      const isSpotify = currentTrackRef.current?.id.startsWith('spotify:');

      if (deviceId === 'browser') {
        // Browser output: keep the <audio> element's volume in sync — the
        // slider reads audio.volume for the browser device, and local tracks
        // play through that element.
        audio.setVolume(v);
        // A Spotify track on the browser device actually comes out of the Web
        // Playback SDK, so set its volume locally. NOT via the Web API: that
        // fires a request per slider tick and trips the rate limit (429).
        if (isSpotify) {
          spotifyWebSetVolumeRef.current?.(v);
        }
        return;
      }

      // External device or Spotify Connect: update optimistic UI state,
      // don't touch the browser audio element (its volume is unrelated).
      setDeviceVolume(v);
      if (isSpotify) {
        api.spotifyConnectVolume(Math.round(v * 100)).catch(() => {});
      } else {
        api.deviceVolume(deviceId, Math.round(v * 100)).catch(() => {});
      }
    },
    [audio],
  );

  const deviceStop = useCallback(() => {
    cancelPendingPlayback();
    const deviceId = selectedDeviceRef.current;
    const isSpotify = currentTrackRef.current?.id.startsWith('spotify:');

    if (isSpotify) {
      api.spotifyConnectPause().catch(() => {});
    } else if (deviceId === 'browser') {
      audio.pause();
    } else {
      api.deviceStop(deviceId).catch(() => {});
      // Tell the server too: playbackService.stop() releases server-driven
      // playback (unpins the device monitor) so it stops polling/advancing.
      api.stop().catch(() => {});
    }
    setCurrentTrack(null);
    setIsLoading(false);
  }, [audio, cancelPendingPlayback]);

  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);
  const toggleRepeat = useCallback(() => {
    setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));
  }, []);

  // Keep the audio element subscribed to the latest queue handler. Registering
  // this during render is a side effect and can leak stale handlers under
  // StrictMode; the effect also clears the callback on unmount.
  useEffect(() => {
    audio.setOnEnded(playNext);
    return () => audio.setOnEnded(null);
  }, [audio, playNext]);

  const isPlaying =
    selectedDeviceId === 'browser'
      ? // Spotify-in-browser is driven by the SDK, not the <audio> element.
        currentTrack?.id.startsWith('spotify:')
        ? !!spotifyWeb.playback && !spotifyWeb.playback.paused
        : audio.isPlaying
      : deviceIsPlaying;

  useMediaSession({
    currentTrack,
    selectedDeviceId,
    isPlaying,
    browserAudioIsPlaying: audio.isPlaying,
    isBrowserAudioPaused: audio.isPaused,
    resumeBrowserAudio: audio.resume,
    pause: devicePause,
    resume: deviceResume,
    playPrevious,
    playNext,
  });

  const volume = selectedDeviceId === 'browser' ? audio.volume : (deviceVolume ?? audio.volume);

  // Socket progress events update this provider frequently. A memoized context
  // value prevents consumers that do not read progress from re-rendering when
  // none of their observable playback state changed.
  const contextValue = useMemo<AudioContextValue>(
    () => ({
      currentTrack,
      isPlaying,
      isLoading,
      volume,
      queue,
      queueIndex,
      shuffle,
      repeat,
      crossfade,
      setCrossfade,
      replayGainMode,
      setReplayGainMode,
      replayGainPreamp,
      setReplayGainPreamp,
      selectedDeviceId,
      playTrack,
      playAlbum,
      addToQueue,
      clearQueue,
      removeFromQueue,
      moveInQueue,
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
    }),
    [
      currentTrack,
      isPlaying,
      isLoading,
      volume,
      queue,
      queueIndex,
      shuffle,
      repeat,
      crossfade,
      setCrossfade,
      replayGainMode,
      setReplayGainMode,
      replayGainPreamp,
      setReplayGainPreamp,
      selectedDeviceId,
      playTrack,
      playAlbum,
      addToQueue,
      clearQueue,
      removeFromQueue,
      moveInQueue,
      playNext,
      playPrevious,
      devicePause,
      deviceResume,
      deviceStop,
      deviceSetVolume,
      audio.seek,
      setSelectedDeviceId,
      toggleShuffle,
      toggleRepeat,
    ],
  );

  return <AudioCtx.Provider value={contextValue}>{children}</AudioCtx.Provider>;
}

export function useAudioContext() {
  const ctx = useContext(AudioCtx);
  if (!ctx) throw new Error('useAudioContext must be used within AudioProvider');
  return ctx;
}

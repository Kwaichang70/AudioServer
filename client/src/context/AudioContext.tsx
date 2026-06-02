import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useAudio } from '../hooks/useAudio.js';
import { useSocket } from '../hooks/useSocket.js';
import { api } from '../api/client.js';
import { useToast } from '../components/Toast.js';
import { setProgress } from './ProgressStore.js';
import { DEVICE_POLL_INTERVAL, SPOTIFY_CONNECT_RECEIVER_NAME, STORAGE_KEYS } from '../constants.js';

// Re-export so consumers can keep importing from this module.
export { useProgress } from './ProgressStore.js';

export interface TrackInfo {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  format?: string;
  sampleRate?: number;
  bitDepth?: number;
  source?: string;
  // Optional ReplayGain tags (dB + 0..1 peak ratio). Backend returns these
  // from /library/tracks/:id and /library/albums/:id. If the file has no RG
  // metadata they're undefined and the player falls back to preamp-only.
  replayGainTrack?: number | null;
  replayGainTrackPeak?: number | null;
  replayGainAlbum?: number | null;
  replayGainAlbumPeak?: number | null;
}

export type ReplayGainMode = 'off' | 'track' | 'album';

interface HealthResponse {
  lanAddress?: string;
}

interface DeviceStatusResponse {
  data?: {
    state?: 'playing' | 'paused' | 'stopped';
    position?: number;
    duration?: number;
    volume?: number;
  };
}

interface SpotifyConnectDevice {
  id: string;
  name: string;
}

interface OutputDeviceSummary {
  id: string;
  name: string;
}

interface WakeLockSentinelLike {
  release?: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
}

interface WakeLockCapability {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  };
}

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
  const [currentTrack, setCurrentTrack] = useState<TrackInfo | null>(null);
  const [queue, setQueue] = useState<TrackInfo[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState(
    () => localStorage.getItem(STORAGE_KEYS.selectedDevice) || 'browser',
  );

  const setSelectedDeviceId = (id: string) => {
    setSelectedDeviceIdState(id);
    localStorage.setItem(STORAGE_KEYS.selectedDevice, id);
  };
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
  const [devicePosition, setDevicePosition] = useState(0);
  const [deviceDuration, setDeviceDuration] = useState(0);
  const [deviceIsPlaying, setDeviceIsPlaying] = useState(false);
  const [deviceVolume, setDeviceVolume] = useState<number | null>(null);
  const { toast } = useToast();

  // Use refs so callbacks always see the latest values
  const selectedDeviceRef = useRef(selectedDeviceId);
  selectedDeviceRef.current = selectedDeviceId;
  const currentTrackRef = useRef(currentTrack);
  currentTrackRef.current = currentTrack;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const lanAddressRef = useRef<string | null>(null);

  const fallbackToBrowserPlayback = useCallback(
    (streamUrl: string, reason: string) => {
      selectedDeviceRef.current = 'browser';
      setSelectedDeviceIdState('browser');
      localStorage.setItem(STORAGE_KEYS.selectedDevice, 'browser');
      setDevicePosition(0);
      setDeviceDuration(0);
      setDeviceIsPlaying(false);
      setDeviceVolume(null);
      audio.play(streamUrl);
      setIsLoading(false);
      toastRef.current(`${reason}; switched to browser playback`, 'info');
    },
    [audio],
  );

  useEffect(() => {
    api
      .getHealth()
      .then((d: HealthResponse) => {
        if (d.lanAddress) lanAddressRef.current = d.lanAddress;
      })
      .catch(() => {});
  }, []);

  // Subscribe to device updates via WebSocket (replaces client-side polling)
  useEffect(() => {
    if (selectedDeviceId === 'browser') {
      socket.unsubscribeDevice(selectedDeviceId);
      setDevicePosition(0);
      setDeviceDuration(0);
      setDeviceIsPlaying(false);
      setDeviceVolume(null);
      return;
    }
    socket.subscribeDevice(selectedDeviceId);
    // Fetch initial device status (volume etc.) so the slider reflects reality
    api
      .getDeviceStatus(selectedDeviceId)
      .then((res: DeviceStatusResponse) => {
        if (typeof res?.data?.volume === 'number') {
          setDeviceVolume(res.data.volume / 100);
        }
      })
      .catch(() => {});
    return () => socket.unsubscribeDevice(selectedDeviceId);
  }, [selectedDeviceId]);

  // Process WebSocket device updates. Queue advancement is decided server-side
  // by PlaybackService and delivered as playback:track-changed.
  useEffect(() => {
    if (!socket.deviceUpdate || socket.deviceUpdate.deviceId !== selectedDeviceRef.current) return;

    const u = socket.deviceUpdate;
    setDevicePosition(u.position);
    setDeviceDuration(u.duration);
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
    if (currentTrack.id.startsWith('spotify:')) return;

    const poll = setInterval(() => {
      api
        .getDeviceStatus(selectedDeviceId)
        .then((res) => {
          const pos = res.data.position || 0;
          const dur = res.data.duration || 0;
          setDevicePosition(pos);
          setDeviceDuration(dur);
          setDeviceIsPlaying(res.data.state === 'playing');
          setProgress(pos, dur);
        })
        .catch(() => {});
    }, DEVICE_POLL_INTERVAL);

    return () => clearInterval(poll);
  }, [socket.connected, currentTrack, selectedDeviceId]);

  const startTrack = useCallback(
    (track: TrackInfo) => {
      setCurrentTrack(track);
      setIsLoading(true);

      // Push the new track's RG data into the player. Mode/preamp are already
      // set globally via the Settings UI; here we update the per-track values
      // so the next play() picks the right gain.
      audio.setReplayGain({
        data: {
          trackGain: track.replayGainTrack ?? null,
          trackPeak: track.replayGainTrackPeak ?? null,
          albumGain: track.replayGainAlbum ?? null,
          albumPeak: track.replayGainAlbumPeak ?? null,
        },
      });

      const deviceId = selectedDeviceRef.current;
      const isSpotify = track.id.startsWith('spotify:');
      const isQobuz = track.id.startsWith('qobuz:');

      console.log(
        `[AudioServer] Playing "${track.title}" on device: ${deviceId}, spotify: ${isSpotify}`,
      );

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
                  const audioServerDevice = ((devRes.data || []) as SpotifyConnectDevice[]).find(
                    (d) => d.name === SPOTIFY_CONNECT_RECEIVER_NAME,
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

              // Strategy 2: Try matching selected AudioServer device with a Spotify Connect device
              const devRes = await api.spotifyConnectDevices();
              const connectDevices = (devRes.data || []) as SpotifyConnectDevice[];
              // Get the selected device name from cached devices
              const selectedDevice = await api
                .getDevices()
                .then((r: { data?: OutputDeviceSummary[] }) =>
                  r.data?.find((d) => d.id === deviceId),
                )
                .catch(() => null);
              const selectedName = selectedDevice?.name?.toLowerCase() || '';
              // Match by checking if Spotify device name overlaps with selected device name
              const match = connectDevices.find((d) => {
                const cName = d.name.toLowerCase();
                // Match if any word from the device name appears in Spotify Connect device name
                const words = selectedName.split(/[\s\-_]+/).filter((w: string) => w.length > 2);
                return words.some((w: string) => cName.includes(w));
              });
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
            if (
              msg.includes('404') ||
              msg.includes('No active device') ||
              msg.includes('NO_ACTIVE_DEVICE')
            ) {
              toastRef.current(
                'Open Spotify on a device first, or start Librespot in Settings',
                'error',
              );
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
            const data = await api.getQobuzStreamUrl(qobuzId);
            if (!data.data?.url) {
              throw new Error('No stream URL from Qobuz');
            }
            const qobuzStreamUrl = data.data.url;

            if (deviceId === 'browser') {
              audio.play(qobuzStreamUrl);
            } else {
              // Send Qobuz CDN URL directly to DLNA/Volumio (no proxy needed)
              try {
                await api.devicePlay(deviceId, qobuzStreamUrl, {
                  title: track.title,
                  artist: track.artistName,
                  album: track.albumTitle,
                  duration: track.duration,
                });
              } catch (deviceErr) {
                console.error('Qobuz device play failed:', deviceErr);
                fallbackToBrowserPlayback(qobuzStreamUrl, 'External device failed');
                return;
              }
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

      const isRadio = track.id.startsWith('radio:');

      if (isRadio) {
        const uuid = track.id.slice('radio:'.length);
        (async () => {
          try {
            const res = await api.getRadioStream(uuid);
            const streamUrl = res.data?.url;
            if (!streamUrl) throw new Error('No stream URL for station');

            if (deviceId === 'browser') {
              audio.play(streamUrl);
            } else {
              try {
                await api.devicePlay(deviceId, streamUrl, {
                  title: track.title,
                  artist: 'Live Radio',
                  album: track.albumTitle,
                  // no duration — livestream
                });
              } catch (deviceErr) {
                console.error('Radio device play failed:', deviceErr);
                fallbackToBrowserPlayback(streamUrl, 'External device failed');
                return;
              }
            }
            setIsLoading(false);
            toastRef.current(`Tuned in: ${track.title}`, 'success');
          } catch (err) {
            setIsLoading(false);
            setCurrentTrack(null);
            toastRef.current(`Radio: ${(err as Error).message || err}`, 'error');
          }
        })();
        return;
      }

      const isTidal = track.id.startsWith('tidal:');

      if (isTidal) {
        setIsLoading(false);
        setCurrentTrack(null);
        toastRef.current(
          'Tidal full-track playback is disabled. Use Qobuz or local NAS playback for full tracks.',
          'error',
        );
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

        api
          .devicePlay(
            deviceId,
            absoluteUrl,
            {
              title: track.title,
              artist: track.artistName,
              album: track.albumTitle,
              duration: track.duration,
            },
            track.id,
          )
          .then(() => {
            setIsLoading(false);
            toastRef.current(`Playing on external device`, 'success');
          })
          .catch((err) => {
            console.error('Device play failed:', err);
            fallbackToBrowserPlayback(streamUrl, 'External device failed');
          });
      }

      // Record in history (only reached for local tracks; all streaming
      // providers return earlier in this function)
      api.play(track, deviceId).catch(() => {});
      api.recordPlay(track.id, track.albumId || '', '').catch(() => {});
    },
    [audio, fallbackToBrowserPlayback],
  );

  const playTrack = useCallback(
    (track: TrackInfo) => {
      // Always seed a queue so shuffle/repeat/next/prev have something to act on.
      setQueue([track]);
      setQueueIndex(0);
      startTrack(track);
    },
    [startTrack],
  );

  useEffect(() => {
    if (!socket.trackChanged) return;

    const nextTrack = socket.trackChanged;
    const nextIndex = queue.findIndex((track) => track.id === nextTrack.id);
    if (nextIndex >= 0) setQueueIndex(nextIndex);
    startTrack(nextTrack);
  }, [socket.trackChanged, queue, startTrack]);

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
      if (index === curr) return curr; // track shifts, same index plays next
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

      if (deviceId === 'browser' && !isSpotify) {
        audio.setVolume(v);
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
    setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));
  }, []);

  // Auto-advance to next track when current ends
  audio.setOnEnded(playNext);

  // --- Keep browser playback alive when the laptop locks / display sleeps ---
  // Strategy:
  //  1. Request a Screen Wake Lock while playing in the browser (prevents
  //     the display from sleeping, which on many laptops triggers media pause).
  //  2. Register Media Session action handlers so the OS media keys /
  //     lock-screen controls hook into our transport and do not detach audio.
  //  3. When the tab becomes visible again, re-acquire the wake lock and
  //     resume playback if the UI state says we should be playing but the
  //     underlying <audio> element got paused by the OS.
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const browserIsPlaying = selectedDeviceId === 'browser' && audio.isPlaying;

  useEffect(() => {
    const nav = navigator as Navigator & WakeLockCapability;
    const requestWakeLock = async () => {
      if (!browserIsPlaying) return;
      try {
        if (nav.wakeLock && !wakeLockRef.current) {
          wakeLockRef.current = await nav.wakeLock.request('screen');
          wakeLockRef.current.addEventListener?.('release', () => {
            wakeLockRef.current = null;
          });
        }
      } catch {
        // Wake lock unsupported or denied — ignore.
      }
    };
    const releaseWakeLock = async () => {
      try {
        await wakeLockRef.current?.release?.();
      } catch {}
      wakeLockRef.current = null;
    };

    if (browserIsPlaying) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Re-acquire wake lock (it auto-releases on hidden).
        if (browserIsPlaying) requestWakeLock();
        // If we think we're playing but the audio element got paused by
        // the OS while the tab was hidden, resume it.
        if (
          selectedDeviceRef.current === 'browser' &&
          currentTrackRef.current &&
          !audio.isPlaying
        ) {
          audio.resume();
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      releaseWakeLock();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserIsPlaying]);

  // Media Session API: hand playback transport to the OS so it doesn't
  // try to pause/detach audio on lock screen.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (currentTrack) {
      try {
        ms.metadata = new MediaMetadata({
          title: currentTrack.title,
          artist: currentTrack.artistName,
          album: currentTrack.albumTitle,
          artwork: currentTrack.albumId
            ? [
                {
                  src: api.getAlbumCoverUrl(currentTrack.albumId),
                  sizes: '512x512',
                  type: 'image/jpeg',
                },
              ]
            : [],
        });
      } catch {}
      ms.setActionHandler?.('play', () => deviceResume());
      ms.setActionHandler?.('pause', () => devicePause());
      ms.setActionHandler?.('previoustrack', () => playPrevious());
      ms.setActionHandler?.('nexttrack', () => playNext());
      ms.playbackState = (selectedDeviceId === 'browser' ? audio.isPlaying : deviceIsPlaying)
        ? 'playing'
        : 'paused';
    } else {
      ms.metadata = null;
      ms.playbackState = 'none';
    }
  }, [
    currentTrack,
    audio.isPlaying,
    deviceIsPlaying,
    selectedDeviceId,
    devicePause,
    deviceResume,
    playNext,
    playPrevious,
  ]);

  return (
    <AudioCtx.Provider
      value={{
        currentTrack,
        isPlaying: selectedDeviceId === 'browser' ? audio.isPlaying : deviceIsPlaying,
        isLoading,
        volume: selectedDeviceId === 'browser' ? audio.volume : (deviceVolume ?? audio.volume),
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

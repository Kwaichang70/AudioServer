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
import { useSpotifyWebPlayback } from '../hooks/useSpotifyWebPlayback.js';
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
  // Spotify Web Playback SDK: only loaded once the user actually plays a
  // Spotify track in the browser (lazy — keeps the SDK script + token polling
  // off the table for users who never touch Spotify). Requires Premium + a
  // completed Spotify OAuth connection.
  const [spotifyWebWanted, setSpotifyWebWanted] = useState(false);
  const spotifyWeb = useSpotifyWebPlayback(spotifyWebWanted);
  const spotifyWebDeviceIdRef = useRef<string | null>(null);
  spotifyWebDeviceIdRef.current = spotifyWeb.deviceId;
  // Briefly cache the Spotify Connect device list. A single play tries two
  // strategies that each need the list, and auto-advancing an album fires a
  // play per track — without this we'd hit /me/player/devices several times in
  // a row and trip Spotify's rate limit (→ 429 → connect calls start failing).
  const connectDevicesCacheRef = useRef<{ at: number; devices: SpotifyConnectDevice[] } | null>(
    null,
  );
  const spotifyWebSetVolumeRef = useRef(spotifyWeb.setVolume);
  spotifyWebSetVolumeRef.current = spotifyWeb.setVolume;
  const spotifyWebPauseRef = useRef(spotifyWeb.pause);
  spotifyWebPauseRef.current = spotifyWeb.pause;
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
    if (selectedDeviceId === 'browser' || selectedDeviceId.startsWith('spotify-connect:')) {
      // Browser playback and Spotify Connect targets aren't backend-registered
      // DLNA devices — there's no device status to subscribe to.
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

  // Process WebSocket device updates. The server's playbackService queue isn't
  // synced from the client, so it can't auto-advance an external device on its
  // own — we detect track-end here and advance the client's queue (same
  // heuristic the server's device-monitor uses). Browser playback advances via
  // <audio>'s 'ended'; Spotify Connect has its own poll. Guarded to fire once.
  const lastDeviceUpdateRef = useRef<{ state: string; position: number; duration: number } | null>(
    null,
  );
  const deviceEndedGuardRef = useRef(false);
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

    const isExternalLocal =
      selectedDeviceRef.current !== 'browser' &&
      !selectedDeviceRef.current.startsWith('spotify-connect:') &&
      !currentTrackRef.current?.id.startsWith('spotify:');
    if (isExternalLocal) {
      const last = lastDeviceUpdateRef.current;
      const ended =
        last?.state === 'playing' &&
        u.state === 'stopped' &&
        ((last.duration > 0 && last.position >= last.duration - 2) || u.position === 0);
      if (ended && !deviceEndedGuardRef.current) {
        deviceEndedGuardRef.current = true;
        playNextRef.current();
      } else if (u.state === 'playing') {
        deviceEndedGuardRef.current = false;
      }
    }
    lastDeviceUpdateRef.current = { state: u.state, position: u.position, duration: u.duration };
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

      const rawDeviceId = selectedDeviceRef.current;
      const isSpotify = track.id.startsWith('spotify:');
      const isQobuz = track.id.startsWith('qobuz:');
      // A Spotify Connect target (Sonos, CocktailAudio, …) only accepts Spotify.
      // For any other source, route to the browser so the track still plays.
      const deviceId =
        rawDeviceId.startsWith('spotify-connect:') && !isSpotify ? 'browser' : rawDeviceId;

      console.log(
        `[AudioServer] Playing "${track.title}" on device: ${deviceId}, spotify: ${isSpotify}`,
      );

      // Stop whatever the previous track was using if the new track won't reuse
      // it. Without this, switching between a Spotify track (Web Playback SDK)
      // and a local/Qobuz/radio track leaves both streams playing at once — and
      // the transport then follows the new source, so the orphaned Spotify
      // stream can no longer be paused/stopped from the UI.
      const willUseSpotifyWeb = isSpotify && deviceId === 'browser';
      const willUseAudioElement = !isSpotify && deviceId === 'browser';
      if (!willUseSpotifyWeb) {
        spotifyWebPauseRef.current?.();
      }
      if (!willUseAudioElement) {
        audio.pause();
      }

      if (isSpotify) {
        const spotifyTrackUri = `spotify:track:${track.id.replace('spotify:', '')}`;

        // Fetch the Spotify Connect device list, reusing a recent result (≤15s)
        // so the two strategies below — and back-to-back track plays — don't
        // each re-query Spotify.
        const getConnectDevicesCached = async (): Promise<SpotifyConnectDevice[]> => {
          const cached = connectDevicesCacheRef.current;
          if (cached && Date.now() - cached.at < 15_000) return cached.devices;
          const res = await api.spotifyConnectDevices();
          const devices = (res.data || []) as SpotifyConnectDevice[];
          connectDevicesCacheRef.current = { at: Date.now(), devices };
          return devices;
        };

        const playSpotify = async () => {
          try {
            // Strategy: an explicit Spotify Connect device was picked in the
            // device selector (Sonos, CocktailAudio, …). Play straight to it via
            // the Web API — no fuzzy name-matching, no librespot needed.
            if (deviceId.startsWith('spotify-connect:')) {
              await api.spotifyConnectPlay(
                spotifyTrackUri,
                deviceId.slice('spotify-connect:'.length),
              );
              setIsLoading(false);
              toastRef.current('Speelt via Spotify Connect', 'success');
              return;
            }

            // Strategy 0: browser playback via the Web Playback SDK. Lazily kick
            // off SDK init the first time we need it; if its in-browser device
            // is already registered, play straight to it. Otherwise fall through
            // — an external active device handles this track and the SDK becomes
            // available for the next one.
            if (deviceId === 'browser') {
              setSpotifyWebWanted(true);
              const webId = spotifyWebDeviceIdRef.current;
              if (webId) {
                await api.spotifyConnectPlay(spotifyTrackUri, webId);
                setIsLoading(false);
                toastRef.current('Playing in browser via Spotify', 'success');
                return;
              }
            }

            // Strategy 1: If external device selected, try librespot (streams to any device)
            if (deviceId !== 'browser') {
              try {
                const lsStatus = await api.librespotStatus();
                if (lsStatus.data.isRunning) {
                  // Librespot is running — route through it
                  // First tell Spotify to play on the "AudioServer" librespot device
                  const audioServerDevice = (await getConnectDevicesCached()).find(
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
              const connectDevices = await getConnectDevicesCached();
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
  useEffect(() => {
    const pb = spotifyWeb.playback;
    const isSpotifyBrowser =
      selectedDeviceRef.current === 'browser' &&
      !!currentTrackRef.current?.id.startsWith('spotify:');
    if (!pb || !isSpotifyBrowser) return;

    setProgress(pb.position, pb.duration);

    // Track-end heuristic: we play single track URIs, so when one finishes the
    // SDK reports paused at position 0 with a known duration. Guard so we fire
    // playNext exactly once per track.
    const ended = pb.paused && pb.position === 0 && pb.duration > 0;
    if (ended && !spotifyEndedGuardRef.current) {
      spotifyEndedGuardRef.current = true;
      playNextRef.current();
    } else if (!ended && pb.position > 0) {
      spotifyEndedGuardRef.current = false;
    }
  }, [spotifyWeb.playback]);

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
          const st = res?.data as {
            is_playing?: boolean;
            progress_ms?: number;
            item?: { duration_ms?: number };
            device?: { volume_percent?: number };
          } | null;
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
        isPlaying:
          selectedDeviceId === 'browser'
            ? // Spotify-in-browser is driven by the SDK, not the <audio> element.
              currentTrack?.id.startsWith('spotify:')
              ? !!spotifyWeb.playback && !spotifyWeb.playback.paused
              : audio.isPlaying
            : deviceIsPlaying,
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

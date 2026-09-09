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
import { api, ApiError, getClientId, newCommandId, setActiveZone } from '../api/client.js';
import type { PlaybackQueueEntry, PlaybackSnapshot, ZoneOverview } from '../api/types.js';
import { useToast } from '../components/Toast.js';
import { getProgressSnapshot, setProgress } from './ProgressStore.js';
import { DEVICE_POLL_INTERVAL, PROGRESS_REPORT_INTERVAL, STORAGE_KEYS } from '../constants.js';
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
  /**
   * Play a list from `startIndex`. Clicking a song in an album or playlist
   * queues the whole list from there, so the music keeps going after that
   * song instead of stopping (the bug Danny hit on 9 Sept 2026).
   */
  playAlbum: (tracks: TrackInfo[], startIndex?: number) => void;
  /** Jump to a queue position and play it — without replacing the queue. */
  playQueueIndex: (index: number) => void;
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
  /** The rooms this server knows and the one this tab steers (V10). */
  zones: ZoneOverview[];
  zoneId: string | null;
  refreshZones: () => void;
}

const AudioCtx = createContext<AudioContextValue | null>(null);

// External local renderers (DLNA/Sonos, not the browser and not a Spotify
// Connect target). For these the SERVER streams local tracks itself
// (server/src/services/server-player.ts); this client only mirrors.
const isExternalLocalDevice = (deviceId: string) =>
  deviceId !== 'browser' && !deviceId.startsWith('spotify-connect:');
const isLocalTrack = (trackId: string) => !trackId.includes(':');

/** Server queue entry → the TrackInfo the player hooks work with. */
function entryToTrack(entry: PlaybackQueueEntry): TrackInfo {
  return {
    ...(entry.metadata as Partial<TrackInfo> | undefined),
    id: entry.trackId,
    itemId: entry.itemId,
    title: entry.trackTitle,
    artistName: entry.artistName,
    albumTitle: entry.albumTitle,
    albumId: entry.albumId,
    duration: entry.duration,
    source: entry.source,
  };
}

/** Client TrackInfo → the payload the server queue keeps (extras travel as metadata). */
function trackToPayload(track: TrackInfo) {
  const {
    id,
    itemId: _itemId,
    title,
    artistName,
    albumTitle,
    albumId,
    duration,
    source,
    ...metadata
  } = track;
  void _itemId;
  return { id, title, artistName, albumTitle, albumId, duration, source, metadata };
}

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
  // The queue is a MIRROR of the server's household session (V03): every
  // edit goes to the server, the response/socket snapshot is applied back.
  const [queue, setQueue] = useState<TrackInfo[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const revisionRef = useRef(0);
  const clientId = useMemo(() => getClientId(), []);
  const [selectedDeviceId, setSelectedDeviceIdState] = useState(
    () => localStorage.getItem(STORAGE_KEYS.selectedDevice) || 'browser',
  );

  const setSelectedDeviceId = useCallback((id: string) => {
    setSelectedDeviceIdState(id);
    localStorage.setItem(STORAGE_KEYS.selectedDevice, id);
  }, []);

  // Zones (V10): a room owns one output device, so the chosen device decides
  // which room this tab steers. Every request carries it and only that room's
  // events are applied — pressing pause here can never touch another room.
  const [zoneList, setZoneList] = useState<ZoneOverview[]>([]);
  const refreshZones = useCallback(() => {
    api
      .getZones()
      .then((res) => setZoneList(Array.isArray(res.data) ? res.data : []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    refreshZones();
  }, [refreshZones, socket.zones]);
  const zoneId = useMemo(
    () => zoneList.find((z) => z.deviceId === selectedDeviceId)?.id ?? null,
    [zoneList, selectedDeviceId],
  );
  useEffect(() => {
    setActiveZone(zoneId);
    socket.setZoneFilter(zoneId);
  }, [zoneId, socket]);
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

  // ─── Server session mirror ─────────────────────────────────────

  const applySnapshot = useCallback((snapshot: PlaybackSnapshot, mirrorTrack = false) => {
    if (snapshot.revision < revisionRef.current) return; // older than what we have
    revisionRef.current = snapshot.revision;
    setQueue(snapshot.queue.map(entryToTrack));
    setQueueIndex(snapshot.queueIndex);
    setShuffle(snapshot.shuffle);
    setRepeat(snapshot.repeat);
    // A device that plays on its own (DLNA/Sonos/Connect) is worth showing
    // even if this tab did not start it; the browser output is per tab.
    if (mirrorTrack && snapshot.state.track && snapshot.state.deviceId !== 'browser') {
      const entry = snapshot.queue.find((e) => e.itemId === snapshot.currentItemId);
      const track = entry ? entryToTrack(entry) : (snapshot.state.track as TrackInfo);
      setCurrentTrack((prev) => (prev?.id === track.id ? prev : track));
    }
  }, []);
  const applySnapshotRef = useRef(applySnapshot);
  applySnapshotRef.current = applySnapshot;

  // Initial load + every socket (re)connect: full snapshot.
  useEffect(() => {
    api
      .getPlaybackSession()
      .then((res) => applySnapshotRef.current(res.data, true))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (socket.snapshot) applySnapshotRef.current(socket.snapshot, true);
  }, [socket.snapshot]);

  // Queue edits made anywhere (this tab, another tab, the server).
  useEffect(() => {
    const ev = socket.queueEvent;
    if (!ev || ev.revision < revisionRef.current) return;
    revisionRef.current = ev.revision;
    setQueue(ev.queue.map(entryToTrack));
    setQueueIndex(ev.queueIndex);
    setShuffle(ev.shuffle);
    setRepeat(ev.repeat);
  }, [socket.queueEvent]);

  /**
   * A command failed: on a stale revision the server sent the fresh snapshot,
   * apply it and tell the user; otherwise re-sync from the server.
   */
  const recoverFromCommandError = useCallback((err: unknown, what: string) => {
    const apiErr =
      err instanceof ApiError || (err as ApiError | null)?.name === 'ApiError'
        ? (err as ApiError)
        : null;
    if (apiErr?.isStaleRevision && apiErr.data) {
      applySnapshotRef.current(apiErr.data as PlaybackSnapshot);
      toastRef.current('Queue changed on another device; showing the latest', 'info');
      return;
    }
    if (apiErr?.statusCode === 404 && apiErr.data) {
      applySnapshotRef.current(apiErr.data as PlaybackSnapshot);
      toastRef.current(`${what}: that item is no longer in the queue`, 'info');
      return;
    }
    api
      .getPlaybackSession()
      .then((res) => applySnapshotRef.current(res.data))
      .catch(() => {});
  }, []);

  /**
   * After a play-type command the snapshot names the current item. Local
   * tracks on a server-managed device were already streamed by the server;
   * everything else (browser, Spotify Connect, provider tracks) this tab
   * starts itself.
   */
  const startFromSnapshot = useCallback(
    (snapshot: PlaybackSnapshot, fallback?: TrackInfo) => {
      const entry = snapshot.queue.find((e) => e.itemId === snapshot.currentItemId);
      const track = entry
        ? { ...(fallback?.id === entry.trackId ? fallback : {}), ...entryToTrack(entry) }
        : fallback;
      if (!track) return;
      const deviceId = selectedDeviceRef.current;
      if (isExternalLocalDevice(deviceId) && isLocalTrack(track.id)) {
        setCurrentTrack(track);
        setIsLoading(false);
        return;
      }
      startTrack(track);
    },
    [startTrack],
  );

  /** Replace the household queue with `tracks` and start `startIndex`. */
  const playTracks = useCallback(
    (tracks: TrackInfo[], startIndex: number) => {
      if (tracks.length === 0) return;
      const deviceId = selectedDeviceRef.current;
      // Optimistic local mirror so the UI reacts before the round trip.
      setQueue(tracks);
      setQueueIndex(startIndex);
      setCurrentTrack(tracks[startIndex]);
      setIsLoading(true);
      api
        .setServerQueue(tracks.map(trackToPayload), startIndex, deviceId, shuffle, repeat, {
          commandId: newCommandId(),
        })
        .then((res) => {
          applySnapshotRef.current(res.data);
          startFromSnapshot(res.data, tracks[startIndex]);
        })
        .catch((err) => {
          // Server unreachable: still play locally so the user is not stuck,
          // the queue will re-sync on the next snapshot.
          toastRef.current(
            `Could not hand the queue to the server (${err instanceof Error ? err.message : err})`,
            'error',
          );
          startTrack(tracks[startIndex]);
        });
    },
    [shuffle, repeat, startFromSnapshot, startTrack],
  );

  const playTrack = useCallback((track: TrackInfo) => playTracks([track], 0), [playTracks]);

  const playAlbum = useCallback(
    (tracks: TrackInfo[], startIndex = 0) =>
      playTracks(tracks, Math.max(0, Math.min(startIndex, tracks.length - 1))),
    [playTracks],
  );

  // Play a specific position in the EXISTING queue (QueuePage taps). playTrack
  // would replace the whole queue with just that track.
  const playQueueIndex = useCallback(
    (index: number) => {
      const track = queueRef.current[index];
      if (!track) return;
      setQueueIndex(index);
      if (!track.itemId) {
        startTrack(track);
        return;
      }
      setIsLoading(true);
      api
        .playQueueItem(track.itemId, selectedDeviceRef.current)
        .then((res) => {
          applySnapshotRef.current(res.data);
          startFromSnapshot(res.data, track);
        })
        .catch((err) => {
          setIsLoading(false);
          recoverFromCommandError(err, 'Play');
        });
    },
    [startTrack, startFromSnapshot, recoverFromCommandError],
  );

  const addToQueue = useCallback(
    (track: TrackInfo) => {
      setQueue((q) => [...q, track]);
      api
        .addToQueue(trackToPayload(track), { commandId: newCommandId() })
        .then((res) => applySnapshotRef.current(res.data))
        .catch((err) => recoverFromCommandError(err, 'Add to queue'));
    },
    [recoverFromCommandError],
  );

  const clearQueue = useCallback(() => {
    setQueue([]);
    setQueueIndex(-1);
    api
      .clearQueue({ commandId: newCommandId() })
      .then((res) => applySnapshotRef.current(res.data))
      .catch((err) => recoverFromCommandError(err, 'Clear queue'));
  }, [recoverFromCommandError]);

  const removeFromQueue = useCallback(
    (index: number) => {
      const item = queueRef.current[index];
      if (!item) return;
      const expectedRevision = revisionRef.current;
      setQueue((q) => {
        const newQueue = [...q];
        newQueue.splice(index, 1);
        return newQueue;
      });
      setQueueIndex((curr) => {
        if (index < curr) return curr - 1;
        // The removed track can keep playing until it ends. Point just before
        // its former successor so the next advance lands on that successor.
        if (index === curr) return curr - 1;
        return curr;
      });
      if (!item.itemId) return;
      api
        .removeFromQueue(item.itemId, { expectedRevision, commandId: newCommandId() })
        .then((res) => applySnapshotRef.current(res.data))
        .catch((err) => recoverFromCommandError(err, 'Remove'));
    },
    [recoverFromCommandError],
  );

  const moveInQueue = useCallback(
    (from: number, to: number) => {
      const item = queueRef.current[from];
      if (!item || from === to) return;
      const expectedRevision = revisionRef.current;
      setQueue((q) => {
        const newQueue = [...q];
        const [moved] = newQueue.splice(from, 1);
        newQueue.splice(to, 0, moved);
        return newQueue;
      });
      setQueueIndex((curr) => {
        if (curr === from) return to;
        if (from < curr && to >= curr) return curr - 1;
        if (from > curr && to <= curr) return curr + 1;
        return curr;
      });
      if (!item.itemId) return;
      api
        .moveInQueue(item.itemId, to, { expectedRevision, commandId: newCommandId() })
        .then((res) => applySnapshotRef.current(res.data))
        .catch((err) => recoverFromCommandError(err, 'Move'));
    },
    [recoverFromCommandError],
  );

  // "Next" is decided by the server (shuffle/repeat live there), so every
  // tab and the NAS agree on what comes after this track.
  const playNext = useCallback(() => {
    if (queueRef.current.length === 0 && repeat !== 'one') return;
    api
      .playbackNext({ commandId: newCommandId() })
      .then((res) => {
        applySnapshotRef.current(res.data);
        if (res.data.state.state === 'stopped' || !res.data.state.track) {
          // End of queue: nothing more to play on this tab.
          return;
        }
        startFromSnapshot(res.data);
      })
      .catch((err) => recoverFromCommandError(err, 'Next'));
  }, [repeat, startFromSnapshot, recoverFromCommandError]);

  // Track changes announced by the server (V03.3). Own commands were already
  // handled through their response; a change from another tab is mirrored
  // only (no audio starts here); a server-side advance on a device this tab
  // controls needs this tab only for provider tracks the NAS cannot stream.
  const handledTrackChangeRef = useRef<object | null>(null);
  useEffect(() => {
    const ev = socket.trackChanged;
    if (!ev || ev === handledTrackChangeRef.current) return;
    handledTrackChangeRef.current = ev;
    if (ev.revision > revisionRef.current) revisionRef.current = ev.revision;

    const idx = queueRef.current.findIndex((t) => t.itemId === ev.itemId);
    if (idx >= 0) setQueueIndex(idx);
    const track: TrackInfo = {
      ...(ev.track.metadata as Partial<TrackInfo> | undefined),
      ...ev.track,
      itemId: ev.itemId ?? undefined,
    };

    if (ev.origin.clientId === clientId) return; // our own command, already handled

    const mine = ev.deviceId === selectedDeviceRef.current;
    if (ev.origin.server && mine && isExternalLocalDevice(ev.deviceId)) {
      if (isLocalTrack(track.id)) {
        // The NAS already streamed it to the speaker: mirror only.
        setCurrentTrack((prev) => (prev?.id === track.id ? prev : track));
        setIsLoading(false);
      } else if (ev.controllerClientId === clientId) {
        // Provider track the NAS cannot serve; the controlling tab plays it.
        startTrack(track);
      }
      return;
    }
    // Another tab drives the session: show what plays on a shared device,
    // never start audio for someone else's browser tab.
    if (ev.deviceId !== 'browser') {
      setCurrentTrack((prev) => (prev?.id === track.id ? prev : track));
    }
  }, [socket.trackChanged, clientId, startTrack]);

  // Server-side dispatch status (V04.2): what the NAS is doing with the
  // current item on the speaker. Errors and skips are the user's business;
  // "loading"/"playing" only drive the spinner on this tab.
  const handledDispatchRef = useRef<object | null>(null);
  useEffect(() => {
    const d = socket.dispatch;
    if (!d || d === handledDispatchRef.current) return;
    handledDispatchRef.current = d;
    if (d.deviceId && d.deviceId !== selectedDeviceRef.current) return;
    if (d.state === 'loading') setIsLoading(true);
    if (d.state === 'playing' || d.state === 'idle' || d.state === 'client') setIsLoading(false);
    if (d.state === 'skipped') {
      setIsLoading(false);
      toastRef.current(`Skipped a track the NAS cannot play: ${d.message ?? d.code ?? ''}`, 'info');
    }
    if (d.state === 'error') {
      setIsLoading(false);
      toastRef.current(`Playback stopped: ${d.message ?? d.code ?? 'device error'}`, 'error');
    }
  }, [socket.dispatch]);

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
    if (queueRef.current.length === 0) return;
    if (audio.getCurrentTime() > 3) {
      audio.seek(0);
      return;
    }
    api
      .playbackPrevious({ commandId: newCommandId() })
      .then((res) => {
        applySnapshotRef.current(res.data);
        startFromSnapshot(res.data);
      })
      .catch((err) => recoverFromCommandError(err, 'Previous'));
  }, [audio, startFromSnapshot, recoverFromCommandError]);

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

  const toggleShuffle = useCallback(() => {
    const next = !shuffle;
    setShuffle(next);
    api.setShuffle(next).catch(() => {});
  }, [shuffle]);
  const toggleRepeat = useCallback(() => {
    const next = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    setRepeat(next);
    api.setRepeat(next).catch(() => {});
  }, [repeat]);

  // Keep the audio element subscribed to the latest queue handler. Registering
  // this during render is a side effect and can leak stale handlers under
  // StrictMode; the effect also clears the callback on unmount.
  useEffect(() => {
    audio.setOnEnded(playNext);
    return () => audio.setOnEnded(null);
  }, [audio, playNext]);

  // V08.3: a refused play() promise becomes a visible "press play" prompt,
  // never a playing state that is not true. The play button retries.
  useEffect(() => {
    if (!audio.playbackBlocked) return;
    toastRef.current(
      audio.playbackBlocked === 'autoplay'
        ? 'The browser blocked playback. Press play to start.'
        : 'This track could not be played in the browser. Press play to try again.',
      'info',
    );
  }, [audio.playbackBlocked]);

  const isPlaying =
    selectedDeviceId === 'browser'
      ? // Spotify-in-browser is driven by the SDK, not the <audio> element.
        currentTrack?.id.startsWith('spotify:')
        ? !!spotifyWeb.playback && !spotifyWeb.playback.paused
        : audio.isPlaying
      : deviceIsPlaying;

  // V05: while this browser plays audio itself, confirm it every few seconds.
  // The server credits listened time only between confirmations, so a closed
  // tab stops counting by itself; speakers the server drives are polled there.
  useEffect(() => {
    if (selectedDeviceId !== 'browser' || !isPlaying) return;
    const report = () => {
      const track = currentTrackRef.current;
      if (!track) return;
      api.reportProgress(track.itemId ?? null, getProgressSnapshot().currentTime).catch(() => {});
    };
    report();
    const timer = setInterval(report, PROGRESS_REPORT_INTERVAL);
    return () => clearInterval(timer);
  }, [selectedDeviceId, isPlaying, currentTrack?.itemId]);

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
      playQueueIndex,
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
      zones: zoneList,
      zoneId,
      refreshZones,
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
      playQueueIndex,
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
      zoneList,
      zoneId,
      refreshZones,
    ],
  );

  return <AudioCtx.Provider value={contextValue}>{children}</AudioCtx.Provider>;
}

export function useAudioContext() {
  const ctx = useContext(AudioCtx);
  if (!ctx) throw new Error('useAudioContext must be used within AudioProvider');
  return ctx;
}

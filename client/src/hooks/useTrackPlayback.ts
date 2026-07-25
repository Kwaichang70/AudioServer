import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api/client.js';
import { SPOTIFY_CONNECT_RECEIVER_NAME } from '../constants.js';
import type { TrackInfo } from '../types/playback.js';

export type PlaybackSource = 'local' | 'spotify' | 'qobuz' | 'radio' | 'tidal';

export interface TrackPlaybackController {
  startTrack: (track: TrackInfo) => void;
  cancelPendingPlayback: () => void;
}

interface SpotifyConnectDevice {
  id: string;
  name: string;
}

interface OutputDeviceSummary {
  id: string;
  name: string;
}

interface BrowserAudioController {
  play: (url: string) => void;
  pause: () => void;
  setReplayGain: (options: {
    data: {
      trackGain: number | null;
      trackPeak: number | null;
      albumGain: number | null;
      albumPeak: number | null;
    };
  }) => void;
}

type Toast = (text: string, type?: 'info' | 'error' | 'success') => void;

interface TrackPlaybackOptions {
  audio: BrowserAudioController;
  selectedDeviceId: string;
  spotifyWebDeviceId: string | null;
  pauseSpotifyWeb: () => void;
  setSelectedDeviceId: (deviceId: string) => void;
  setSpotifyWebWanted: Dispatch<SetStateAction<boolean>>;
  setCurrentTrack: Dispatch<SetStateAction<TrackInfo | null>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  fallbackToBrowserPlayback: (streamUrl: string, reason: string) => void;
  toast: Toast;
  /** Current play queue — used to decide album-context vs single-URI Spotify playback. */
  getQueue: () => TrackInfo[];
}

interface PlaybackContext extends TrackPlaybackOptions {
  track: TrackInfo;
  deviceId: string;
  isCurrent: () => boolean;
  getConnectDevices: () => Promise<SpotifyConnectDevice[]>;
  serverAddress: { lanAddress: string | null; port: number };
}

const SPOTIFY_CONNECT_PREFIX = 'spotify-connect:';
const CONNECT_DEVICE_CACHE_MS = 15_000;
const DEFAULT_SERVER_PORT = 3001;

export function getPlaybackSource(trackId: string): PlaybackSource {
  if (trackId.startsWith('spotify:')) return 'spotify';
  if (trackId.startsWith('qobuz:')) return 'qobuz';
  if (trackId.startsWith('radio:')) return 'radio';
  if (trackId.startsWith('tidal:')) return 'tidal';
  return 'local';
}

export function resolvePlaybackDevice(deviceId: string, source: PlaybackSource): string {
  return deviceId.startsWith(SPOTIFY_CONNECT_PREFIX) && source !== 'spotify' ? 'browser' : deviceId;
}

export function buildLanStreamUrl(
  streamUrl: string,
  lanAddress: string,
  port = DEFAULT_SERVER_PORT,
): string {
  return `http://${lanAddress}:${port}${streamUrl}`;
}

/** Routes tracks to the appropriate provider and output strategy. */
export function useTrackPlayback(options: TrackPlaybackOptions): TrackPlaybackController {
  const latestRef = useRef(options);
  latestRef.current = options;
  const connectDevicesCacheRef = useRef<{
    at: number;
    devices: SpotifyConnectDevice[];
  } | null>(null);
  const serverAddressRef = useRef<{ lanAddress: string | null; port: number }>({
    lanAddress: null,
    port: DEFAULT_SERVER_PORT,
  });
  const playbackGenerationRef = useRef(0);

  useEffect(() => {
    api
      .getHealth()
      .then((health) => {
        serverAddressRef.current = {
          lanAddress: health.lanAddress ?? null,
          port: health.port ?? DEFAULT_SERVER_PORT,
        };
      })
      .catch(() => {});
  }, []);

  useEffect(
    () => () => {
      playbackGenerationRef.current += 1;
    },
    [],
  );

  const startTrack = useCallback((track: TrackInfo) => {
    const generation = ++playbackGenerationRef.current;
    const isCurrent = () => playbackGenerationRef.current === generation;
    const current = latestRef.current;
    const source = getPlaybackSource(track.id);
    const deviceId = resolvePlaybackDevice(current.selectedDeviceId, source);
    if (deviceId !== current.selectedDeviceId) current.setSelectedDeviceId(deviceId);

    current.setCurrentTrack(track);
    current.setIsLoading(true);
    current.audio.setReplayGain({
      data: {
        trackGain: track.replayGainTrack ?? null,
        trackPeak: track.replayGainTrackPeak ?? null,
        albumGain: track.replayGainAlbum ?? null,
        albumPeak: track.replayGainAlbumPeak ?? null,
      },
    });

    console.log(`[AudioServer] Playing "${track.title}" on device: ${deviceId}, source: ${source}`);

    // Prevent the previous source from continuing in parallel after a provider
    // switch. Tidal is disabled, so it must not leave an older stream playing.
    const willUseSpotifyWeb = source === 'spotify' && deviceId === 'browser';
    const willUseAudioElement =
      (source === 'local' || source === 'qobuz' || source === 'radio') && deviceId === 'browser';
    if (!willUseSpotifyWeb) current.pauseSpotifyWeb();
    if (!willUseAudioElement) current.audio.pause();

    const getConnectDevices = async (): Promise<SpotifyConnectDevice[]> => {
      const cached = connectDevicesCacheRef.current;
      if (cached && Date.now() - cached.at < CONNECT_DEVICE_CACHE_MS) return cached.devices;
      const response = await api.spotifyConnectDevices();
      const devices = response.data;
      connectDevicesCacheRef.current = { at: Date.now(), devices };
      return devices;
    };

    const context: PlaybackContext = {
      ...current,
      track,
      deviceId,
      isCurrent,
      getConnectDevices,
      serverAddress: serverAddressRef.current,
    };

    switch (source) {
      case 'spotify':
        void playSpotifyTrack(context);
        break;
      case 'qobuz':
        void playQobuzTrack(context);
        break;
      case 'radio':
        void playRadioTrack(context);
        break;
      case 'tidal':
        rejectTidalTrack(context);
        break;
      case 'local':
        playLocalTrack(context);
        break;
    }
  }, []);

  const cancelPendingPlayback = useCallback(() => {
    playbackGenerationRef.current += 1;
  }, []);

  return { startTrack, cancelPendingPlayback };
}

async function playSpotifyTrack(context: PlaybackContext): Promise<void> {
  const {
    track,
    deviceId,
    spotifyWebDeviceId,
    setSpotifyWebWanted,
    setIsLoading,
    setCurrentTrack,
    toast,
    getConnectDevices,
    isCurrent,
  } = context;
  const spotifyTrackUri = `spotify:track:${track.id.slice('spotify:'.length)}`;

  // Album-context playback: when the queue is (a slice of) one Spotify album,
  // hand Spotify the ALBUM URI with this track as the offset instead of a
  // single-track URI. The Connect device then advances tracks natively — the
  // album keeps playing even when this client goes to sleep. A hand-built
  // mixed queue still uses single-track URIs so our own queue stays in charge.
  const albumId = track.albumId;
  const queueTracks = context.getQueue();
  const albumContextEligible =
    !!albumId?.startsWith('spotify:') &&
    (queueTracks.length <= 1 ||
      queueTracks.every((item) => item.id.startsWith('spotify:') && item.albumId === albumId));
  const contextUri = albumContextEligible
    ? `spotify:album:${albumId!.slice('spotify:'.length)}`
    : null;
  const playOnConnect = (targetDeviceId?: string) =>
    contextUri
      ? api.spotifyConnectPlayContext(contextUri, targetDeviceId, spotifyTrackUri)
      : api.spotifyConnectPlay(spotifyTrackUri, targetDeviceId);
  const connectToast = contextUri
    ? 'Album speelt via Spotify Connect (speaker schakelt zelf door)'
    : 'Speelt via Spotify Connect';

  try {
    // An explicitly selected Spotify Connect target can be addressed directly.
    if (deviceId.startsWith(SPOTIFY_CONNECT_PREFIX)) {
      await playOnConnect(deviceId.slice(SPOTIFY_CONNECT_PREFIX.length));
      if (!isCurrent()) return;
      setIsLoading(false);
      toast(connectToast, 'success');
      return;
    }

    // Browser playback uses the lazily initialised Spotify Web Playback SDK.
    if (deviceId === 'browser') {
      setSpotifyWebWanted(true);
      if (spotifyWebDeviceId) {
        await api.spotifyConnectPlay(spotifyTrackUri, spotifyWebDeviceId);
        if (!isCurrent()) return;
        setIsLoading(false);
        toast('Playing in browser via Spotify', 'success');
        return;
      }
    }

    if (deviceId !== 'browser') {
      try {
        const librespotStatus = await api.librespotStatus();
        if (!isCurrent()) return;
        if (librespotStatus.data.isRunning) {
          const audioServerDevice = (await getConnectDevices()).find(
            (device) => device.name === SPOTIFY_CONNECT_RECEIVER_NAME,
          );
          if (!isCurrent()) return;
          if (audioServerDevice) {
            await api.spotifyConnectPlay(spotifyTrackUri, audioServerDevice.id);
            if (!isCurrent()) return;
            await api.librespotPlayToDevice(spotifyTrackUri, deviceId);
            if (!isCurrent()) return;
            setIsLoading(false);
            toast('Streaming Spotify via AudioServer to device', 'success');
            return;
          }
        }
      } catch {
        // Librespot is optional; continue with Spotify Connect matching.
      }

      const connectDevices = await getConnectDevices();
      if (!isCurrent()) return;
      const selectedDevice = await api
        .getDevices()
        .then((response: { data?: OutputDeviceSummary[] }) =>
          response.data?.find((device) => device.id === deviceId),
        )
        .catch(() => null);
      if (!isCurrent()) return;
      const selectedName = selectedDevice?.name?.toLowerCase() || '';
      const words = selectedName.split(/[\s\-_]+/).filter((word) => word.length > 2);
      const match = connectDevices.find((device) => {
        const connectName = device.name.toLowerCase();
        return words.some((word) => connectName.includes(word));
      });
      if (match) {
        await playOnConnect(match.id);
        if (!isCurrent()) return;
        setIsLoading(false);
        toast(`Playing via Spotify Connect on ${match.name}`, 'success');
        return;
      }
    }

    await playOnConnect();
    if (!isCurrent()) return;
    setIsLoading(false);
    toast(connectToast, 'success');
  } catch (error) {
    if (!isCurrent()) return;
    setIsLoading(false);
    setCurrentTrack(null);
    const message = String(error);
    if (
      message.includes('404') ||
      message.includes('No active device') ||
      message.includes('NO_ACTIVE_DEVICE')
    ) {
      toast('Open Spotify on a device first, or start Librespot in Settings', 'error');
    } else {
      toast(`Spotify: ${(error as Error).message || message}`, 'error');
    }
  }
}

async function playQobuzTrack(context: PlaybackContext): Promise<void> {
  const {
    track,
    deviceId,
    audio,
    setIsLoading,
    setCurrentTrack,
    fallbackToBrowserPlayback,
    toast,
    isCurrent,
  } = context;
  try {
    const response = await api.getQobuzStreamUrl(track.id.slice('qobuz:'.length));
    if (!isCurrent()) return;
    const streamUrl = response.data?.url;
    if (!streamUrl) throw new Error('No stream URL from Qobuz');

    if (deviceId === 'browser') {
      audio.play(streamUrl);
    } else {
      try {
        await api.devicePlay(deviceId, streamUrl, buildTrackMetadata(track));
        if (!isCurrent()) return;
      } catch (error) {
        if (!isCurrent()) return;
        console.error('Qobuz device play failed:', error);
        fallbackToBrowserPlayback(streamUrl, 'External device failed');
        return;
      }
    }
    setIsLoading(false);
    toast('Playing from Qobuz', 'success');
  } catch (error) {
    if (!isCurrent()) return;
    setIsLoading(false);
    setCurrentTrack(null);
    toast(`Qobuz: ${(error as Error).message || error}`, 'error');
  }
}

async function playRadioTrack(context: PlaybackContext): Promise<void> {
  const {
    track,
    deviceId,
    audio,
    setIsLoading,
    setCurrentTrack,
    fallbackToBrowserPlayback,
    toast,
    isCurrent,
  } = context;
  try {
    const response = await api.getRadioStream(track.id.slice('radio:'.length));
    if (!isCurrent()) return;
    const streamUrl = response.data?.url;
    if (!streamUrl) throw new Error('No stream URL for station');

    if (deviceId === 'browser') {
      audio.play(streamUrl);
    } else {
      try {
        await api.devicePlay(deviceId, streamUrl, {
          title: track.title,
          artist: 'Live Radio',
          album: track.albumTitle,
        });
        if (!isCurrent()) return;
      } catch (error) {
        if (!isCurrent()) return;
        console.error('Radio device play failed:', error);
        fallbackToBrowserPlayback(streamUrl, 'External device failed');
        return;
      }
    }
    setIsLoading(false);
    toast(`Tuned in: ${track.title}`, 'success');
  } catch (error) {
    if (!isCurrent()) return;
    setIsLoading(false);
    setCurrentTrack(null);
    toast(`Radio: ${(error as Error).message || error}`, 'error');
  }
}

function rejectTidalTrack(context: PlaybackContext): void {
  if (!context.isCurrent()) return;
  context.setIsLoading(false);
  context.setCurrentTrack(null);
  context.toast(
    'Tidal full-track playback is disabled. Use Qobuz or local NAS playback for full tracks.',
    'error',
  );
}

function playLocalTrack(context: PlaybackContext): void {
  const {
    track,
    deviceId,
    audio,
    serverAddress,
    setIsLoading,
    fallbackToBrowserPlayback,
    toast,
    isCurrent,
  } = context;
  const streamUrl = api.getStreamUrl(track.id);

  if (deviceId === 'browser') {
    audio.play(streamUrl);
    setIsLoading(false);
  } else {
    const host = serverAddress.lanAddress || window.location.hostname;
    const absoluteUrl = buildLanStreamUrl(streamUrl, host, serverAddress.port);
    console.log(`[AudioServer] Sending to device ${deviceId}: ${absoluteUrl}`);
    api
      .devicePlay(deviceId, absoluteUrl, buildTrackMetadata(track), track.id)
      .then(() => {
        if (!isCurrent()) return;
        setIsLoading(false);
        toast('Playing on external device', 'success');
      })
      .catch((error) => {
        if (!isCurrent()) return;
        console.error('Device play failed:', error);
        fallbackToBrowserPlayback(streamUrl, 'External device failed');
      });
  }

  api.play(track, deviceId).catch(() => {});
  api.recordPlay(track.id, track.albumId || '', '').catch(() => {});
}

function buildTrackMetadata(track: TrackInfo): Record<string, unknown> {
  return {
    title: track.title,
    artist: track.artistName,
    album: track.albumTitle,
    duration: track.duration,
  };
}

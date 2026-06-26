import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';

// Minimal typings for the slice of the Spotify Web Playback SDK we use. The SDK
// is loaded at runtime from sdk.scdn.co, so there's no npm package to import
// types from.
interface SpotifyPlaybackSnapshot {
  paused: boolean;
  position: number; // ms
  duration: number; // ms
  track_window?: { current_track?: { id?: string; uri?: string } };
}

interface SpotifyPlayer {
  connect(): Promise<boolean>;
  disconnect(): void;
  addListener(event: string, cb: (payload: unknown) => void): boolean;
  getCurrentState(): Promise<SpotifyPlaybackSnapshot | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  togglePlay(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(v: number): Promise<void>;
}

interface SpotifyNamespace {
  Player: new (opts: {
    name: string;
    getOAuthToken: (cb: (token: string) => void) => void;
    volume?: number;
  }) => SpotifyPlayer;
}

declare global {
  interface Window {
    Spotify?: SpotifyNamespace;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

const SDK_SRC = 'https://sdk.scdn.co/spotify-player.js';
const PLAYER_NAME = 'AudioServer Web';

/** Live playback snapshot from the SDK, or null when nothing is loaded. */
export interface SpotifyPlaybackInfo {
  paused: boolean;
  /** Current position in seconds (interpolated between SDK state events). */
  position: number;
  /** Track length in seconds. */
  duration: number;
  trackId: string | null;
}

export interface SpotifyWebPlaybackState {
  /** Spotify device id of the in-browser player, once registered. */
  deviceId: string | null;
  ready: boolean;
  /** Set when the SDK can't initialise — usually "not Premium" or auth failure. */
  error: string | null;
  /** Live playback state, driven by player_state_changed + a 1s position poll. */
  playback: SpotifyPlaybackInfo | null;
  /**
   * Set the in-browser player's output volume (0..1) locally via the SDK.
   * No network call — safe to fire on every volume-slider tick (unlike the
   * Web API's /me/player/volume, which is rate-limited).
   */
  setVolume: (v: number) => void;
}

/**
 * Loads the Spotify Web Playback SDK and registers an in-browser player as a
 * Spotify Connect device. Returns its device id so the caller can target it
 * via the Web API (api.spotifyConnectPlay(uri, deviceId)).
 *
 * Hard requirements (Spotify's, not ours):
 *   - The account must be Spotify **Premium** — the SDK refuses to init otherwise.
 *   - Spotify OAuth must be connected so /providers/spotify/token returns a
 *     token carrying the `streaming` scope.
 *
 * `enabled` lets the caller defer all of this (no SDK script, no network) until
 * Spotify is actually connected — passing `false` keeps the hook inert.
 */
export function useSpotifyWebPlayback(enabled: boolean): SpotifyWebPlaybackState {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playback, setPlayback] = useState<SpotifyPlaybackInfo | null>(null);
  const playerRef = useRef<SpotifyPlayer | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | null = null;

    const applySnapshot = (s: SpotifyPlaybackSnapshot | null) => {
      if (cancelled) return;
      if (!s) {
        setPlayback(null);
        return;
      }
      setPlayback({
        paused: s.paused,
        position: s.position / 1000,
        duration: s.duration / 1000,
        trackId: s.track_window?.current_track?.id ?? null,
      });
    };

    const initPlayer = () => {
      if (cancelled || !window.Spotify) return;
      const player = new window.Spotify.Player({
        name: PLAYER_NAME,
        volume: 0.7,
        getOAuthToken: (cb) => {
          // The SDK calls this on connect and whenever it needs to refresh.
          api
            .spotifyToken()
            .then((res) => cb(res.data.accessToken))
            .catch((e) => setError(e instanceof Error ? e.message : 'Token fetch failed'));
        },
      });
      playerRef.current = player;

      player.addListener('ready', (payload) => {
        const { device_id } = payload as { device_id: string };
        if (!cancelled) {
          setDeviceId(device_id);
          setReady(true);
        }
      });
      player.addListener('not_ready', () => {
        if (!cancelled) setReady(false);
      });

      // player_state_changed fires on play/pause/seek/track-change — but NOT
      // continuously during playback. We take the snapshot here and, while
      // playing, poll getCurrentState() every second so the progress bar
      // advances smoothly.
      player.addListener('player_state_changed', (payload) => {
        applySnapshot(payload as SpotifyPlaybackSnapshot | null);
      });
      pollId = setInterval(() => {
        playerRef.current
          ?.getCurrentState()
          .then((s) => {
            if (s && !s.paused) applySnapshot(s);
          })
          .catch(() => {});
      }, 1000);
      // initialization_error fires for unsupported browsers; account_error for
      // non-Premium accounts; authentication_error for a bad/expired token.
      const onErr = (payload: unknown) => {
        const { message } = (payload as { message?: string }) ?? {};
        if (!cancelled) setError(message ?? 'Spotify player error');
      };
      player.addListener('initialization_error', onErr);
      player.addListener('authentication_error', onErr);
      player.addListener('account_error', onErr);

      player.connect();
    };

    // The SDK calls window.onSpotifyWebPlaybackSDKReady once the script loads.
    // If it's already present (e.g. hook re-mounted), init immediately.
    if (window.Spotify) {
      initPlayer();
    } else {
      window.onSpotifyWebPlaybackSDKReady = initPlayer;
      if (!document.querySelector(`script[src="${SDK_SRC}"]`)) {
        const script = document.createElement('script');
        script.src = SDK_SRC;
        script.async = true;
        script.onerror = () => {
          if (!cancelled) setError('Failed to load Spotify SDK');
        };
        document.body.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (pollId) clearInterval(pollId);
      playerRef.current?.disconnect();
      playerRef.current = null;
    };
  }, [enabled]);

  // Local volume control — stable identity (playerRef is a ref), so callers can
  // depend on it without re-creating their own callbacks.
  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    playerRef.current?.setVolume(clamped).catch(() => {});
  }, []);

  return { deviceId, ready, error, playback, setVolume };
}

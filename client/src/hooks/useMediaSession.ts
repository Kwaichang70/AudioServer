import { useEffect, useRef } from 'react';
import { api } from '../api/client.js';
import type { TrackInfo } from '../types/playback.js';
import { getProgressSnapshot, subscribeProgress } from '../context/ProgressStore.js';

interface WakeLockSentinelLike {
  release?: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
}

interface WakeLockCapability {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>;
  };
}

interface MediaSessionOptions {
  currentTrack: TrackInfo | null;
  selectedDeviceId: string;
  isPlaying: boolean;
  browserAudioIsPlaying: boolean;
  isBrowserAudioPaused: () => boolean;
  resumeBrowserAudio: () => void;
  pause: () => void;
  resume: () => void;
  playPrevious: () => void;
  playNext: () => void;
  /** Jump inside the current track; gives the lock screen its scrubber (C07). */
  seek?: (seconds: number) => void;
}

/**
 * Owns browser/OS media integration for the player: screen wake lock while
 * browser playback is active and Media Session metadata/transport handlers.
 */
export function useMediaSession({
  currentTrack,
  selectedDeviceId,
  isPlaying,
  browserAudioIsPlaying,
  isBrowserAudioPaused,
  resumeBrowserAudio,
  pause,
  resume,
  playPrevious,
  playNext,
  seek,
}: MediaSessionOptions): void {
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const latestRef = useRef({
    currentTrack,
    selectedDeviceId,
    isPlaying,
    browserAudioIsPlaying,
    isBrowserAudioPaused,
    resumeBrowserAudio,
  });
  latestRef.current = {
    currentTrack,
    selectedDeviceId,
    isPlaying,
    browserAudioIsPlaying,
    isBrowserAudioPaused,
    resumeBrowserAudio,
  };

  const browserPlaybackActive = selectedDeviceId === 'browser' && isPlaying;

  useEffect(() => {
    const nav = navigator as Navigator & WakeLockCapability;
    let cancelled = false;

    const releaseWakeLock = async () => {
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      try {
        await sentinel?.release?.();
      } catch {
        // A released or revoked lock is already in the desired state.
      }
    };

    const requestWakeLock = async () => {
      if (!browserPlaybackActive || !nav.wakeLock || wakeLockRef.current) return;
      try {
        const sentinel = await nav.wakeLock.request('screen');
        if (cancelled || !latestRef.current.isPlaying) {
          await sentinel.release?.();
          return;
        }
        wakeLockRef.current = sentinel;
        sentinel.addEventListener?.('release', () => {
          if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
        });
      } catch {
        // Wake lock unsupported or denied — playback continues without it.
      }
    };

    if (browserPlaybackActive) void requestWakeLock();
    else void releaseWakeLock();

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const latest = latestRef.current;
      if (latest.selectedDeviceId !== 'browser') return;

      if (latest.isPlaying) void requestWakeLock();
      // Preserve the existing recovery behavior for HTML-audio tracks. Spotify
      // browser playback is owned by the SDK and must not resume <audio>.
      if (
        latest.currentTrack &&
        !latest.currentTrack.id.startsWith('spotify:') &&
        latest.browserAudioIsPlaying &&
        latest.isBrowserAudioPaused()
      ) {
        latest.resumeBrowserAudio();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void releaseWakeLock();
    };
  }, [browserPlaybackActive]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const mediaSession = navigator.mediaSession;

    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Some browsers expose Media Session but reject unsupported actions.
      }
    };

    if (currentTrack) {
      try {
        mediaSession.metadata = new MediaMetadata({
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
      } catch {
        mediaSession.metadata = null;
      }
      setHandler('play', resume);
      setHandler('pause', pause);
      setHandler('previoustrack', playPrevious);
      setHandler('nexttrack', playNext);
      setHandler(
        'seekto',
        seek
          ? (details) => {
              if (typeof details.seekTime === 'number') seek(details.seekTime);
            }
          : null,
      );
      mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } else {
      mediaSession.metadata = null;
      mediaSession.playbackState = 'none';
    }

    return () => {
      setHandler('play', null);
      setHandler('pause', null);
      setHandler('previoustrack', null);
      setHandler('nexttrack', null);
      setHandler('seekto', null);
    };
  }, [currentTrack, isPlaying, pause, resume, playPrevious, playNext, seek]);

  // Where the track is, for the lock screen and the notification (C07).
  // The position ticks four times a second; the system only needs to hear
  // now and then, it counts on by itself while playing.
  const hasTrack = currentTrack !== null;
  useEffect(() => {
    if (!hasTrack || !('mediaSession' in navigator)) return;
    const mediaSession = navigator.mediaSession;
    if (typeof mediaSession.setPositionState !== 'function') return;
    let lastSent = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastSent < 2000) return;
      const { currentTime, duration } = getProgressSnapshot();
      if (!Number.isFinite(duration) || duration <= 0) return;
      lastSent = now;
      try {
        mediaSession.setPositionState({
          duration,
          position: Math.min(Math.max(currentTime, 0), duration),
          playbackRate: 1,
        });
      } catch {
        // A browser that rejects the values simply shows no scrubber.
      }
    };
    report(true);
    return subscribeProgress(() => report());
  }, [hasTrack, isPlaying]);
}

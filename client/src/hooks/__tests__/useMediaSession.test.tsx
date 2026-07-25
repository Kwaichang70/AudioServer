import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaSession } from '../useMediaSession.js';

vi.mock('../../api/client.js', () => ({
  api: { getAlbumCoverUrl: (id: string) => `/api/library/albums/${id}/cover` },
}));

const track = {
  id: 'track-1',
  title: 'Test Track',
  artistName: 'Test Artist',
  albumTitle: 'Test Album',
  albumId: 'album-1',
};

function removeNavigatorProperty(name: 'mediaSession' | 'wakeLock') {
  delete (navigator as Navigator & Record<string, unknown>)[name];
}

describe('useMediaSession', () => {
  beforeEach(() => {
    removeNavigatorProperty('mediaSession');
    removeNavigatorProperty('wakeLock');
  });

  afterEach(() => {
    removeNavigatorProperty('mediaSession');
    removeNavigatorProperty('wakeLock');
    Reflect.deleteProperty(document, 'visibilityState');
    vi.unstubAllGlobals();
  });

  it('publishes metadata, transport handlers, and playback state', () => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    const mediaSession = {
      metadata: null,
      playbackState: 'none',
      setActionHandler: vi.fn(
        (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
          handlers.set(action, handler);
        },
      ),
    };
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: mediaSession,
    });

    let metadataInit: MediaMetadataInit | undefined;
    vi.stubGlobal(
      'MediaMetadata',
      class FakeMediaMetadata {
        constructor(init: MediaMetadataInit) {
          metadataInit = init;
        }
      },
    );

    const pause = vi.fn();
    const resume = vi.fn();
    const playPrevious = vi.fn();
    const playNext = vi.fn();
    const view = renderHook(() =>
      useMediaSession({
        currentTrack: track,
        selectedDeviceId: 'browser',
        isPlaying: true,
        browserAudioIsPlaying: true,
        isBrowserAudioPaused: () => false,
        resumeBrowserAudio: vi.fn(),
        pause,
        resume,
        playPrevious,
        playNext,
      }),
    );

    expect(metadataInit).toEqual({
      title: 'Test Track',
      artist: 'Test Artist',
      album: 'Test Album',
      artwork: [
        {
          src: '/api/library/albums/album-1/cover',
          sizes: '512x512',
          type: 'image/jpeg',
        },
      ],
    });
    expect(mediaSession.playbackState).toBe('playing');

    handlers.get('pause')?.({ action: 'pause' });
    handlers.get('play')?.({ action: 'play' });
    handlers.get('previoustrack')?.({ action: 'previoustrack' });
    handlers.get('nexttrack')?.({ action: 'nexttrack' });
    expect(pause).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(playPrevious).toHaveBeenCalledOnce();
    expect(playNext).toHaveBeenCalledOnce();

    view.unmount();
    expect(handlers.get('play')).toBeNull();
    expect(handlers.get('pause')).toBeNull();
    expect(handlers.get('previoustrack')).toBeNull();
    expect(handlers.get('nexttrack')).toBeNull();
  });

  it('acquires and releases a screen wake lock for browser playback', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ release, addEventListener: vi.fn() });
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request },
    });

    const view = renderHook(() =>
      useMediaSession({
        currentTrack: track,
        selectedDeviceId: 'browser',
        isPlaying: true,
        browserAudioIsPlaying: true,
        isBrowserAudioPaused: () => false,
        resumeBrowserAudio: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        playPrevious: vi.fn(),
        playNext: vi.fn(),
      }),
    );

    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
    view.unmount();
    await waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it('resumes an intended HTML-audio track after an OS pause', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    const resumeBrowserAudio = vi.fn();
    renderHook(() =>
      useMediaSession({
        currentTrack: track,
        selectedDeviceId: 'browser',
        isPlaying: true,
        browserAudioIsPlaying: true,
        isBrowserAudioPaused: () => true,
        resumeBrowserAudio,
        pause: vi.fn(),
        resume: vi.fn(),
        playPrevious: vi.fn(),
        playNext: vi.fn(),
      }),
    );

    document.dispatchEvent(new Event('visibilitychange'));

    expect(resumeBrowserAudio).toHaveBeenCalledOnce();
  });
});

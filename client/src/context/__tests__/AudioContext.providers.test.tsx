import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackInfo } from '../AudioContext.js';
import { createFakePlaybackServer } from '../../test/fakePlaybackServer.js';

const mocks = vi.hoisted(() => {
  const audio = {
    isPlaying: false,
    volume: 0.7,
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setVolume: vi.fn(),
    seek: vi.fn(),
    setOnEnded: vi.fn(),
    preloadNext: vi.fn(),
    setCrossfadeDuration: vi.fn(),
    setReplayGain: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
    isPaused: vi.fn(() => false),
  };
  const api = {
    getHealth: vi.fn(() => Promise.resolve({})),
    getQobuzStreamUrl: vi.fn(),
    getTidalStreamUrl: vi.fn(),
    devicePlay: vi.fn(),
    getDevices: vi.fn(),
    getDeviceStatus: vi.fn(),
    getStreamUrl: vi.fn((id: string) => `/api/library/tracks/${id}/stream`),
    getAlbumCoverUrl: vi.fn((id: string) => `/api/library/albums/${id}/cover`),
    play: vi.fn(),
    reportProgress: vi.fn(() => Promise.resolve({ data: { accepted: true } })),
    stop: vi.fn(() => Promise.resolve({})),
  };
  return {
    audio,
    api,
    toast: vi.fn(),
    socket: {
      connected: true,
      deviceUpdate: null,
      snapshot: null,
      queueEvent: null,
      stateEvent: null,
      trackChanged: null,
      subscribeDevice: vi.fn(),
      unsubscribeDevice: vi.fn(),
      requestSync: vi.fn(),
      // Zones (V10): one room, the browser one.
      zones: [],
      setZoneFilter: vi.fn(),
    },
  };
});

// The queue itself lives on the (fake) server; the provider-specific api
// functions above are what these tests observe.
const fakeServer = createFakePlaybackServer();
class FakeApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string,
    public requestId?: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isStaleRevision() {
    return this.statusCode === 409 && this.code === 'StaleRevision';
  }
}

vi.mock('../../hooks/useAudio.js', () => ({ useAudio: () => mocks.audio }));
vi.mock('../../hooks/useSocket.js', () => ({ useSocket: () => mocks.socket }));
vi.mock('../../api/client.js', () => ({
  api: new Proxy(mocks.api, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      return fakeServer.api[prop as keyof typeof fakeServer.api];
    },
  }),
  ApiError: FakeApiError,
  getClientId: () => 'me',
  setActiveZone: vi.fn(),
  newCommandId: () => `cmd-${Math.random()}`,
}));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { AudioProvider, useAudioContext } = await import('../AudioContext.js');

function PlayButton({ track }: { track: TrackInfo }) {
  const { playTrack } = useAudioContext();
  return <button onClick={() => playTrack(track)}>Play</button>;
}

describe('AudioProvider streaming providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getHealth.mockResolvedValue({});
    mocks.api.devicePlay.mockResolvedValue({});
    mocks.api.getDeviceStatus.mockResolvedValue({ data: {} });
    localStorage.clear();
  });

  it('resolves a fresh Qobuz stream URL before browser playback', async () => {
    mocks.api.getQobuzStreamUrl.mockResolvedValue({
      data: { url: 'https://cdn.qobuz.test/track.flac', formatId: '6' },
    });

    render(
      <AudioProvider>
        <PlayButton
          track={{
            id: 'qobuz:123',
            title: 'Qobuz Track',
            artistName: 'Artist',
            albumTitle: 'Album',
          }}
        />
      </AudioProvider>,
    );

    screen.getByText('Play').click();

    await waitFor(() => expect(mocks.api.getQobuzStreamUrl).toHaveBeenCalledWith('123'));
    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('https://cdn.qobuz.test/track.flac'),
    );
  });

  it('does not attempt Tidal full-track playback', async () => {
    render(
      <AudioProvider>
        <PlayButton
          track={{
            id: 'tidal:123',
            title: 'Tidal Track',
            artistName: 'Artist',
            albumTitle: 'Album',
          }}
        />
      </AudioProvider>,
    );

    screen.getByText('Play').click();

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.stringContaining('Tidal full-track playback is disabled'),
        'error',
      ),
    );
    expect(mocks.api.getTidalStreamUrl).not.toHaveBeenCalled();
    expect(mocks.audio.play).not.toHaveBeenCalled();
  });

  it('falls back to browser playback when an external Qobuz device fails', async () => {
    localStorage.setItem('audioserver_device', 'device-1');
    mocks.api.getQobuzStreamUrl.mockResolvedValue({
      data: { url: 'https://cdn.qobuz.test/track.flac', formatId: '6' },
    });
    mocks.api.devicePlay.mockRejectedValue(new Error('Device rejected URI'));

    render(
      <AudioProvider>
        <PlayButton
          track={{
            id: 'qobuz:123',
            title: 'Qobuz Track',
            artistName: 'Artist',
            albumTitle: 'Album',
          }}
        />
      </AudioProvider>,
    );

    screen.getByText('Play').click();

    await waitFor(() =>
      expect(mocks.api.devicePlay).toHaveBeenCalledWith(
        'device-1',
        'https://cdn.qobuz.test/track.flac',
        {
          title: 'Qobuz Track',
          artist: 'Artist',
          album: 'Album',
          duration: undefined,
        },
      ),
    );
    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('https://cdn.qobuz.test/track.flac'),
    );
    expect(localStorage.getItem('audioserver_device')).toBe('browser');
    expect(mocks.toast).toHaveBeenCalledWith(
      'External device failed; switched to browser playback',
      'info',
    );
  });
});

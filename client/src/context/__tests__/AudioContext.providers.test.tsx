import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackInfo } from '../AudioContext.js';

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
    recordPlay: vi.fn(),
  };
  return {
    audio,
    api,
    toast: vi.fn(),
    socket: {
      connected: true,
      deviceUpdate: null,
      subscribeDevice: vi.fn(),
      unsubscribeDevice: vi.fn(),
    },
  };
});

vi.mock('../../hooks/useAudio.js', () => ({ useAudio: () => mocks.audio }));
vi.mock('../../hooks/useSocket.js', () => ({ useSocket: () => mocks.socket }));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));
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
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackInfo } from '../../types/playback.js';
import {
  buildLanStreamUrl,
  getPlaybackSource,
  resolvePlaybackDevice,
  useTrackPlayback,
} from '../useTrackPlayback.js';

const mocks = vi.hoisted(() => ({
  api: {
    getHealth: vi.fn(),
    getStreamUrl: vi.fn((id: string) => `/api/library/tracks/${id}/stream`),
    getQobuzStreamUrl: vi.fn(),
    getRadioStream: vi.fn(),
    devicePlay: vi.fn(),
    play: vi.fn(),
    recordPlay: vi.fn(),
    spotifyConnectDevices: vi.fn(),
    spotifyConnectPlay: vi.fn(),
    librespotStatus: vi.fn(),
    librespotPlayToDevice: vi.fn(),
    getDevices: vi.fn(),
  },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));

const localTrack: TrackInfo = {
  id: 'local-1',
  title: 'Local Track',
  artistName: 'Artist',
  albumTitle: 'Album',
  albumId: 'album-1',
  duration: 180,
};

function createOptions(overrides: Record<string, unknown> = {}) {
  return {
    audio: {
      play: vi.fn(),
      pause: vi.fn(),
      setReplayGain: vi.fn(),
    },
    selectedDeviceId: 'browser',
    spotifyWebDeviceId: null,
    pauseSpotifyWeb: vi.fn(),
    setSelectedDeviceId: vi.fn(),
    setSpotifyWebWanted: vi.fn(),
    setCurrentTrack: vi.fn(),
    setIsLoading: vi.fn(),
    fallbackToBrowserPlayback: vi.fn(),
    toast: vi.fn(),
    getQueue: () => [],
    ...overrides,
  };
}

describe('track playback routing helpers', () => {
  it('classifies provider-prefixed and local track ids', () => {
    expect(getPlaybackSource('spotify:1')).toBe('spotify');
    expect(getPlaybackSource('qobuz:1')).toBe('qobuz');
    expect(getPlaybackSource('radio:1')).toBe('radio');
    expect(getPlaybackSource('tidal:1')).toBe('tidal');
    expect(getPlaybackSource('local-1')).toBe('local');
  });

  it('only keeps Spotify Connect targets for Spotify tracks', () => {
    expect(resolvePlaybackDevice('spotify-connect:speaker', 'spotify')).toBe(
      'spotify-connect:speaker',
    );
    expect(resolvePlaybackDevice('spotify-connect:speaker', 'qobuz')).toBe('browser');
  });

  it('builds a LAN stream URL with the configured backend port', () => {
    expect(buildLanStreamUrl('/api/library/tracks/1/stream', '192.168.1.25', 4321)).toBe(
      'http://192.168.1.25:4321/api/library/tracks/1/stream',
    );
  });
});

describe('useTrackPlayback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getHealth.mockResolvedValue({ lanAddress: '192.168.1.25', port: 4321 });
    mocks.api.devicePlay.mockResolvedValue({});
    mocks.api.play.mockResolvedValue({});
    mocks.api.recordPlay.mockResolvedValue({});
    mocks.api.spotifyConnectDevices.mockResolvedValue({ data: [] });
    mocks.api.spotifyConnectPlay.mockResolvedValue({});
    mocks.api.librespotStatus.mockResolvedValue({ data: { isRunning: false } });
    mocks.api.getDevices.mockResolvedValue({ data: [] });
  });

  it('plays a local track in the browser and records it', () => {
    const options = createOptions();
    const { result } = renderHook(() => useTrackPlayback(options));

    act(() => result.current.startTrack(localTrack));

    expect(options.audio.play).toHaveBeenCalledWith('/api/library/tracks/local-1/stream');
    expect(options.pauseSpotifyWeb).toHaveBeenCalledOnce();
    expect(options.audio.pause).not.toHaveBeenCalled();
    expect(mocks.api.play).toHaveBeenCalledWith(localTrack, 'browser');
    expect(mocks.api.recordPlay).toHaveBeenCalledWith('local-1', 'album-1', '');
  });

  it('updates the selected device when a non-Spotify track falls back from Spotify Connect', () => {
    const options = createOptions({ selectedDeviceId: 'spotify-connect:speaker' });
    const { result } = renderHook(() => useTrackPlayback(options));

    act(() => result.current.startTrack(localTrack));

    expect(options.setSelectedDeviceId).toHaveBeenCalledWith('browser');
    expect(options.audio.play).toHaveBeenCalledWith('/api/library/tracks/local-1/stream');
  });

  it('uses the health endpoint address and port for an external local device', async () => {
    const options = createOptions({ selectedDeviceId: 'device-1' });
    const { result } = renderHook(() => useTrackPlayback(options));
    await waitFor(() => expect(mocks.api.getHealth).toHaveBeenCalledOnce());

    act(() => result.current.startTrack(localTrack));

    expect(mocks.api.devicePlay).toHaveBeenCalledWith(
      'device-1',
      'http://192.168.1.25:4321/api/library/tracks/local-1/stream',
      {
        title: 'Local Track',
        artist: 'Artist',
        album: 'Album',
        duration: 180,
      },
      'local-1',
    );
  });

  it('targets an explicitly selected Spotify Connect device', async () => {
    const options = createOptions({ selectedDeviceId: 'spotify-connect:spotify-device-1' });
    const spotifyTrack = { ...localTrack, id: 'spotify:track-123' };
    const { result } = renderHook(() => useTrackPlayback(options));

    act(() => result.current.startTrack(spotifyTrack));

    await waitFor(() =>
      expect(mocks.api.spotifyConnectPlay).toHaveBeenCalledWith(
        'spotify:track:track-123',
        'spotify-device-1',
      ),
    );
    expect(options.pauseSpotifyWeb).toHaveBeenCalledOnce();
    expect(options.audio.pause).toHaveBeenCalledOnce();
  });

  it('resolves and plays a radio stream in the browser', async () => {
    mocks.api.getRadioStream.mockResolvedValue({ data: { url: 'https://radio.test/live' } });
    const options = createOptions();
    const radioTrack = { ...localTrack, id: 'radio:station-1', title: 'Test Radio' };
    const { result } = renderHook(() => useTrackPlayback(options));

    act(() => result.current.startTrack(radioTrack));

    await waitFor(() => expect(options.audio.play).toHaveBeenCalledWith('https://radio.test/live'));
    expect(options.toast).toHaveBeenCalledWith('Tuned in: Test Radio', 'success');
  });

  it('ignores a stale Qobuz stream response after a newer local selection', async () => {
    let resolveQobuz!: (value: { data: { url: string } }) => void;
    mocks.api.getQobuzStreamUrl.mockReturnValue(
      new Promise((resolve) => {
        resolveQobuz = resolve;
      }),
    );
    const options = createOptions();
    const qobuzTrack = { ...localTrack, id: 'qobuz:123', title: 'Slow Qobuz' };
    const { result } = renderHook(() => useTrackPlayback(options));

    act(() => result.current.startTrack(qobuzTrack));
    act(() => result.current.startTrack(localTrack));
    await act(async () => resolveQobuz({ data: { url: 'https://qobuz.test/stale.flac' } }));

    expect(options.audio.play).toHaveBeenCalledTimes(1);
    expect(options.audio.play).toHaveBeenCalledWith('/api/library/tracks/local-1/stream');
    expect(options.setCurrentTrack).toHaveBeenLastCalledWith(localTrack);
    expect(options.toast).not.toHaveBeenCalledWith('Playing from Qobuz', 'success');
  });

  it('does not clear a newer track when an older Qobuz request fails', async () => {
    let rejectQobuz!: (reason: Error) => void;
    mocks.api.getQobuzStreamUrl.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectQobuz = reject;
      }),
    );
    const options = createOptions();
    const qobuzTrack = { ...localTrack, id: 'qobuz:123', title: 'Slow Qobuz' };
    const { result } = renderHook(() => useTrackPlayback(options));

    act(() => result.current.startTrack(qobuzTrack));
    act(() => result.current.startTrack(localTrack));
    await act(async () => rejectQobuz(new Error('stale failure')));

    expect(options.setCurrentTrack).toHaveBeenLastCalledWith(localTrack);
    expect(options.setCurrentTrack).not.toHaveBeenCalledWith(null);
    expect(options.toast).not.toHaveBeenCalledWith(
      expect.stringContaining('stale failure'),
      'error',
    );
  });

  it('does not start a pending provider stream after playback is cancelled', async () => {
    let resolveQobuz!: (value: { data: { url: string } }) => void;
    mocks.api.getQobuzStreamUrl.mockReturnValue(
      new Promise((resolve) => {
        resolveQobuz = resolve;
      }),
    );
    const options = createOptions();
    const qobuzTrack = { ...localTrack, id: 'qobuz:123', title: 'Slow Qobuz' };
    const { result } = renderHook(() => useTrackPlayback(options));

    act(() => result.current.startTrack(qobuzTrack));
    act(() => result.current.cancelPendingPlayback());
    await act(async () => resolveQobuz({ data: { url: 'https://qobuz.test/stale.flac' } }));

    expect(options.audio.play).not.toHaveBeenCalled();
    expect(options.toast).not.toHaveBeenCalledWith('Playing from Qobuz', 'success');
  });

  it('stops previous outputs when rejecting disabled Tidal playback', () => {
    const options = createOptions();
    const tidalTrack = { ...localTrack, id: 'tidal:track-1' };
    const { result } = renderHook(() => useTrackPlayback(options));

    act(() => result.current.startTrack(tidalTrack));

    expect(options.pauseSpotifyWeb).toHaveBeenCalledOnce();
    expect(options.audio.pause).toHaveBeenCalledOnce();
    expect(options.setCurrentTrack).toHaveBeenLastCalledWith(null);
    expect(options.toast).toHaveBeenCalledWith(
      expect.stringContaining('Tidal full-track playback is disabled'),
      'error',
    );
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackInfo } from '../AudioContext.js';

const mocks = vi.hoisted(() => {
  let endedHandler: (() => void) | null = null;

  const audio = {
    isPlaying: false,
    volume: 0.7,
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    setVolume: vi.fn(),
    seek: vi.fn(),
    setOnEnded: vi.fn((handler: () => void) => {
      endedHandler = handler;
    }),
    preloadNext: vi.fn(),
    setCrossfadeDuration: vi.fn(),
    setReplayGain: vi.fn(),
    getCurrentTime: vi.fn(() => 0),
    getDuration: vi.fn(() => 0),
  };

  const api = {
    getHealth: vi.fn(() => Promise.resolve({})),
    getDeviceStatus: vi.fn(() => Promise.resolve({ data: {} })),
    getStreamUrl: vi.fn((id: string) => `/api/library/tracks/${id}/stream`),
    getAlbumCoverUrl: vi.fn((id: string) => `/api/library/albums/${id}/cover`),
    play: vi.fn(() => Promise.resolve({})),
    recordPlay: vi.fn(() => Promise.resolve({})),
    deviceVolume: vi.fn(() => Promise.resolve({})),
    spotifyConnectVolume: vi.fn(() => Promise.resolve({})),
  };

  return {
    audio,
    api,
    toast: vi.fn(),
    socket: {
      connected: true,
      deviceUpdate: null,
      trackChanged: null,
      subscribeDevice: vi.fn(),
      unsubscribeDevice: vi.fn(),
    },
    getEndedHandler: () => endedHandler,
  };
});

vi.mock('../../hooks/useAudio.js', () => ({ useAudio: () => mocks.audio }));
vi.mock('../../hooks/useSocket.js', () => ({ useSocket: () => mocks.socket }));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { AudioProvider, useAudioContext } = await import('../AudioContext.js');

const tracks: TrackInfo[] = [
  { id: 'track-1', title: 'First', artistName: 'Artist A', albumTitle: 'Album' },
  { id: 'track-2', title: 'Second', artistName: 'Artist B', albumTitle: 'Album' },
  { id: 'track-3', title: 'Third', artistName: 'Artist C', albumTitle: 'Album' },
];

function Harness() {
  const ctx = useAudioContext();
  return (
    <div>
      <output data-testid="current">{ctx.currentTrack?.title ?? 'none'}</output>
      <output data-testid="queue">{ctx.queue.map((track) => track.title).join('|')}</output>
      <output data-testid="queue-index">{ctx.queueIndex}</output>
      <output data-testid="repeat">{ctx.repeat}</output>
      <output data-testid="shuffle">{String(ctx.shuffle)}</output>
      <output data-testid="volume">{ctx.volume}</output>
      <button onClick={() => ctx.playTrack(tracks[0])}>Play Track</button>
      <button onClick={() => ctx.playAlbum(tracks)}>Play Album</button>
      <button onClick={() => ctx.addToQueue({ ...tracks[0], id: 'track-4', title: 'Fourth' })}>
        Add
      </button>
      <button onClick={() => ctx.removeFromQueue(1)}>Remove Second</button>
      <button onClick={() => ctx.moveInQueue(2, 0)}>Move Third First</button>
      <button onClick={() => ctx.clearQueue()}>Clear</button>
      <button onClick={() => ctx.playNext()}>Next</button>
      <button onClick={() => ctx.toggleRepeat()}>Repeat</button>
      <button onClick={() => ctx.toggleShuffle()}>Shuffle</button>
      <button onClick={() => ctx.setVolume(0.42)}>Volume</button>
      <button onClick={() => ctx.setSelectedDeviceId('device-1')}>External Device</button>
    </div>
  );
}

function renderHarness() {
  return render(
    <AudioProvider>
      <Harness />
    </AudioProvider>,
  );
}

describe('AudioProvider queue controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.audio.isPlaying = false;
    mocks.audio.volume = 0.7;
    mocks.audio.getCurrentTime.mockReturnValue(0);
    mocks.api.getHealth.mockResolvedValue({});
    mocks.api.getDeviceStatus.mockResolvedValue({ data: {} });
  });

  it('seeds queue state when a single track is played', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Play Track'));

    expect(screen.getByTestId('current')).toHaveTextContent('First');
    expect(screen.getByTestId('queue')).toHaveTextContent('First');
    expect(screen.getByTestId('queue-index')).toHaveTextContent('0');
    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('/api/library/tracks/track-1/stream'),
    );
  });

  it('adds, removes, moves, and clears queue items', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Play Album'));
    fireEvent.click(screen.getByText('Add'));

    expect(screen.getByTestId('queue')).toHaveTextContent('First|Second|Third|Fourth');

    fireEvent.click(screen.getByText('Remove Second'));
    expect(screen.getByTestId('queue')).toHaveTextContent('First|Third|Fourth');

    fireEvent.click(screen.getByText('Move Third First'));
    expect(screen.getByTestId('queue')).toHaveTextContent('Fourth|First|Third');

    fireEvent.click(screen.getByText('Clear'));
    expect(screen.getByTestId('queue')).toHaveTextContent('');
    expect(screen.getByTestId('queue-index')).toHaveTextContent('-1');
  });

  it('advances through queue tracks and loops in repeat-all mode', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Play Album'));
    await waitFor(() => expect(mocks.audio.play).toHaveBeenCalled());
    mocks.audio.play.mockClear();

    fireEvent.click(screen.getByText('Next'));
    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('/api/library/tracks/track-2/stream'),
    );
    expect(screen.getByTestId('queue-index')).toHaveTextContent('1');

    fireEvent.click(screen.getByText('Repeat'));
    expect(screen.getByTestId('repeat')).toHaveTextContent('all');

    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));

    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenLastCalledWith('/api/library/tracks/track-1/stream'),
    );
    expect(screen.getByTestId('queue-index')).toHaveTextContent('0');
  });

  it('replays the current queue item in repeat-one mode', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Play Album'));
    await waitFor(() => expect(mocks.audio.play).toHaveBeenCalled());
    mocks.audio.play.mockClear();

    fireEvent.click(screen.getByText('Repeat'));
    fireEvent.click(screen.getByText('Repeat'));
    expect(screen.getByTestId('repeat')).toHaveTextContent('one');

    fireEvent.click(screen.getByText('Next'));

    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('/api/library/tracks/track-1/stream'),
    );
    expect(screen.getByTestId('queue-index')).toHaveTextContent('0');
  });

  it('uses shuffle when selecting the next track', async () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    renderHarness();

    fireEvent.click(screen.getByText('Play Album'));
    fireEvent.click(screen.getByText('Shuffle'));
    expect(screen.getByTestId('shuffle')).toHaveTextContent('true');
    await waitFor(() => expect(mocks.audio.play).toHaveBeenCalled());
    mocks.audio.play.mockClear();

    fireEvent.click(screen.getByText('Next'));

    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('/api/library/tracks/track-2/stream'),
    );
    randomSpy.mockRestore();
  });

  it('routes browser and external device volume changes correctly', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Volume'));
    expect(mocks.audio.setVolume).toHaveBeenCalledWith(0.42);
    expect(mocks.api.deviceVolume).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('External Device'));
    fireEvent.click(screen.getByText('Volume'));

    await waitFor(() => expect(mocks.api.deviceVolume).toHaveBeenCalledWith('device-1', 42));
    expect(mocks.audio.setVolume).toHaveBeenCalledTimes(1);
  });

  it('registers ended playback with the latest next-track handler', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Play Album'));
    await waitFor(() => expect(mocks.getEndedHandler()).toBeTypeOf('function'));
    mocks.audio.play.mockClear();

    mocks.getEndedHandler()?.();

    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('/api/library/tracks/track-2/stream'),
    );
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackInfo } from '../AudioContext.js';
import { createFakePlaybackServer } from '../../test/fakePlaybackServer.js';

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
    isPaused: vi.fn(() => false),
  };

  const api = {
    getHealth: vi.fn(() => Promise.resolve({})),
    getDeviceStatus: vi.fn(() => Promise.resolve({ data: {} })),
    getStreamUrl: vi.fn((id: string) => `/api/library/tracks/${id}/stream`),
    getAlbumCoverUrl: vi.fn((id: string) => `/api/library/albums/${id}/cover`),
    play: vi.fn(() => Promise.resolve({})),
    reportProgress: vi.fn(() => Promise.resolve({ data: { accepted: true } })),
    deviceVolume: vi.fn(() => Promise.resolve({})),
    spotifyConnectVolume: vi.fn(() => Promise.resolve({})),
    spotifyConnectPlay: vi.fn(() => Promise.resolve({})),
  };

  return {
    audio,
    api,
    toast: vi.fn(),
    socket: {
      connected: true,
      deviceUpdate: null,
      snapshot: null as unknown,
      queueEvent: null as unknown,
      stateEvent: null,
      trackChanged: null as unknown,
      subscribeDevice: vi.fn(),
      unsubscribeDevice: vi.fn(),
      requestSync: vi.fn(),
    },
    spotifyWeb: {
      deviceId: 'spotify-web-device',
      ready: true,
      error: null,
      playback: null as {
        paused: boolean;
        position: number;
        duration: number;
        trackId: string | null;
      } | null,
      setVolume: vi.fn(),
      pause: vi.fn(),
    },
    getEndedHandler: () => endedHandler,
  };
});

// The queue is server-authoritative (V03): a fresh in-memory fake server per
// test answers every queue command with a snapshot, like the real one.
let fakeServer = createFakePlaybackServer();
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
vi.mock('../../hooks/useSpotifyWebPlayback.js', () => ({
  useSpotifyWebPlayback: () => mocks.spotifyWeb,
}));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../api/client.js', () => ({
  api: new Proxy(mocks.api, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      return fakeServer.api[prop as keyof typeof fakeServer.api];
    },
  }),
  ApiError: FakeApiError,
  getClientId: () => 'me',
  newCommandId: () => `cmd-${Math.random()}`,
}));

const { AudioProvider, useAudioContext } = await import('../AudioContext.js');

const tracks: TrackInfo[] = [
  { id: 'track-1', title: 'First', artistName: 'Artist A', albumTitle: 'Album' },
  { id: 'track-2', title: 'Second', artistName: 'Artist B', albumTitle: 'Album' },
  { id: 'track-3', title: 'Third', artistName: 'Artist C', albumTitle: 'Album' },
];

const spotifyTracks: TrackInfo[] = [
  { id: 'spotify:spotify-1', title: 'Spotify First', artistName: 'Artist', albumTitle: 'Album' },
  { id: 'spotify:spotify-2', title: 'Spotify Second', artistName: 'Artist', albumTitle: 'Album' },
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
      <button onClick={() => ctx.playAlbum(spotifyTracks)}>Play Spotify Album</button>
      <button onClick={() => ctx.addToQueue({ ...tracks[0], id: 'track-4', title: 'Fourth' })}>
        Add
      </button>
      <button onClick={() => ctx.removeFromQueue(1)}>Remove Second</button>
      <button onClick={() => ctx.removeFromQueue(0)}>Remove First</button>
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
    fakeServer = createFakePlaybackServer();
    mocks.socket.snapshot = null;
    mocks.socket.queueEvent = null;
    mocks.socket.trackChanged = null;
    localStorage.clear();
    mocks.audio.isPlaying = false;
    mocks.audio.volume = 0.7;
    mocks.audio.getCurrentTime.mockReturnValue(0);
    mocks.spotifyWeb.playback = null;
    mocks.api.getHealth.mockResolvedValue({});
    mocks.api.getDeviceStatus.mockResolvedValue({ data: {} });
  });

  it('advances Spotify playback when the SDK pauses at the track duration', async () => {
    const view = renderHarness();

    fireEvent.click(screen.getByText('Play Spotify Album'));
    expect(screen.getByTestId('current')).toHaveTextContent('Spotify First');

    mocks.spotifyWeb.playback = {
      paused: false,
      position: 178.8,
      duration: 180,
      trackId: 'spotify-1',
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );

    mocks.spotifyWeb.playback = {
      paused: true,
      position: 180,
      duration: 180,
      trackId: 'spotify-1',
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('current')).toHaveTextContent('Spotify Second'));
    expect(mocks.api.spotifyConnectPlay).toHaveBeenLastCalledWith(
      'spotify:track:spotify-2',
      'spotify-web-device',
    );
  });

  it('confirms browser playback to the server while it plays (V05 heartbeat)', async () => {
    const view = renderHarness();
    mocks.api.reportProgress.mockClear();

    fireEvent.click(screen.getByText('Play Spotify Album'));
    mocks.spotifyWeb.playback = {
      paused: false,
      position: 12,
      duration: 180,
      trackId: 'spotify-1',
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    // The first report may precede the server's item id; once the snapshot
    // is applied the confirmation names the current queue item.
    await waitFor(() => expect(mocks.api.reportProgress).toHaveBeenCalledWith('item-1', 12));

    // Paused: no further confirmations, the server stops the clock.
    mocks.spotifyWeb.playback = { paused: true, position: 20, duration: 180, trackId: 'spotify-1' };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    mocks.api.reportProgress.mockClear();
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.api.reportProgress).not.toHaveBeenCalled();
  });

  it('does not advance Spotify playback for a manual pause mid-track', async () => {
    const view = renderHarness();

    fireEvent.click(screen.getByText('Play Spotify Album'));
    mocks.spotifyWeb.playback = {
      paused: false,
      position: 42,
      duration: 180,
      trackId: 'spotify-1',
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );

    mocks.spotifyWeb.playback = {
      paused: true,
      position: 42,
      duration: 180,
      trackId: 'spotify-1',
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );

    expect(screen.getByTestId('current')).toHaveTextContent('Spotify First');
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
    // The server's item id came back with the snapshot.
    expect(fakeServer.queue[0].itemId).toBeTruthy();
    expect(mocks.api.play).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'track-1', itemId: fakeServer.queue[0].itemId }),
      'browser',
      fakeServer.queue[0].itemId,
    );
  });

  it('adds, removes, moves, and clears queue items', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Play Album'));
    await waitFor(() => expect(fakeServer.queue).toHaveLength(3));
    fireEvent.click(screen.getByText('Add'));

    expect(screen.getByTestId('queue')).toHaveTextContent('First|Second|Third|Fourth');
    await waitFor(() => expect(fakeServer.queue).toHaveLength(4));

    fireEvent.click(screen.getByText('Remove Second'));
    expect(screen.getByTestId('queue')).toHaveTextContent('First|Third|Fourth');
    await waitFor(() =>
      expect(fakeServer.queue.map((q) => q.trackTitle)).toEqual(['First', 'Third', 'Fourth']),
    );

    fireEvent.click(screen.getByText('Move Third First'));
    expect(screen.getByTestId('queue')).toHaveTextContent('Fourth|First|Third');
    await waitFor(() =>
      expect(fakeServer.queue.map((q) => q.trackTitle)).toEqual(['Fourth', 'First', 'Third']),
    );

    fireEvent.click(screen.getByText('Clear'));
    expect(screen.getByTestId('queue')).toHaveTextContent('');
    expect(screen.getByTestId('queue-index')).toHaveTextContent('-1');
    await waitFor(() => expect(fakeServer.queue).toHaveLength(0));
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
    await waitFor(() => expect(screen.getByTestId('queue-index')).toHaveTextContent('2'));
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
    await waitFor(() => expect(mocks.audio.play).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Shuffle'));
    expect(screen.getByTestId('shuffle')).toHaveTextContent('true');
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

  it('plays the successor after removing the current middle queue item', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Play Album'));
    await waitFor(() => expect(fakeServer.queue).toHaveLength(3));
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() => expect(screen.getByTestId('queue-index')).toHaveTextContent('1'));

    fireEvent.click(screen.getByText('Remove Second'));
    expect(screen.getByTestId('queue')).toHaveTextContent('First|Third');
    expect(screen.getByTestId('queue-index')).toHaveTextContent('0');
    await waitFor(() => expect(fakeServer.queue).toHaveLength(2));
    mocks.audio.play.mockClear();

    mocks.getEndedHandler()?.();

    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('/api/library/tracks/track-3/stream'),
    );
  });

  it('plays the new first item after removing the current first queue item', async () => {
    renderHarness();

    fireEvent.click(screen.getByText('Play Album'));
    await waitFor(() => expect(fakeServer.queue).toHaveLength(3));
    fireEvent.click(screen.getByText('Remove First'));
    expect(screen.getByTestId('queue')).toHaveTextContent('Second|Third');
    expect(screen.getByTestId('queue-index')).toHaveTextContent('-1');
    await waitFor(() => expect(fakeServer.queue).toHaveLength(2));
    mocks.audio.play.mockClear();

    mocks.getEndedHandler()?.();

    await waitFor(() =>
      expect(mocks.audio.play).toHaveBeenCalledWith('/api/library/tracks/track-2/stream'),
    );
  });

  it('clears the ended handler when the provider unmounts', async () => {
    const view = renderHarness();
    await waitFor(() => expect(mocks.audio.setOnEnded).toHaveBeenCalledWith(expect.any(Function)));

    view.unmount();

    expect(mocks.audio.setOnEnded).toHaveBeenLastCalledWith(null);
  });
});

describe('AudioProvider session mirroring (V03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeServer = createFakePlaybackServer();
    mocks.socket.snapshot = null;
    mocks.socket.queueEvent = null;
    mocks.socket.trackChanged = null;
    localStorage.clear();
    mocks.audio.isPlaying = false;
    mocks.api.getHealth.mockResolvedValue({});
  });

  const entry = (id: string, title: string, itemId: string, position: number) => ({
    itemId,
    trackId: id,
    trackTitle: title,
    artistName: 'Someone',
    albumTitle: 'Album',
    position,
  });

  it('adopts the server snapshot on load (queue, index, shuffle/repeat) without starting audio', async () => {
    await fakeServer.api.setServerQueue(
      [tracks[0], tracks[1]].map((t) => ({ ...t })),
      1,
      'living-room',
      true,
      'all',
    );
    renderHarness();
    await waitFor(() => expect(screen.getByTestId('queue')).toHaveTextContent('First|Second'));
    expect(screen.getByTestId('queue-index')).toHaveTextContent('1');
    expect(screen.getByTestId('shuffle')).toHaveTextContent('true');
    expect(screen.getByTestId('repeat')).toHaveTextContent('all');
    // A track playing on a shared device is shown, but this tab plays nothing.
    expect(screen.getByTestId('current')).toHaveTextContent('Second');
    expect(mocks.audio.play).not.toHaveBeenCalled();
  });

  it('mirrors a queue event from another tab and ignores older revisions', async () => {
    const view = renderHarness();
    await waitFor(() => expect(screen.getByTestId('queue')).toHaveTextContent(''));

    mocks.socket.queueEvent = {
      revision: 5,
      queue: [entry('a', 'Alpha', 'i-a', 0), entry('b', 'Beta', 'i-b', 1)],
      currentItemId: 'i-a',
      queueIndex: 0,
      shuffle: false,
      repeat: 'off',
      origin: { clientId: 'other-tab', sessionId: null },
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('queue')).toHaveTextContent('Alpha|Beta'));

    mocks.socket.queueEvent = {
      revision: 3,
      queue: [entry('z', 'Stale', 'i-z', 0)],
      currentItemId: null,
      queueIndex: -1,
      shuffle: true,
      repeat: 'one',
      origin: { clientId: 'other-tab', sessionId: null },
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('queue')).toHaveTextContent('Alpha|Beta');
    expect(screen.getByTestId('shuffle')).toHaveTextContent('false');
  });

  it('never starts audio for a track change another browser tab caused', async () => {
    const view = renderHarness();
    await waitFor(() => expect(mocks.socket.subscribeDevice).toBeDefined());
    mocks.socket.trackChanged = {
      track: { id: 'track-9', title: 'Elsewhere', artistName: 'X', albumTitle: 'Y' },
      itemId: 'i-9',
      revision: 9,
      deviceId: 'browser',
      controllerClientId: 'other-tab',
      origin: { clientId: 'other-tab', sessionId: null },
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.audio.play).not.toHaveBeenCalled();
    expect(mocks.api.play).not.toHaveBeenCalled();
    expect(screen.getByTestId('current')).toHaveTextContent('none');
  });

  it('shows (but does not start) a server-side advance on a shared device', async () => {
    const view = renderHarness();
    fireEvent.click(screen.getByText('External Device'));
    mocks.socket.trackChanged = {
      track: { id: 'track-2', title: 'Second', artistName: 'X', albumTitle: 'Y' },
      itemId: 'i-2',
      revision: 12,
      deviceId: 'device-1',
      controllerClientId: 'me',
      origin: { clientId: null, sessionId: null, server: true },
    };
    view.rerender(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('current')).toHaveTextContent('Second'));
    expect(mocks.audio.play).not.toHaveBeenCalled();
    expect(mocks.api.play).not.toHaveBeenCalled();
  });

  it('re-applies a stale edit on the fresh snapshot the server sends back', async () => {
    renderHarness();
    fireEvent.click(screen.getByText('Play Album'));
    await waitFor(() => expect(fakeServer.queue).toHaveLength(3));
    const original = fakeServer.api.removeFromQueue;
    let calls = 0;
    fakeServer.api.removeFromQueue = ((itemId: string) => {
      calls++;
      if (calls === 1) {
        // Another device appended a track first: refuse with the fresh snapshot.
        fakeServer.api.addToQueue({ ...tracks[0], id: 'track-4', title: 'Fourth' });
        return Promise.reject(
          new FakeApiError('Queue changed', 409, 'StaleRevision', undefined, fakeServer.snapshot()),
        );
      }
      return original(itemId);
    }) as typeof original;

    fireEvent.click(screen.getByText('Remove Second'));
    await waitFor(() =>
      expect(screen.getByTestId('queue')).toHaveTextContent('First|Second|Third|Fourth'),
    );
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/another device/), 'info');
  });
});

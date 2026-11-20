import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * C01: a tab that switches to another room shows that room's queue, also
 * when that room's revision is lower than the one it came from. Revisions
 * count per room; one counter for all rooms dropped the new room's snapshot.
 * C02: a snapshot that changes nothing keeps the same queue array.
 */

const entry = (trackId: string, title: string) => ({
  itemId: `item-${trackId}`,
  trackId,
  trackTitle: title,
  artistName: 'Artist',
  albumTitle: 'Album',
  albumId: null,
  duration: 100,
  source: 'local',
});
const snapshotOf = (zoneId: string, revision: number, deviceId: string, titles: string[]) => ({
  zoneId,
  revision,
  queue: titles.map((t) => entry(t.toLowerCase(), t)),
  currentItemId: null,
  queueIndex: 0,
  state: { track: null, state: 'stopped', position: 0, duration: 0, volume: 50, deviceId },
  shuffle: false,
  repeat: 'off' as const,
  controller: { clientId: null, deviceId },
});

const LIVING = snapshotOf('zone-browser', 500, 'browser', ['Living One', 'Living Two']);
const KITCHEN = snapshotOf('zone-kitchen', 7, 'sonos-kitchen', ['Kitchen One']);

const mocks = vi.hoisted(() => ({
  activeZone: null as string | null,
  socket: {
    connected: true,
    deviceUpdate: null,
    snapshot: null as unknown,
    queueEvent: null as unknown,
    stateEvent: null,
    trackChanged: null,
    sleep: null,
    radio: null,
    zones: [],
    subscribeDevice: vi.fn(),
    unsubscribeDevice: vi.fn(),
    requestSync: vi.fn(),
    setZoneFilter: vi.fn(),
  },
  audio: {
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
  },
}));

vi.mock('../../hooks/useAudio.js', () => ({ useAudio: () => mocks.audio }));
vi.mock('../../hooks/useSocket.js', () => ({ useSocket: () => mocks.socket }));
vi.mock('../../hooks/useSpotifyWebPlayback.js', () => ({
  useSpotifyWebPlayback: () => ({
    deviceId: null,
    ready: false,
    error: null,
    playback: null,
    setVolume: vi.fn(),
    pause: vi.fn(),
  }),
}));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../../api/client.js', () => {
  const known: Record<string, unknown> = {
    getZones: () =>
      Promise.resolve({
        data: [
          { id: 'zone-browser', name: 'Browser', deviceId: 'browser', isDefault: true },
          { id: 'zone-kitchen', name: 'Kitchen', deviceId: 'sonos-kitchen', isDefault: false },
        ],
      }),
    // The server answers for the room the request names (X-Zone-Id).
    getPlaybackSession: () =>
      Promise.resolve({ data: mocks.activeZone === 'zone-kitchen' ? KITCHEN : LIVING }),
    getStreamUrl: (id: string) => `/api/library/tracks/${id}/stream`,
    getAlbumCoverUrl: (id: string) => `/api/library/albums/${id}/cover`,
  };
  return {
    api: new Proxy(known, {
      get: (target, prop: string) => target[prop] ?? (() => Promise.resolve({ data: {} })),
    }),
    ApiError: class extends Error {},
    getClientId: () => 'me',
    setActiveZone: (zone: string | null) => {
      mocks.activeZone = zone;
    },
    newCommandId: () => 'cmd',
  };
});

const { AudioProvider, useAudioContext } = await import('../AudioContext.js');

const seenQueues: unknown[] = [];
function Harness() {
  const ctx = useAudioContext();
  seenQueues.push(ctx.queue);
  return (
    <div>
      <output data-testid="queue">{ctx.queue.map((t) => t.title).join('|')}</output>
      <button onClick={() => ctx.setSelectedDeviceId('sonos-kitchen')}>Kitchen</button>
    </div>
  );
}

describe('a tab and its room', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.activeZone = null;
    mocks.socket.snapshot = null;
    mocks.socket.queueEvent = null;
    seenQueues.length = 0;
  });

  it('shows the room it switches to, even with a lower revision (C01)', async () => {
    render(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('queue')).toHaveTextContent('Living One|Living Two'),
    );

    fireEvent.click(screen.getByText('Kitchen'));
    await waitFor(() => expect(screen.getByTestId('queue')).toHaveTextContent('Kitchen One'));
  });

  it('ignores news from a room it does not steer (C01)', async () => {
    const view = render(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('queue')).toHaveTextContent('Living One|Living Two'),
    );
    // The kitchen's queue changes, with a higher revision than ours.
    mocks.socket.queueEvent = { ...KITCHEN, revision: 9000 };
    await act(async () => {
      view.rerender(
        <AudioProvider>
          <Harness />
        </AudioProvider>,
      );
    });
    expect(screen.getByTestId('queue')).toHaveTextContent('Living One|Living Two');
  });

  it('keeps the same queue when a snapshot changes nothing (C02)', async () => {
    const view = render(
      <AudioProvider>
        <Harness />
      </AudioProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('queue')).toHaveTextContent('Living One|Living Two'),
    );
    const before = seenQueues[seenQueues.length - 1];
    mocks.socket.snapshot = { ...LIVING, revision: 501 };
    await act(async () => {
      view.rerender(
        <AudioProvider>
          <Harness />
        </AudioProvider>,
      );
    });
    expect(seenQueues[seenQueues.length - 1]).toBe(before);
  });
});

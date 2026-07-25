import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentTrack: {
    id: 'track-1',
    title: 'First',
    artistName: 'Artist',
    albumTitle: 'Album',
  } as { id: string; title: string; artistName: string; albumTitle: string } | null,
  getLyrics: vi.fn(),
}));

vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({ currentTrack: mocks.currentTrack }),
  useProgress: () => ({ currentTime: 0, duration: 0 }),
}));

vi.mock('../../api/client.js', () => ({
  api: { getLyrics: mocks.getLyrics },
}));

const { default: LyricsDisplay } = await import('../LyricsDisplay.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('LyricsDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentTrack = {
      id: 'track-1',
      title: 'First',
      artistName: 'Artist',
      albumTitle: 'Album',
    };
  });

  it('ignores a stale lyrics response after the track changes', async () => {
    const first = deferred<{ data: { plain: string; synced: null; source: string } }>();
    const second = deferred<{ data: { plain: string; synced: null; source: string } }>();
    mocks.getLyrics.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const view = render(<LyricsDisplay />);
    mocks.currentTrack = {
      id: 'track-2',
      title: 'Second',
      artistName: 'Artist',
      albumTitle: 'Album',
    };
    view.rerender(<LyricsDisplay />);

    await act(async () => {
      second.resolve({ data: { plain: 'Second lyrics', synced: null, source: 'test' } });
      await second.promise;
    });
    expect(screen.getByText('Second lyrics')).toBeInTheDocument();

    await act(async () => {
      first.resolve({ data: { plain: 'Stale first lyrics', synced: null, source: 'test' } });
      await first.promise;
    });
    expect(screen.getByText('Second lyrics')).toBeInTheDocument();
    expect(screen.queryByText('Stale first lyrics')).not.toBeInTheDocument();
  });
});

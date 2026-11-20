import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, Link, Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary, pageErrorFallback } from '../ErrorBoundary.js';
import { useMediaSession } from '../../hooks/useMediaSession.js';
import { setProgress } from '../../context/ProgressStore.js';

vi.mock('../../api/client.js', () => ({
  api: { getAlbumCoverUrl: (id: string) => `/api/library/albums/${id}/cover` },
}));

/**
 * C04: a page that fails leaves the menu and the player standing, and going
 * to another page starts clean. C07: the lock screen can seek and knows
 * where the track is.
 */

function Shell() {
  const location = useLocation();
  return (
    <div>
      <nav>
        <Link to="/good">Good page</Link>
      </nav>
      <main>
        <ErrorBoundary key={location.pathname} fallback={pageErrorFallback}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <footer>Player bar</footer>
    </div>
  );
}
function Broken(): never {
  throw new Error('page exploded');
}

describe('a page that fails (C04)', () => {
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalError;
  });

  it('keeps the menu and the player, and another page works again', () => {
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/broken" element={<Broken />} />
            <Route path="/good" element={<p>All fine here</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This page could not be shown');
    expect(screen.getByRole('alert')).toHaveTextContent('page exploded');
    expect(screen.getByText('Player bar')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Good page'));
    expect(screen.getByText('All fine here')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the lock screen (C07)', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'mediaSession');
    vi.unstubAllGlobals();
    setProgress(0, 0);
  });

  it('can seek and is told where the track is', () => {
    const handlers = new Map<string, MediaSessionActionHandler | null>();
    const setPositionState = vi.fn();
    Object.defineProperty(navigator, 'mediaSession', {
      configurable: true,
      value: {
        metadata: null,
        playbackState: 'none',
        setActionHandler: (action: string, handler: MediaSessionActionHandler | null) =>
          handlers.set(action, handler),
        setPositionState,
      },
    });
    vi.stubGlobal('MediaMetadata', class {});
    setProgress(30, 200);

    const seek = vi.fn();
    renderHook(() =>
      useMediaSession({
        currentTrack: { id: 't', title: 'T', artistName: 'A', albumTitle: 'B' },
        selectedDeviceId: 'browser',
        isPlaying: true,
        browserAudioIsPlaying: true,
        isBrowserAudioPaused: () => false,
        resumeBrowserAudio: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        playPrevious: vi.fn(),
        playNext: vi.fn(),
        seek,
      }),
    );

    expect(setPositionState).toHaveBeenCalledWith({ duration: 200, position: 30, playbackRate: 1 });
    handlers.get('seekto')?.({ action: 'seekto', seekTime: 95 });
    expect(seek).toHaveBeenCalledWith(95);
  });
});

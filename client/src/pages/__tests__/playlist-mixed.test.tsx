import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A mixed playlist in the UI (V12.1). An item the server cannot play right
 * now must stay visible with its reason, and must not be started: "Play All"
 * and a click on a row both skip it.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getPlaylist: vi.fn(),
    getPlaylistTracks: vi.fn(),
    removeFromPlaylist: vi.fn(),
    reorderPlaylist: vi.fn(),
    exportPlaylist: vi.fn(),
  },
  audio: {
    playAlbum: vi.fn(),
    currentTrack: null,
    isPlaying: false,
  },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/SortableList.js', () => ({
  default: ({
    items,
    renderItem,
  }: {
    items: Array<{ id: string }>;
    renderItem: (item: { id: string }) => React.ReactNode;
  }) => (
    <div>
      {items.map((item) => (
        <div key={item.id}>{renderItem(item)}</div>
      ))}
    </div>
  ),
}));

const { default: PlaylistPage } = await import('../PlaylistPage.js');

const items = [
  {
    playlistItemId: 'pli-1',
    playlistPosition: 0,
    id: 'track-1',
    title: 'Local Song',
    artistName: 'Local Artist',
    albumTitle: 'Local Album',
    duration: 200,
    source: 'local',
    availability: 'available',
  },
  {
    playlistItemId: 'pli-2',
    playlistPosition: 1,
    id: 'qobuz:5',
    title: 'Remote Song',
    artistName: 'Remote Artist',
    albumTitle: 'Remote Album',
    duration: 240,
    source: 'qobuz',
    availability: 'unavailable',
    unavailableReason: 'Qobuz is not connected',
  },
];

function renderPage() {
  const router = createMemoryRouter([{ path: '/playlists/:id', element: <PlaylistPage /> }], {
    initialEntries: ['/playlists/pl-1'],
  });
  return render(<RouterProvider router={router} />);
}

describe('Playlist page with mixed sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getPlaylist.mockResolvedValue({ data: { id: 'pl-1', name: 'Mixed' } });
    mocks.api.getPlaylistTracks.mockResolvedValue({
      data: items,
      meta: { total: 2, playable: 1, unavailable: 1 },
    });
  });

  it('shows an unavailable item with its reason instead of hiding it', async () => {
    renderPage();
    expect(await screen.findByText('Remote Song')).toBeTruthy();
    expect(screen.getByText('Qobuz is not connected')).toBeTruthy();
    expect(screen.getByText(/1 not playable right now/)).toBeTruthy();
    expect(screen.getByText(/exported as comments/)).toBeTruthy();
  });

  it('plays only the items that can be played', async () => {
    renderPage();
    const playAll = await screen.findByText('Play All');
    playAll.click();
    await waitFor(() => expect(mocks.audio.playAlbum).toHaveBeenCalled());
    const [queue] = mocks.audio.playAlbum.mock.calls[0];
    expect(queue.map((t: { id: string }) => t.id)).toEqual(['track-1']);
  });

  it('does not start a track that cannot be played', async () => {
    renderPage();
    const row = (await screen.findByText('Remote Song')).closest('[role="button"]');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    (row as HTMLElement).click();
    expect(mocks.audio.playAlbum).not.toHaveBeenCalled();
  });
});

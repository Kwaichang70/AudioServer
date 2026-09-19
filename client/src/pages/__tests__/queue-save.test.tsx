import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    createPlaylist: vi.fn(),
    addItemsToPlaylist: vi.fn(),
  },
  audio: {
    queue: [
      { id: 't1', title: 'One', artistName: 'A', albumTitle: 'X', itemId: 'i1' },
      { id: 'qobuz:9', title: 'Streamed', artistName: 'B', albumTitle: 'Y', itemId: 'i2' },
      { id: 'spotify:5', title: 'Spotted', artistName: 'C', albumTitle: 'Z', itemId: 'i4' },
      { id: 't2', title: 'Two', artistName: 'A', albumTitle: 'X', itemId: 'i3' },
    ],
    queueIndex: 0,
    playQueueIndex: vi.fn(),
    removeFromQueue: vi.fn(),
    moveInQueue: vi.fn(),
    clearQueue: vi.fn(),
    currentTrack: null,
    isPlaying: false,
  },
  toast: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../components/SortableList.js', () => ({ default: () => null }));

const { default: QueuePage } = await import('../QueuePage.js');

function renderQueue() {
  return render(
    <MemoryRouter initialEntries={['/queue']}>
      <Routes>
        <Route path="/queue" element={<QueuePage />} />
        <Route path="/playlists/:id" element={<p>Playlist opened</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * R01.3: keep the queue you built. Since V12.1 a playlist holds Qobuz and
 * radio items too, with their snapshot; Spotify stays out, as everywhere. What
 * is left out is counted in the message, never dropped silently.
 */
describe('save the queue as a playlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.createPlaylist.mockResolvedValue({ data: { id: 'pl-7', name: 'Evening' } });
    mocks.api.addItemsToPlaylist.mockResolvedValue({
      data: { ok: true, trackCount: 3, added: 3, skipped: 0, skippedItems: [] },
    });
  });

  it('creates the playlist and adds the queue in order', async () => {
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }));
    fireEvent.change(screen.getByLabelText('Playlist name'), { target: { value: 'Evening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.api.createPlaylist).toHaveBeenCalledWith('Evening'));
    const [, items] = mocks.api.addItemsToPlaylist.mock.calls[0] as unknown as [
      string,
      Array<{ trackId: string; title?: string }>,
    ];
    // In queue order, Qobuz with its snapshot (V12.1), Spotify left out.
    expect(items.map((item) => item.trackId)).toEqual(['t1', 'qobuz:9', 't2']);
    expect(items[1]).toMatchObject({ title: 'Streamed', artistName: 'B' });
    expect(await screen.findByText('Playlist opened')).toBeInTheDocument();
  });

  it('names what it could not store: Spotify, and what the server refused', async () => {
    mocks.api.addItemsToPlaylist.mockResolvedValue({
      data: {
        ok: true,
        trackCount: 2,
        added: 2,
        skipped: 1,
        skippedItems: [{ trackId: 'qobuz:9', reason: 'no title' }],
      },
    });
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }));
    fireEvent.change(screen.getByLabelText('Playlist name'), { target: { value: 'Evening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        'Saved 2 tracks to "Evening"; 2 could not be stored',
        'info',
      ),
    );
  });

  it('will not save without a name', () => {
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }));

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps the form open when the server refuses', async () => {
    mocks.api.createPlaylist.mockRejectedValue(new Error('nope'));
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }));
    fireEvent.change(screen.getByLabelText('Playlist name'), { target: { value: 'Evening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(screen.getByLabelText('Playlist name')).toHaveValue('Evening');
  });
});

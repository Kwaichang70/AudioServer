import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    createPlaylist: vi.fn(),
    addTracksToPlaylist: vi.fn(),
  },
  audio: {
    queue: [
      { id: 't1', title: 'One', artistName: 'A', albumTitle: 'X', itemId: 'i1' },
      { id: 'qobuz:9', title: 'Streamed', artistName: 'B', albumTitle: 'Y', itemId: 'i2' },
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
 * R01.3: keep the queue you built. A playlist row points at the library, so a
 * streaming item cannot go in yet — and the listener is told, instead of
 * finding a playlist that is quietly shorter than the queue was.
 */
describe('save the queue as a playlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.createPlaylist.mockResolvedValue({ data: { id: 'pl-7', name: 'Evening' } });
    mocks.api.addTracksToPlaylist.mockResolvedValue({
      data: { ok: true, trackCount: 2, added: 2, skipped: 1 },
    });
  });

  it('creates the playlist and adds the queue in order', async () => {
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }));
    fireEvent.change(screen.getByLabelText('Playlist name'), { target: { value: 'Evening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.api.createPlaylist).toHaveBeenCalledWith('Evening'));
    expect(mocks.api.addTracksToPlaylist).toHaveBeenCalledWith('pl-7', ['t1', 'qobuz:9', 't2']);
    expect(await screen.findByText('Playlist opened')).toBeInTheDocument();
  });

  it('names the streaming tracks it could not store', async () => {
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }));
    fireEvent.change(screen.getByLabelText('Playlist name'), { target: { value: 'Evening' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        'Saved 2 tracks to "Evening"; 1 streaming tracks cannot be stored in a playlist yet',
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

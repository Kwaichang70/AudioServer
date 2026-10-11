import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Smart playlists built in Focus (R05.3): shown as their groups, opened in
 * Focus, edited as groups — and old rule-only playlists keep the rule editor.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getSmartPlaylists: vi.fn(),
    getSmartPlaylistTracks: vi.fn(),
    updateSmartPlaylist: vi.fn(),
    setSmartPlaylistDefinition: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
  audio: { playAlbum: vi.fn(), currentTrack: null, isPlaying: false },
  toast: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: SmartPlaylistsPage } = await import('../SmartPlaylistsPage.js');

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/smart-playlists', element: <SmartPlaylistsPage /> },
      { path: '/smart-playlists/:id', element: <SmartPlaylistsPage /> },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

const focusPlaylist = {
  id: 'sp-focus',
  name: 'Hi-res or blues',
  rules: '[]',
  trackCount: 2,
  definition: {
    version: 2,
    groups: ['quality=hires&genre=Jazz', 'genre=Blues'],
    sort: 'year',
    order: 'desc',
    limit: 50,
  },
};
const rulePlaylist = {
  id: 'sp-rules',
  name: 'Davis',
  rules: JSON.stringify([{ field: 'artistName', operator: 'contains', value: 'Davis' }]),
  trackCount: 1,
  definition: {
    version: 2,
    groups: [
      `rule=${encodeURIComponent(JSON.stringify({ field: 'artistName', operator: 'contains', value: 'Davis' }))}`,
    ],
    sort: 'artist',
    order: 'asc',
    limit: 200,
  },
};

describe('Smart playlists as Focus questions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getSmartPlaylists.mockResolvedValue({ data: [focusPlaylist, rulePlaylist] });
    mocks.api.getSmartPlaylistTracks.mockResolvedValue({
      data: [
        { id: 't-1', title: 'So What', artistName: 'Miles Davis', albumTitle: 'Kind of Blue' },
      ],
    });
    mocks.api.updateSmartPlaylist.mockResolvedValue({ data: focusPlaylist });
    mocks.api.setSmartPlaylistDefinition.mockResolvedValue({ data: focusPlaylist });
  });

  it('shows the groups in words, each openable in Focus', async () => {
    renderAt('/smart-playlists/sp-focus');
    const summary = await screen.findByTestId('smart-definition');
    expect(within(summary).getByText('Tracks matching any of')).toBeInTheDocument();
    expect(within(summary).getByText('Hi-Res · Jazz')).toBeInTheDocument();
    expect(within(summary).getByText('Blues')).toBeInTheDocument();
    const links = within(summary).getAllByRole('link', { name: 'Open in Focus' });
    expect(links[0]).toHaveAttribute(
      'href',
      '/tracks?quality=hires&genre=Jazz&sort=year&order=desc',
    );
    expect(within(summary).getByText(/at most 50 tracks/)).toBeInTheDocument();
  });

  it('edits groups, sort and limit without touching the rules', async () => {
    renderAt('/smart-playlists/sp-focus');
    await screen.findByTestId('smart-definition');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit smart playlist' });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove group Blues' }));
    fireEvent.change(within(form).getByRole('spinbutton'), { target: { value: '25' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocks.api.setSmartPlaylistDefinition).toHaveBeenCalledWith('sp-focus', {
        groups: ['quality=hires&genre=Jazz'],
        sort: 'year',
        order: 'desc',
        limit: 25,
      }),
    );
    expect(mocks.api.updateSmartPlaylist).not.toHaveBeenCalled();
  });

  it('keeps the rule editor for a migrated rule-only playlist', async () => {
    renderAt('/smart-playlists/sp-rules');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit rules' }));
    expect(screen.queryByRole('form', { name: 'Edit smart playlist' })).not.toBeInTheDocument();
    // Name and rule value are both "Davis": the rule editor is open.
    expect(screen.getAllByDisplayValue('Davis')).toHaveLength(2);
  });
});

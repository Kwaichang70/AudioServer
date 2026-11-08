import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The user's Spotify playlists in AudioServer: listed under the library's own
 * playlists, opened as a read-only page whose tracks play like any Spotify
 * track.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getPlaylists: vi.fn(),
    getSpotifyPlaylists: vi.fn(),
    getSpotifyPlaylistTracks: vi.fn(),
  },
  audio: { playAlbum: vi.fn(), currentTrack: null, isPlaying: false },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/PlayActions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/PlayActions.js')>()),
  default: () => null,
}));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { default: PlaylistsPage } = await import('../PlaylistsPage.js');
const { default: SpotifyPlaylistPage } = await import('../SpotifyPlaylistPage.js');

const track = (n: number) => ({
  id: `spotify:t${n}`,
  title: `Song ${n}`,
  artistName: 'Miles Davis',
  albumTitle: 'Kind of Blue',
  albumId: 'spotify:kb',
  duration: 300,
  source: 'spotify',
});

function renderApp(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/playlists', element: <PlaylistsPage /> },
      { path: '/playlists/spotify/:id', element: <SpotifyPlaylistPage /> },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('Spotify playlists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getPlaylists.mockResolvedValue({ data: [{ id: 'p1', name: 'Mine', trackCount: 3 }] });
    mocks.api.getSpotifyPlaylists.mockResolvedValue({
      data: [{ id: 'spotify:abc', name: 'Zondag Jazz', trackCount: 2, source: 'spotify' }],
    });
    mocks.api.getSpotifyPlaylistTracks.mockResolvedValue({ data: [track(1), track(2)] });
  });

  it('lists them after the library playlists, and opens one', async () => {
    const router = renderApp('/playlists');
    expect(await screen.findByText('Mine')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /Zondag Jazz/ });
    expect(screen.getByRole('heading', { name: /Spotify/ })).toBeInTheDocument();
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe('/playlists/spotify/abc'));
    expect(mocks.api.getSpotifyPlaylistTracks).toHaveBeenCalledWith('abc');
    expect(await screen.findByRole('heading', { name: 'Zondag Jazz' })).toBeInTheDocument();
  });

  it('shows no Spotify section when Spotify is not connected', async () => {
    mocks.api.getSpotifyPlaylists.mockResolvedValue({ data: [] });
    renderApp('/playlists');
    expect(await screen.findByText('Mine')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Spotify/ })).toBeNull();
  });

  it('plays the whole playlist, or from a clicked track', async () => {
    renderApp('/playlists/spotify/abc');
    fireEvent.click(await screen.findByRole('button', { name: 'Play All' }));
    expect(mocks.audio.playAlbum).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'spotify:t1' }),
      expect.objectContaining({ id: 'spotify:t2' }),
    ]);
    fireEvent.click(screen.getByText('Song 2'));
    expect(mocks.audio.playAlbum).toHaveBeenLastCalledWith(expect.any(Array), 1);
  });

  it('says so when Spotify does not answer', async () => {
    mocks.api.getSpotifyPlaylistTracks.mockRejectedValue(new Error('401'));
    renderApp('/playlists/spotify/abc');
    expect(await screen.findByText(/Spotify did not return this playlist/)).toBeInTheDocument();
  });
});

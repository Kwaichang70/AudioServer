import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    getAlbum: vi.fn(),
    getAlbumTracks: vi.fn(),
    getSpotifyAlbum: vi.fn(),
    getSpotifyAlbumTracks: vi.fn(),
    getQobuzAlbum: vi.fn(),
    getQobuzAlbumTracks: vi.fn(),
    getTidalAlbum: vi.fn(),
    getTidalAlbumTracks: vi.fn(),
    checkFavorite: vi.fn(),
    toggleFavorite: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
    getArtist: vi.fn(),
    getArtistAlbums: vi.fn(),
    getSimilarArtists: vi.fn(),
    getArtistImageUrl: vi.fn((id: string) => `/artists/${id}`),
    getPlaylist: vi.fn(),
    getPlaylistTracks: vi.fn(),
    removeFromPlaylist: vi.fn(),
    reorderPlaylist: vi.fn(),
    exportPlaylist: vi.fn(),
    getGenres: vi.fn(),
    getGenreAlbums: vi.fn(),
    getSmartPlaylists: vi.fn(),
    getSmartPlaylistTracks: vi.fn(),
    updateSmartPlaylist: vi.fn(),
  },
  audio: {
    playTrack: vi.fn(),
    playAlbum: vi.fn(),
    currentTrack: null,
    isPlaying: false,
  },
  toast: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => mocks.audio,
}));
vi.mock('../../components/AddToPlaylist.js', () => ({ default: () => null }));
vi.mock('../../components/AlbumCover.js', () => ({
  default: ({ title }: { title: string }) => <div data-testid="album-cover">{title}</div>,
}));
vi.mock('../../components/SortableList.js', () => ({ default: () => null }));
vi.mock('../../components/Toast.js', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

const { default: AlbumPage } = await import('../AlbumPage.js');
const { default: ArtistPage } = await import('../ArtistPage.js');
const { default: PlaylistPage } = await import('../PlaylistPage.js');
const { default: GenresPage } = await import('../GenresPage.js');
const { default: SmartPlaylistsPage } = await import('../SmartPlaylistsPage.js');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function renderRoute(path: string, routePath: string, element: React.ReactNode) {
  const router = createMemoryRouter([{ path: routePath, element }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

async function navigate(router: ReturnType<typeof createMemoryRouter>, path: string) {
  await act(async () => {
    await router.navigate(path);
  });
}

describe('detail page request ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.checkFavorite.mockResolvedValue({ data: { favorited: false } });
    mocks.api.getSimilarArtists.mockResolvedValue({ data: { similar: [] } });
  });

  it('keeps the new album when the previous album resolves last', async () => {
    const oldAlbum = deferred<{ data: { id: string; title: string; artistName: string } }>();
    const oldTracks = deferred<{ data: [] }>();
    mocks.api.getAlbum.mockImplementation((id: string) =>
      id === 'old'
        ? oldAlbum.promise
        : Promise.resolve({ data: { id: 'new', title: 'New Album', artistName: 'Artist' } }),
    );
    mocks.api.getAlbumTracks.mockImplementation((id: string) =>
      id === 'old' ? oldTracks.promise : Promise.resolve({ data: [] }),
    );

    const router = renderRoute('/albums/old', '/albums/:id', <AlbumPage />);
    await waitFor(() => expect(mocks.api.getAlbum).toHaveBeenCalledWith('old'));
    await navigate(router, '/albums/new');
    expect(await screen.findByRole('heading', { name: 'New Album' })).toBeInTheDocument();

    await act(async () => {
      oldAlbum.resolve({ data: { id: 'old', title: 'Old Album', artistName: 'Artist' } });
      oldTracks.resolve({ data: [] });
      await oldAlbum.promise;
    });

    expect(screen.getByRole('heading', { name: 'New Album' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Old Album' })).not.toBeInTheDocument();
  });

  it('clears an album while the next route is still loading', async () => {
    const nextAlbum = deferred<{ data: { id: string; title: string; artistName: string } }>();
    const nextTracks = deferred<{ data: [] }>();
    mocks.api.getAlbum.mockImplementation((id: string) =>
      id === 'old'
        ? Promise.resolve({ data: { id: 'old', title: 'Old Album', artistName: 'Artist' } })
        : nextAlbum.promise,
    );
    mocks.api.getAlbumTracks.mockImplementation((id: string) =>
      id === 'old' ? Promise.resolve({ data: [] }) : nextTracks.promise,
    );

    const router = renderRoute('/albums/old', '/albums/:id', <AlbumPage />);
    expect(await screen.findByRole('heading', { name: 'Old Album' })).toBeInTheDocument();
    await navigate(router, '/albums/new');

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Old Album' })).not.toBeInTheDocument();

    await act(async () => {
      nextAlbum.resolve({ data: { id: 'new', title: 'New Album', artistName: 'Artist' } });
      nextTracks.resolve({ data: [] });
      await nextAlbum.promise;
    });
  });

  it('exposes native album playback and favorite controls', async () => {
    mocks.api.getAlbum.mockResolvedValue({
      data: { id: 'album', title: 'Accessible Album', artistName: 'Album Artist' },
    });
    mocks.api.getAlbumTracks.mockResolvedValue({
      data: [
        {
          id: 'track',
          title: 'Keyboard Track',
          artistName: 'Track Artist',
          albumTitle: 'Accessible Album',
          albumId: 'album',
        },
      ],
    });
    mocks.api.checkFavorite.mockResolvedValue({ data: { favorited: true } });

    renderRoute('/albums/album', '/albums/:id', <AlbumPage />);

    const playButton = await screen.findByRole('button', {
      name: 'Play Keyboard Track by Track Artist',
    });
    fireEvent.click(playButton);
    expect(mocks.audio.playTrack).toHaveBeenCalledTimes(1);

    const favoriteButton = screen.getByRole('button', {
      name: 'Remove Accessible Album from favorites',
    });
    expect(favoriteButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the new artist when the previous artist resolves last', async () => {
    const oldArtist = deferred<{ data: { id: string; name: string } }>();
    const oldAlbums = deferred<{ data: [] }>();
    mocks.api.getArtist.mockImplementation((id: string) =>
      id === 'old'
        ? oldArtist.promise
        : Promise.resolve({ data: { id: 'new', name: 'New Artist' } }),
    );
    mocks.api.getArtistAlbums.mockImplementation((id: string) =>
      id === 'old' ? oldAlbums.promise : Promise.resolve({ data: [] }),
    );

    const router = renderRoute('/artists/old', '/artists/:id', <ArtistPage />);
    await waitFor(() => expect(mocks.api.getArtist).toHaveBeenCalledWith('old'));
    await navigate(router, '/artists/new');
    expect(await screen.findByRole('heading', { name: 'New Artist' })).toBeInTheDocument();

    await act(async () => {
      oldArtist.resolve({ data: { id: 'old', name: 'Old Artist' } });
      oldAlbums.resolve({ data: [] });
      await oldArtist.promise;
    });

    expect(screen.getByRole('heading', { name: 'New Artist' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Old Artist' })).not.toBeInTheDocument();
  });

  it('keeps the new playlist when the previous playlist resolves last', async () => {
    const oldPlaylist = deferred<{ data: { id: string; name: string } }>();
    const oldTracks = deferred<{ data: [] }>();
    mocks.api.getPlaylist.mockImplementation((id: string) =>
      id === 'old'
        ? oldPlaylist.promise
        : Promise.resolve({ data: { id: 'new', name: 'New Playlist' } }),
    );
    mocks.api.getPlaylistTracks.mockImplementation((id: string) =>
      id === 'old' ? oldTracks.promise : Promise.resolve({ data: [] }),
    );

    const router = renderRoute('/playlists/old', '/playlists/:id', <PlaylistPage />);
    await waitFor(() => expect(mocks.api.getPlaylist).toHaveBeenCalledWith('old'));
    await navigate(router, '/playlists/new');
    expect(await screen.findByRole('heading', { name: 'New Playlist' })).toBeInTheDocument();

    await act(async () => {
      oldPlaylist.resolve({ data: { id: 'old', name: 'Old Playlist' } });
      oldTracks.resolve({ data: [] });
      await oldPlaylist.promise;
    });

    expect(screen.getByRole('heading', { name: 'New Playlist' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Old Playlist' })).not.toBeInTheDocument();
  });

  it('keeps the new genre albums when the previous genre resolves last', async () => {
    const oldAlbums = deferred<{
      data: { id: string; title: string; artistName: string }[];
    }>();
    mocks.api.getGenreAlbums.mockImplementation((genre: string) =>
      genre === 'Old'
        ? oldAlbums.promise
        : Promise.resolve({
            data: [{ id: 'new-album', title: 'New Genre Album', artistName: 'Artist' }],
          }),
    );

    const router = renderRoute('/genres/Old', '/genres/:genre', <GenresPage />);
    await waitFor(() => expect(mocks.api.getGenreAlbums).toHaveBeenCalledWith('Old'));
    await navigate(router, '/genres/New');
    expect((await screen.findAllByText('New Genre Album')).length).toBeGreaterThan(0);

    await act(async () => {
      oldAlbums.resolve({
        data: [{ id: 'old-album', title: 'Old Genre Album', artistName: 'Artist' }],
      });
      await oldAlbums.promise;
    });

    expect(screen.getAllByText('New Genre Album').length).toBeGreaterThan(0);
    expect(screen.queryByText('Old Genre Album')).not.toBeInTheDocument();
  });

  it('keeps the new smart playlist when the previous detail resolves last', async () => {
    const oldTracks = deferred<{ data: [] }>();
    const oldPlaylists = deferred<{
      data: { id: string; name: string; rules: string; trackCount: number }[];
    }>();
    mocks.api.getSmartPlaylistTracks.mockImplementation((id: string) =>
      id === 'old' ? oldTracks.promise : Promise.resolve({ data: [] }),
    );
    mocks.api.getSmartPlaylists
      .mockImplementationOnce(() => oldPlaylists.promise)
      .mockResolvedValue({
        data: [{ id: 'new', name: 'New Smart Playlist', rules: '[]', trackCount: 0 }],
      });

    const router = renderRoute(
      '/smart-playlists/old',
      '/smart-playlists/:id',
      <SmartPlaylistsPage />,
    );
    await waitFor(() => expect(mocks.api.getSmartPlaylistTracks).toHaveBeenCalledWith('old'));
    await navigate(router, '/smart-playlists/new');
    expect(await screen.findByRole('heading', { name: 'New Smart Playlist' })).toBeInTheDocument();

    await act(async () => {
      oldTracks.resolve({ data: [] });
      oldPlaylists.resolve({
        data: [{ id: 'old', name: 'Old Smart Playlist', rules: '[]', trackCount: 0 }],
      });
      await oldTracks.promise;
    });

    expect(screen.getByRole('heading', { name: 'New Smart Playlist' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Old Smart Playlist' })).not.toBeInTheDocument();
  });
});

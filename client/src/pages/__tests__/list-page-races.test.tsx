import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    getHistoryTracks: vi.fn(),
    getRecentAlbums: vi.fn(),
    getTopArtists: vi.fn(),
    getFavorites: vi.fn(),
    getFavoriteTracks: vi.fn(),
    getRadioFeatured: vi.fn(),
    searchRadio: vi.fn(),
    cacheRadioStation: vi.fn(),
    toggleFavorite: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
    getArtistImageUrl: vi.fn((id: string) => `/artists/${id}`),
  },
  playTrack: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({ playTrack: mocks.playTrack }),
}));
vi.mock('../../components/AlbumCover.js', () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock('../../components/Toast.js', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

const { default: HistoryPage } = await import('../HistoryPage.js');
const { default: FavoritesPage } = await import('../FavoritesPage.js');
const { default: RadioPage } = await import('../RadioPage.js');

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

function renderPage(element: React.ReactNode) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe('list page request ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getRecentAlbums.mockResolvedValue({ data: [] });
    mocks.api.getTopArtists.mockResolvedValue({ data: [] });
    mocks.api.getRadioFeatured.mockResolvedValue({ data: [] });
    mocks.api.getFavorites.mockResolvedValue({ data: [] });
    mocks.api.getFavoriteTracks.mockResolvedValue({ data: [] });
    mocks.api.cacheRadioStation.mockResolvedValue({ data: {} });
    mocks.api.toggleFavorite.mockResolvedValue({ data: { favorited: true } });
  });

  it('prevents duplicate history pages while load-more is in flight', async () => {
    const nextPage = deferred<{
      data: {
        id: number;
        track_id: string;
        album_id: string;
        artist_id: string;
        played_at: string;
        track_title: string;
        album_title: string;
        artist_name: string;
        duration: number;
      }[];
      meta: { page: number; totalPages: number };
    }>();
    const entry = (id: number, title: string) => ({
      id,
      track_id: `track-${id}`,
      album_id: `album-${id}`,
      artist_id: `artist-${id}`,
      played_at: new Date().toISOString(),
      track_title: title,
      album_title: 'Album',
      artist_name: 'Artist',
      duration: 180,
    });
    mocks.api.getHistoryTracks.mockImplementation((page: number) =>
      page === 1
        ? Promise.resolve({
            data: [entry(1, 'First Page Track')],
            meta: { page: 1, totalPages: 2 },
          })
        : nextPage.promise,
    );

    renderPage(<HistoryPage />);
    expect(await screen.findByText('First Page Track')).toBeInTheDocument();

    const loadMore = screen.getByRole('button', { name: 'Load More' });
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);

    expect(mocks.api.getHistoryTracks).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();

    await act(async () => {
      nextPage.resolve({ data: [entry(2, 'Second Page Track')], meta: { page: 2, totalPages: 2 } });
      await nextPage.promise;
    });
    expect(screen.getByText('Second Page Track')).toBeInTheDocument();
  });

  it('does not finish the current favorites tab from an older request', async () => {
    const oldAlbums = deferred<{ data: [] }>();
    const tracks = deferred<{
      data: {
        id: string;
        title: string;
        artistName: string;
        albumTitle: string;
        albumId: string;
      }[];
    }>();
    mocks.api.getFavorites.mockImplementation((type: string) =>
      type === 'album' ? oldAlbums.promise : Promise.resolve({ data: [] }),
    );
    mocks.api.getFavoriteTracks.mockReturnValue(tracks.promise);

    renderPage(<FavoritesPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    await waitFor(() => expect(mocks.api.getFavoriteTracks).toHaveBeenCalledTimes(1));

    await act(async () => {
      oldAlbums.resolve({ data: [] });
      await oldAlbums.promise;
    });
    expect(screen.getByText('Loading...')).toBeInTheDocument();

    await act(async () => {
      tracks.resolve({
        data: [
          {
            id: 'track',
            title: 'Current Favorite Track',
            artistName: 'Artist',
            albumTitle: 'Album',
            albumId: 'album',
          },
        ],
      });
      await tracks.promise;
    });
    expect(screen.getByText('Current Favorite Track')).toBeInTheDocument();
  });

  it('keeps the newest radio search and exposes labeled controls', async () => {
    const oldSearch = deferred<{
      data: { id: string; uuid: string; name: string; streamUrl: string }[];
    }>();
    mocks.api.searchRadio.mockImplementation((query: string) =>
      query === 'old'
        ? oldSearch.promise
        : Promise.resolve({
            data: [
              {
                id: 'radio:new',
                uuid: 'new',
                name: 'New Station',
                streamUrl: 'https://radio.test/new',
              },
            ],
          }),
    );

    renderPage(<RadioPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoeken' }));
    const input = screen.getByPlaceholderText('Zoek NL stations…');
    fireEvent.change(input, { target: { value: 'old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zoek' }));
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zoek' }));

    expect(await screen.findByRole('button', { name: 'Play New Station' })).toBeInTheDocument();
    const favorite = screen.getByRole('button', { name: 'Add New Station to favorites' });
    expect(favorite).toHaveClass('group-focus-within:opacity-100');

    await act(async () => {
      oldSearch.resolve({
        data: [
          {
            id: 'radio:old',
            uuid: 'old',
            name: 'Old Station',
            streamUrl: 'https://radio.test/old',
          },
        ],
      });
      await oldSearch.promise;
    });
    expect(screen.getByRole('button', { name: 'Play New Station' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play Old Station' })).not.toBeInTheDocument();
  });
});

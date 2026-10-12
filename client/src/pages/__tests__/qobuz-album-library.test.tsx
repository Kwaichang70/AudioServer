import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A Qobuz album page (R07.1): "Add to library" when it is not there; once
 * added it is a library album — library data, hearts and stars.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getAlbum: vi.fn(),
    getAlbumTracks: vi.fn(),
    getQobuzAlbum: vi.fn(),
    getQobuzAlbumTracks: vi.fn(),
    getQobuzLibraryState: vi.fn(),
    addQobuzAlbumToLibrary: vi.fn(),
    removeQobuzAlbumFromLibrary: vi.fn(),
    checkFavorite: vi.fn(),
    toggleFavorite: vi.fn(),
    getAlbumCredits: vi.fn(),
    getAlbumVersions: vi.fn(),
    getFavoriteIds: vi.fn(),
    getRatings: vi.fn(),
    getTagsOn: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
  audio: { playAlbum: vi.fn(), playNextTracks: vi.fn(), queueTracks: vi.fn() },
  added: false,
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/PlayActions.js', () => ({
  default: () => null,
  toTrackInfo: <T,>(t: T) => t,
}));
vi.mock('../../components/AlbumCover.js', () => ({ default: () => <div /> }));

const { default: AlbumPage } = await import('../AlbumPage.js');

const album = {
  id: 'qobuz:42',
  title: 'Kind of Blue',
  artistName: 'Miles Davis',
  artistId: 'ar-1',
};
const tracks = [
  {
    id: 'qobuz:1',
    title: 'So What',
    artistName: 'Miles Davis',
    albumTitle: 'Kind of Blue',
    trackNumber: 1,
    discNumber: 1,
    duration: 545,
  },
];

function renderPage() {
  const router = createMemoryRouter([{ path: '/albums/:id', element: <AlbumPage /> }], {
    initialEntries: ['/albums/qobuz:42'],
  });
  return render(<RouterProvider router={router} />);
}

describe('A Qobuz album and the library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.added = false;
    mocks.api.getQobuzLibraryState.mockImplementation(() =>
      Promise.resolve({ data: mocks.added ? ['qobuz:42'] : [] }),
    );
    mocks.api.getQobuzAlbum.mockResolvedValue({ data: album });
    mocks.api.getQobuzAlbumTracks.mockResolvedValue({ data: tracks });
    mocks.api.getAlbum.mockResolvedValue({ data: { ...album, source: 'qobuz' } });
    mocks.api.getAlbumTracks.mockResolvedValue({ data: tracks });
    mocks.api.checkFavorite.mockResolvedValue({ data: { favorited: false } });
    mocks.api.getAlbumCredits.mockResolvedValue({ data: [] });
    mocks.api.getAlbumVersions.mockResolvedValue({ data: null });
    mocks.api.getFavoriteIds.mockResolvedValue({ data: [] });
    mocks.api.getRatings.mockResolvedValue({ data: {} });
    mocks.api.getTagsOn.mockResolvedValue({ data: [] });
    mocks.api.addQobuzAlbumToLibrary.mockImplementation(() => {
      mocks.added = true;
      return Promise.resolve({
        data: {
          albumId: 'qobuz:42',
          title: 'Kind of Blue',
          artistName: 'Miles Davis',
          trackCount: 1,
        },
      });
    });
  });

  it('offers to add an album that is not in the library, then shows it as a library album', async () => {
    renderPage();
    const add = await screen.findByRole('button', { name: '+ Add to library' });
    expect(mocks.api.getQobuzAlbum).toHaveBeenCalledWith('42');
    expect(mocks.api.getAlbum).not.toHaveBeenCalled();
    // No stars on a stream that is not yours yet.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();

    fireEvent.click(add);
    await waitFor(() => expect(mocks.api.addQobuzAlbumToLibrary).toHaveBeenCalledWith('qobuz:42'));
    expect(
      await screen.findByRole('button', { name: 'In library ✓ · Remove' }),
    ).toBeInTheDocument();
    expect(mocks.api.getAlbum).toHaveBeenCalledWith('qobuz:42');
    expect(
      await screen.findByRole('radiogroup', { name: 'Your rating for Kind of Blue' }),
    ).toBeInTheDocument();
  });

  it('asks before removing it again', async () => {
    mocks.added = true;
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'In library ✓ · Remove' }));
    expect(confirm).toHaveBeenCalled();
    expect(mocks.api.removeQobuzAlbumFromLibrary).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

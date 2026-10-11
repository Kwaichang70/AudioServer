import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Focus on the albums page (R05.2): chips with counts, OR within a facet and
 * AND across, the query in the URL, active filters above the list, and
 * "Play all" for exactly what is shown.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getAlbums: vi.fn(),
    getAlbumFacets: vi.fn(),
    getTracks: vi.fn(),
    getSmartPlaylists: vi.fn(),
    createBookmark: vi.fn(),
    createSmartPlaylistFromFocus: vi.fn(),
    setSmartPlaylistDefinition: vi.fn(),
    scanLibrary: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
  audio: { playAlbum: vi.fn() },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/AlbumCover.js', () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));

const { default: AlbumsPage } = await import('../AlbumsPage.js');

const facets = {
  total: 7,
  genre: [
    { value: 'Jazz', count: 5 },
    { value: 'Blues', count: 1 },
    { value: 'Polka', count: 0 },
  ],
  decade: [
    { value: '1950', count: 1 },
    { value: '1970', count: 4 },
  ],
  format: [{ value: 'flac', count: 6 }],
  quality: [
    { value: 'lossless', count: 6 },
    { value: 'hires', count: 3 },
  ],
  source: [{ value: 'local', count: 7 }],
  label: [],
  composer: [],
  favorite: 1,
  unplayed: 3,
};

function renderAt(path: string) {
  const router = createMemoryRouter([{ path: '/albums', element: <AlbumsPage /> }], {
    initialEntries: [path],
  });
  render(<RouterProvider router={router} />);
  return router;
}

const lastAlbumsQuery = () => mocks.api.getAlbums.mock.calls.at(-1)?.[2];

describe('Focus on the albums page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getAlbums.mockResolvedValue({
      data: [{ id: 'al-1', title: 'Thrust', artistName: 'Herbie Hancock' }],
      meta: { page: 1, limit: 50, total: 1, totalPages: 1 },
    });
    mocks.api.getAlbumFacets.mockResolvedValue({ data: facets });
    mocks.api.getSmartPlaylists.mockResolvedValue({
      data: [
        {
          id: 'sp-1',
          name: 'Late night',
          rules: '[]',
          trackCount: 3,
          definition: { groups: ['genre=Blues'], limit: 200 },
        },
      ],
    });
    mocks.api.createBookmark.mockResolvedValue({ data: { id: 'b-1' } });
    mocks.api.createSmartPlaylistFromFocus.mockResolvedValue({ data: { id: 'sp-2' } });
    mocks.api.setSmartPlaylistDefinition.mockResolvedValue({ data: { id: 'sp-1' } });
    mocks.api.getTracks.mockResolvedValue({
      data: [
        { id: 't-1', title: 'Palm Grease', artistName: 'Herbie Hancock', albumId: 'al-1' },
        { id: 't-2', title: 'Gone', artistName: 'Herbie Hancock', availability: 'missing' },
      ],
      meta: { page: 1, limit: 200, total: 2, totalPages: 1 },
    });
  });

  it('builds "hi-res jazz from the seventies I never played" with counts, in the URL', async () => {
    const router = renderAt('/albums');
    await screen.findAllByText('Thrust');
    expect(lastAlbumsQuery()).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    const panel = await screen.findByRole('dialog', { name: 'Focus' });
    // Counts on the chips; a value that gives nothing is not offered.
    expect(within(panel).getByRole('button', { name: /Jazz\s*5/ })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Polka/ })).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: /Jazz/ }));
    await waitFor(() => expect(lastAlbumsQuery()).toBe('genre=Jazz'));
    // The panel stays open while you tap.
    expect(screen.getByRole('dialog', { name: 'Focus' })).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: /1970s/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /Hi-Res/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /Never played/ }));
    await waitFor(() =>
      expect(lastAlbumsQuery()).toBe(
        'yearFrom=1970&yearTo=1979&quality=hires&unplayed=true&genre=Jazz',
      ),
    );
    expect(mocks.api.getAlbumFacets).toHaveBeenLastCalledWith(lastAlbumsQuery());
    expect(router.state.location.search).toContain('genre=Jazz');
    expect(router.state.location.search).toContain('quality=hires');

    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    const active = screen.getByRole('list', { name: 'Active filters' });
    expect(
      within(active)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Hi-Res ×', 'Jazz ×', '1970s ×', 'Never played ×', 'Clear all']);
    expect(screen.getByRole('button', { name: 'Focus · 4' })).toBeInTheDocument();
  });

  it('removes one filter from its chip, and all with "Clear all"', async () => {
    renderAt('/albums?genre=Jazz&genre=Blues&sort=year');
    await screen.findAllByText('Thrust');
    expect(lastAlbumsQuery()).toBe('sort=year&genre=Blues&genre=Jazz');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Blues' }));
    await waitFor(() => expect(lastAlbumsQuery()).toBe('sort=year&genre=Jazz'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    // The sort is not a filter: it stays.
    await waitFor(() => expect(lastAlbumsQuery()).toBe('sort=year'));
  });

  it('plays exactly the filtered tracks, skipping missing files', async () => {
    renderAt('/albums?quality=hires&sort=year');
    await screen.findAllByText('Thrust');
    fireEvent.click(screen.getByRole('button', { name: /Play all/ }));
    await waitFor(() => expect(mocks.audio.playAlbum).toHaveBeenCalled());
    expect(mocks.api.getTracks).toHaveBeenCalledWith(1, 200, 'quality=hires&sort=year');
    const [list, index] = mocks.audio.playAlbum.mock.calls[0];
    expect(list.map((t: { id: string }) => t.id)).toEqual(['t-1']);
    expect(index).toBe(0);
  });

  it('says so when nothing matches', async () => {
    mocks.api.getAlbums.mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
    renderAt('/albums?genre=Polka');
    expect(await screen.findByText('No albums match this Focus.')).toBeInTheDocument();
  });

  describe('saving a Focus (R05.3)', () => {
    const QUERY = 'sort=year&order=desc&quality=hires&unplayed=true&genre=Jazz';

    it('bookmarks this page with this question and tells the sidebar', async () => {
      const changed = vi.fn();
      window.addEventListener('audioserver:bookmarks-changed', changed);
      renderAt(`/albums?${QUERY}`);
      await screen.findAllByText('Thrust');
      fireEvent.click(screen.getByRole('button', { name: /Save/ }));
      const form = screen.getByRole('form', { name: 'Save this Focus' });
      // The name is suggested from the active filters.
      expect(within(form).getByRole('textbox')).toHaveValue('Hi-Res, Jazz, Never played');
      fireEvent.change(within(form).getByRole('textbox'), {
        target: { value: 'Seventies hi-res' },
      });
      fireEvent.click(within(form).getByRole('button', { name: 'Bookmark' }));
      await waitFor(() =>
        expect(mocks.api.createBookmark).toHaveBeenCalledWith('Seventies hi-res', '/albums', QUERY),
      );
      await waitFor(() => expect(changed).toHaveBeenCalled());
      expect(await screen.findByText('Bookmarked as “Seventies hi-res”.')).toBeInTheDocument();
      window.removeEventListener('audioserver:bookmarks-changed', changed);
    });

    it('stores the tracks behind the page as a smart playlist', async () => {
      renderAt(`/albums?${QUERY}`);
      await screen.findAllByText('Thrust');
      fireEvent.click(screen.getByRole('button', { name: /Save/ }));
      fireEvent.click(screen.getByRole('button', { name: 'New smart playlist' }));
      await waitFor(() => expect(mocks.api.createSmartPlaylistFromFocus).toHaveBeenCalled());
      expect(mocks.api.createSmartPlaylistFromFocus).toHaveBeenCalledWith(
        'Hi-Res, Jazz, Never played',
        {
          groups: ['quality=hires&unplayed=true&genre=Jazz'],
          sort: 'year',
          order: 'desc',
        },
      );
    });

    it('adds the question to an existing smart playlist as an OR group', async () => {
      renderAt(`/albums?${QUERY}`);
      await screen.findAllByText('Thrust');
      fireEvent.click(screen.getByRole('button', { name: /Save/ }));
      const select = await screen.findByRole('combobox', { name: 'Smart playlist to add to' });
      fireEvent.change(select, { target: { value: 'sp-1' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add (OR)' }));
      await waitFor(() =>
        expect(mocks.api.setSmartPlaylistDefinition).toHaveBeenCalledWith('sp-1', {
          groups: ['genre=Blues', 'quality=hires&unplayed=true&genre=Jazz'],
          limit: 200,
        }),
      );
    });
  });
});

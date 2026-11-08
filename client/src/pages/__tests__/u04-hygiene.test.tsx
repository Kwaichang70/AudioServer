import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  toast: vi.fn(),
  api: {
    getAlbums: vi.fn(),
    getAlbumFacets: vi.fn(),
    scanLibrary: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => ({}) }));
vi.mock('../../context/AuthContext.js', () => ({ useAuth: () => ({ isAdmin: mocks.isAdmin }) }));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: AlbumsPage } = await import('../AlbumsPage.js');
const { default: AlbumCover } = await import('../../components/AlbumCover.js');

function renderAlbums() {
  return render(
    <MemoryRouter initialEntries={['/albums']}>
      <AlbumsPage />
    </MemoryRouter>,
  );
}

/**
 * U04: the interface offers only what works for the person using it, and a
 * stand-in cover is still readable and named.
 */
describe('U04 interface hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAdmin = true;
    mocks.api.getAlbums.mockResolvedValue({
      data: [],
      meta: { page: 1, limit: 50, total: 0, totalPages: 0 },
    });
    mocks.api.getAlbumFacets.mockResolvedValue({ data: { total: 0 } });
  });

  it('offers an admin the library scan', async () => {
    mocks.api.scanLibrary.mockResolvedValue({});
    renderAlbums();

    await screen.findByText('No albums found in your library.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Scan Library' })[0]);

    await waitFor(() => expect(mocks.api.scanLibrary).toHaveBeenCalled());
    expect(mocks.toast).toHaveBeenCalledWith('Library scan started', 'info');
  });

  it('says so when a scan cannot start, instead of nothing', async () => {
    mocks.api.scanLibrary.mockRejectedValue(new Error('A scan is already running'));
    renderAlbums();

    await screen.findByText('No albums found in your library.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Scan Library' })[0]);

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith('Scan failed: A scan is already running', 'error'),
    );
  });

  it('does not offer a regular user a scan the server would refuse', async () => {
    mocks.isAdmin = false;
    renderAlbums();

    await screen.findByText('Ask an administrator to scan the library.');
    expect(screen.queryByRole('button', { name: 'Scan Library' })).not.toBeInTheDocument();
  });

  it('names a cover without art and keeps its text readable', () => {
    render(
      <AlbumCover albumId="a1" title="Kind of Blue" artistName="Miles Davis" hasCover={false} />,
    );

    const cover = screen.getByRole('img', { name: 'Kind of Blue' });
    expect(cover).toHaveClass('text-white');
    expect(screen.getByText('Miles Davis')).toHaveClass('text-white/80');
  });
});

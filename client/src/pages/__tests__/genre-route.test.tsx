import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B15: a genre name is decoded once, by the router. "100%", a literal
 * "R%26B", Unicode and a slash all open their own page.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getGenres: vi.fn(),
    getGenreAlbums: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
}));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({ playAlbum: vi.fn() }),
}));

const { default: GenresPage } = await import('../GenresPage.js');

function open(genre: string) {
  const router = createMemoryRouter([{ path: '/genres/:genre', element: <GenresPage /> }], {
    initialEntries: [`/genres/${encodeURIComponent(genre)}`],
  });
  render(<RouterProvider router={router} />);
}

describe('genre pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getGenreAlbums.mockResolvedValue({ data: [], meta: { total: 0 } });
  });

  for (const genre of ['100%', 'R%26B', 'Música Popular', 'Rock/Pop']) {
    it(`opens "${genre}" without an error`, async () => {
      open(genre);
      await waitFor(() => expect(mocks.api.getGenreAlbums).toHaveBeenCalled());
      expect(mocks.api.getGenreAlbums.mock.calls[0][0]).toBe(genre);
      expect(screen.queryByText(/something went wrong/i)).toBeNull();
    });
  }
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    providerSearch: vi.fn(),
    search: vi.fn(),
    getTrackCoverUrl: vi.fn((id: string) => `/covers/track/${id}`),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
  playTrack: vi.fn(),
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({ playTrack: mocks.playTrack }),
}));

const { default: SearchPage } = await import('../SearchPage.js');

const localBlue = {
  id: 't1',
  title: 'Blue',
  artistName: 'Band',
  albumTitle: 'Album',
  albumId: 'al1',
  duration: 200,
  source: 'local',
  availableOn: ['local', 'qobuz'],
  alternatives: [
    { source: 'local', id: 't1', albumId: 'al1', duration: 200 },
    { source: 'qobuz', id: 'qobuz:99', albumId: 'qobuz:al', duration: 202 },
  ],
  playability: { playable: true, browser: true, server: true, external: false },
};

const liveMissing = {
  id: 't4',
  title: 'Blue (Live)',
  version: 'Live',
  artistName: 'Band',
  albumTitle: 'Album',
  albumId: 'al1',
  source: 'local',
  availability: 'missing',
  availableOn: ['local'],
  alternatives: [{ source: 'local', id: 't4' }],
  playability: {
    playable: false,
    browser: false,
    server: false,
    external: false,
    reason: 'missing-file',
  },
};

/** V07.2 / V07.4 in the UI: source choice with the other source's id, playability, source status. */
describe('SearchPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.providerSearch.mockResolvedValue({
      data: {
        artists: [],
        albums: [],
        playlists: [],
        tracks: [localBlue, liveMissing],
        sources: [
          {
            source: 'local',
            status: 'ok',
            ms: 3,
            counts: { artists: 0, albums: 0, tracks: 2, playlists: 0 },
          },
          { source: 'qobuz', status: 'timeout', ms: 6000 },
        ],
      },
    });
  });

  it('plays the alternative with that source’s own id and shows versions, missing files and source status', async () => {
    render(
      <MemoryRouter initialEntries={['/search?q=blue']}>
        <SearchPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument());
    expect(screen.getByText('missing')).toBeInTheDocument();
    expect(screen.getByTestId('search-source-status')).toHaveTextContent(
      'qobuz: no answer within 6 s',
    );

    fireEvent.click(screen.getByTitle('Play from qobuz'));
    expect(mocks.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'qobuz:99',
        source: 'qobuz',
        albumId: 'qobuz:al',
        title: 'Blue',
      }),
    );

    // The missing live file cannot be started.
    const liveButton = screen.getByRole('button', { name: 'Play Blue (Live) (Live)' });
    expect(liveButton).toBeDisabled();
  });

  it('sends the selected sources and quality as filters', async () => {
    render(
      <MemoryRouter initialEntries={['/search?q=blue']}>
        <SearchPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mocks.api.providerSearch).toHaveBeenCalled());
    expect(mocks.api.providerSearch).toHaveBeenLastCalledWith('blue', {
      quality: undefined,
      sources: undefined,
    });

    fireEvent.click(screen.getByRole('button', { name: 'spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hi-Res' }));
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(mocks.api.providerSearch).toHaveBeenLastCalledWith('blue', {
        quality: 'hires',
        sources: ['local', 'qobuz', 'tidal'],
      }),
    );
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Home as an overview (R08.2): every block has something to play. */

const mocks = vi.hoisted(() => ({
  api: {
    getStats: vi.fn(),
    getHome: vi.fn(),
    listenbrainzDiscover: vi.fn(),
    getTopArtists: vi.fn(),
    getHealth: vi.fn(),
    getAlbumTracks: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
  audio: {
    playAlbum: vi.fn(),
    startRadio: vi.fn(() => Promise.resolve()),
    seek: vi.fn(),
    currentTrack: null as { id: string } | null,
    isPlaying: false,
  },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/AlbumCover.js', () => ({ default: () => <div /> }));
vi.mock('../../components/GettingStarted.js', () => ({ default: () => null }));
vi.mock('../../components/PlayActions.js', () => ({
  CardActions: () => null,
  shuffledCopy: <T,>(list: T[]) => [...list].reverse(),
}));

const { default: HomePage } = await import('../HomePage.js');

const mixItem = (id: string, title: string) => ({
  id,
  title,
  artistName: 'Bill Evans',
  albumTitle: 'Sunday',
  albumId: 'al-1',
  duration: 300,
  source: 'local',
  why: 'You played Bill Evans 6 times in the last six months.',
  basis: 'history',
});

describe('Home', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getStats.mockResolvedValue({ data: { artists: 3, albums: 3, tracks: 12 } });
    mocks.api.getTopArtists.mockResolvedValue({ data: [] });
    mocks.api.getHealth.mockResolvedValue({});
    mocks.api.getHome.mockResolvedValue({
      data: {
        continueListening: [
          {
            albumId: 'al-1',
            title: 'Sunday',
            artistName: 'Bill Evans',
            coverUrl: null,
            lastPlayed: 1,
            resumeTrackId: 't3',
            resumeTitle: 'Jade Visions',
            resumePosition: 120,
            progress: 0.4,
          },
        ],
        newInLibrary: [
          {
            id: 'al-9',
            title: 'Thrust',
            artistName: 'Herbie Hancock',
            coverUrl: null,
            source: 'qobuz',
            createdAt: 1,
          },
        ],
        genresForYou: [{ genre: 'Jazz', plays: 6, albumIds: ['al-1'] }],
        dailyMix: {
          date: '2026-10-12',
          basis: 'Built from your listening history.',
          items: [mixItem('m1', 'Gloria’s Step'), mixItem('m2', 'Alice in Wonderland')],
        },
      },
    });
    mocks.api.listenbrainzDiscover.mockResolvedValue({
      data: {
        configured: true,
        freshReleases: [],
        playlists: [
          {
            title: 'Weekly',
            why: 'x',
            tracks: [
              {
                title: 'In the library',
                artist: 'A',
                localTrackId: 'lt-1',
                localAlbumId: null,
                match: null,
                why: 'x',
              },
              {
                title: 'Not here',
                artist: 'B',
                localTrackId: null,
                localAlbumId: null,
                match: null,
                why: 'x',
              },
            ],
          },
        ],
      },
    });
    mocks.api.getAlbumTracks.mockResolvedValue({
      data: [
        { id: 't1', title: 'One' },
        { id: 't2', title: 'Two', availability: 'missing' },
        { id: 't3', title: 'Jade Visions' },
      ],
    });
  });

  it('continues an album at the track you stopped in, and seeks there once it plays', async () => {
    const view = render(<HomePage />, { wrapper: MemoryRouter });
    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue Sunday with Jade Visions' }),
    );
    await waitFor(() => expect(mocks.audio.playAlbum).toHaveBeenCalled());
    const [list, index] = mocks.audio.playAlbum.mock.calls[0];
    expect(list.map((t: { id: string }) => t.id)).toEqual(['t1', 't3']);
    expect(index).toBe(1);
    mocks.audio.currentTrack = { id: 't3' };
    mocks.audio.isPlaying = true;
    view.rerender(<HomePage />);
    expect(mocks.audio.seek).toHaveBeenCalledWith(120);
    mocks.audio.currentTrack = null;
    mocks.audio.isPlaying = false;
  });

  it('plays today’s mix and says why on request', async () => {
    render(<HomePage />, { wrapper: MemoryRouter });
    const block = await screen.findByTestId('home-daily-mix');
    expect(within(block).queryByText(/You played Bill Evans/)).not.toBeInTheDocument();
    fireEvent.click(within(block).getByRole('button', { name: 'Why these?' }));
    expect(within(block).getAllByText(/You played Bill Evans/)).toHaveLength(2);
    fireEvent.click(within(block).getByRole('button', { name: /▶ Play/ }));
    expect(mocks.audio.playAlbum.mock.calls[0][0].map((t: { id: string }) => t.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('shows only the ListenBrainz suggestions you can play', async () => {
    render(<HomePage />, { wrapper: MemoryRouter });
    const block = await screen.findByTestId('home-for-you');
    expect(within(block).getByText('In the library')).toBeInTheDocument();
    expect(within(block).queryByText('Not here')).not.toBeInTheDocument();
  });

  it('starts genre radio from a genre tile and lists new albums with their source', async () => {
    render(<HomePage />, { wrapper: MemoryRouter });
    fireEvent.click(await screen.findByRole('button', { name: 'Start Jazz radio' }));
    expect(mocks.audio.startRadio).toHaveBeenCalledWith({ type: 'genre', id: 'Jazz' });
    expect(within(screen.getByTestId('home-new')).getByText('Qobuz')).toBeInTheDocument();
  });

  it('still has a daily mix without a ListenBrainz account', async () => {
    mocks.api.listenbrainzDiscover.mockResolvedValue({
      data: { configured: false, freshReleases: [], playlists: [] },
    });
    render(<HomePage />, { wrapper: MemoryRouter });
    expect(await screen.findByTestId('home-daily-mix')).toBeInTheDocument();
    expect(screen.queryByTestId('home-for-you')).not.toBeInTheDocument();
  });
});

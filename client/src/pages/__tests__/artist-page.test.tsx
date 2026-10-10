import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The artist page (R04.2): biography with source and licence, the four
 * discography sections, the listener's top tracks, and radio that says it is
 * not there yet instead of doing nothing.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getArtist: vi.fn(),
    getArtistDiscography: vi.fn(),
    getArtistBio: vi.fn(),
    getArtistTopTracks: vi.fn(),
    getSimilarArtists: vi.fn(),
    checkFavorite: vi.fn(),
    toggleFavorite: vi.fn(),
    getArtistTracks: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
    getArtistImageUrl: vi.fn((id: string) => `/artists/${id}/image`),
  },
  audio: { playAlbum: vi.fn() },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/PlayActions.js', () => ({
  default: () => null,
  CardActions: () => null,
  openRowMenuFromKey: () => {},
  openRowMenuFromPointer: () => {},
  shuffledCopy: <T,>(list: T[]) => list,
  toTrackInfo: <T,>(t: T) => t,
}));

const { default: ArtistPage } = await import('../ArtistPage.js');

const release = (id: string, title: string, year: number, extra = {}) => ({
  id,
  title,
  artistName: 'The Main Act',
  year,
  releaseDate: null,
  trackCount: 10,
  duration: 2400,
  format: 'flac',
  sampleRate: 44100,
  bitDepth: 16,
  isCompilation: false,
  ...extra,
});

function renderPage() {
  const router = createMemoryRouter([{ path: '/artists/:id', element: <ArtistPage /> }], {
    initialEntries: ['/artists/ar-1'],
  });
  return render(<RouterProvider router={router} />);
}

describe('ArtistPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getArtist.mockResolvedValue({ data: { id: 'ar-1', name: 'The Main Act' } });
    mocks.api.getArtistDiscography.mockResolvedValue({
      data: {
        albums: [release('al-2', 'Zebra', 2005), release('al-1', 'Apple', 2010)],
        singles: [release('al-3', 'Short', 2003, { trackCount: 3 })],
        compilations: [],
        appearsOn: [
          release('al-4', 'Their Record', 2008, {
            artistName: 'Someone Else',
            roles: ['featured', 'producer'],
          }),
        ],
      },
    });
    mocks.api.getArtistBio.mockResolvedValue({
      data: {
        artistId: 'ar-1',
        summary: 'A band from Utrecht.',
        source: 'wikipedia',
        language: 'nl',
        url: 'https://nl.wikipedia.org/wiki/X',
        license: 'CC BY-SA 4.0 — Wikipedia',
        fetchedAt: 1,
      },
    });
    mocks.api.getArtistTopTracks.mockResolvedValue({
      data: [
        {
          id: 't-1',
          title: 'The Hit',
          artistName: 'The Main Act',
          albumTitle: 'Apple',
          albumId: 'al-1',
          duration: 200,
          format: 'flac',
          plays: 7,
        },
      ],
    });
    mocks.api.getSimilarArtists.mockResolvedValue({ data: { available: true, similar: [] } });
    mocks.api.checkFavorite.mockResolvedValue({ data: { favorited: false } });
  });

  it('shows the biography with its source and licence', async () => {
    renderPage();
    expect(await screen.findByText('A band from Utrecht.')).toBeTruthy();
    expect(screen.getByText('Wikipedia (nl)').closest('a')?.getAttribute('href')).toBe(
      'https://nl.wikipedia.org/wiki/X',
    );
    expect(screen.getByText('CC BY-SA 4.0 — Wikipedia')).toBeTruthy();
  });

  it('splits the discography and shows the roles on someone else’s record', async () => {
    renderPage();
    expect(await screen.findByText('Albums')).toBeTruthy();
    expect(screen.getByText('Singles & EPs')).toBeTruthy();
    expect(screen.getByText('Appears on')).toBeTruthy();
    expect(screen.getByText(/Someone Else · featured, producer/)).toBeTruthy();
  });

  it('sorts by year or by title', async () => {
    renderPage();
    await screen.findByText('Zebra');
    // Within the Albums section only: "Apple" is also a top track's album.
    const titles = () => {
      const section = screen.getByText('Albums').closest('section') as HTMLElement;
      return within(section)
        .getAllByText(/^(Apple|Zebra)$/)
        .map((el) => el.textContent);
    };
    expect(titles()).toEqual(['Zebra', 'Apple']);
    fireEvent.click(screen.getByText('By title'));
    expect(titles()).toEqual(['Apple', 'Zebra']);
  });

  it("plays from the listener's top tracks", async () => {
    renderPage();
    fireEvent.click(await screen.findByText('The Hit'));
    await waitFor(() => expect(mocks.audio.playAlbum).toHaveBeenCalled());
    const [queue, index] = mocks.audio.playAlbum.mock.calls[0];
    expect(queue.map((t: { id: string }) => t.id)).toEqual(['t-1']);
    expect(index).toBe(0);
  });

  it('shows radio as not available yet rather than a button that does nothing', async () => {
    renderPage();
    const radio = await screen.findByText('Start radio');
    expect((radio as HTMLButtonElement).disabled ?? radio.closest('button')?.disabled).toBe(true);
  });
});

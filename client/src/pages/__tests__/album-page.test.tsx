import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The album page additions of R04.3: release data, credits with links, the
 * Versions section (a FLAC and an MP3 of the same album both listed, a Qobuz
 * version in higher resolution startable from here) and classical tracks
 * grouped under their work.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getAlbum: vi.fn(),
    getAlbumTracks: vi.fn(),
    getQobuzAlbumTracks: vi.fn(),
    checkFavorite: vi.fn(),
    toggleFavorite: vi.fn(),
    getAlbumCredits: vi.fn(),
    getAlbumVersions: vi.fn(),
    getAlbumCoverUrl: vi.fn((id: string) => `/covers/${id}`),
  },
  audio: {
    playAlbum: vi.fn(),
    playNextTracks: vi.fn(),
    queueTracks: vi.fn(),
    currentTrack: null,
    isPlaying: false,
  },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));
vi.mock('../../components/PlayActions.js', () => ({
  default: () => null,
  toTrackInfo: <T,>(t: T) => t,
}));
vi.mock('../../components/AlbumCover.js', () => ({ default: () => <div /> }));

const { default: AlbumPage } = await import('../AlbumPage.js');

const track = (id: string, title: string, extra = {}) => ({
  id,
  title,
  artistName: 'The Orchestra',
  albumTitle: 'Symphony No. 5',
  albumId: 'al-flac',
  trackNumber: 1,
  discNumber: 1,
  duration: 300,
  ...extra,
});

function renderPage() {
  const router = createMemoryRouter([{ path: '/albums/:id', element: <AlbumPage /> }], {
    initialEntries: ['/albums/al-flac'],
  });
  return render(<RouterProvider router={router} />);
}

describe('AlbumPage (R04.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getAlbum.mockResolvedValue({
      data: {
        id: 'al-flac',
        title: 'Symphony No. 5',
        artistName: 'The Orchestra',
        year: 1993,
        releaseDate: '1993-04-01',
        label: 'Deutsche Grammophon',
        catalogNumber: '437 789-2',
        format: 'flac',
        sampleRate: 44100,
        bitDepth: 16,
      },
    });
    mocks.api.getAlbumTracks.mockResolvedValue({
      data: [
        track('t-1', 'Symphony No. 5: I. Trauermarsch', {
          work: 'Symphony No. 5',
          movement: 'I. Trauermarsch',
        }),
        track('t-2', 'Symphony No. 5: IV. Adagietto', {
          trackNumber: 2,
          work: 'Symphony No. 5',
          movement: 'IV. Adagietto',
        }),
      ],
    });
    mocks.api.checkFavorite.mockResolvedValue({ data: { favorited: false } });
    mocks.api.getAlbumCredits.mockResolvedValue({
      data: [
        { role: 'composer', people: [{ artistId: 'ar-mahler', name: 'Gustav Mahler', tracks: 2 }] },
        {
          role: 'conductor',
          people: [{ artistId: 'ar-abbado', name: 'Claudio Abbado', tracks: 2 }],
        },
      ],
    });
    mocks.api.getAlbumVersions.mockResolvedValue({
      data: {
        local: [
          {
            id: 'al-mp3',
            title: 'Symphony No. 5',
            format: 'mp3',
            sampleRate: 44100,
            bitDepth: null,
            trackCount: 2,
            label: null,
            releaseDate: null,
            matchedBy: 'title',
          },
        ],
        streaming: [
          {
            id: 'qobuz:111',
            source: 'qobuz',
            title: 'Symphony No. 5',
            artistName: 'The Orchestra',
            sampleRate: 96000,
            bitDepth: 24,
            trackCount: 2,
            year: 2015,
            higherResolution: true,
          },
        ],
        sources: { qobuz: 'ok' },
      },
    });
    mocks.api.getQobuzAlbumTracks.mockResolvedValue({
      data: [track('qobuz:t1', 'I. Trauermarsch', { albumId: 'qobuz:111' })],
    });
  });

  it('shows the release date, label and catalogue number', async () => {
    renderPage();
    expect((await screen.findByTestId('release-line')).textContent).toBe(
      '1993-04-01 · Deutsche Grammophon · 437 789-2',
    );
  });

  it('lists the credits with links to each person', async () => {
    renderPage();
    const composer = await screen.findByText('Gustav Mahler');
    expect(composer.closest('a')?.getAttribute('href')).toBe('/artists/ar-mahler');
    expect(screen.getByText('Conductor')).toBeTruthy();
  });

  it('groups classical tracks under their work and names the movement', async () => {
    renderPage();
    expect(await screen.findByRole('rowheader', { name: 'Symphony No. 5' })).toBeTruthy();
    expect(screen.getByText('IV. Adagietto')).toBeTruthy();
    expect(screen.queryByText('Symphony No. 5: IV. Adagietto')).toBeNull();
  });

  it('lists the MP3 edition and starts the Qobuz version in higher resolution', async () => {
    renderPage();
    const section = await screen.findByTestId('album-versions');
    expect(section.textContent).toMatch(/library/);
    expect(section.textContent).toMatch(/higher resolution/);

    fireEvent.click(screen.getByLabelText('Play Symphony No. 5 on Qobuz'));
    await waitFor(() => expect(mocks.api.getQobuzAlbumTracks).toHaveBeenCalledWith('111'));
    await waitFor(() => expect(mocks.audio.playAlbum).toHaveBeenCalled());
    expect(mocks.audio.playAlbum.mock.calls[0][0][0].id).toBe('qobuz:t1');
  });

  it('says when Qobuz did not answer in time', async () => {
    mocks.api.getAlbumVersions.mockResolvedValue({
      data: {
        local: [
          {
            id: 'al-mp3',
            title: 'Symphony No. 5',
            format: 'mp3',
            sampleRate: 44100,
            bitDepth: null,
            trackCount: 2,
            label: null,
            releaseDate: null,
            matchedBy: 'title',
          },
        ],
        streaming: [],
        sources: { qobuz: 'timeout' },
      },
    });
    renderPage();
    expect(await screen.findByText('Qobuz did not answer in time.')).toBeTruthy();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Discover (V12.2). A recommendation is only playable when the server is
 * certain which local recording it is, the basis of every item is on screen,
 * and the personal basis can be switched off from here.
 */

const mocks = vi.hoisted(() => ({
  api: {
    listenbrainzDiscover: vi.fn(),
    getRecommendationMix: vi.fn(),
    getRecommendationSettings: vi.fn(),
    updateRecommendationSettings: vi.fn(),
    saveRecommendationMix: vi.fn(),
  },
  audio: { playAlbum: vi.fn(), playTrack: vi.fn() },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({ useAudioContext: () => mocks.audio }));

const { default: DiscoverPage } = await import('../DiscoverPage.js');

const mixItem = {
  id: 'track-1',
  title: 'Deep Cut',
  artistName: 'Known Artist',
  albumTitle: 'Early',
  albumId: 'al-1',
  duration: 200,
  source: 'local' as const,
  why: 'You played Known Artist 4 times in the last six months.',
  basis: 'history' as const,
};

const discover = {
  configured: true,
  freshReleases: [],
  playlists: [
    {
      title: 'Weekly Jams',
      why: 'ListenBrainz made "Weekly Jams" from the listening you scrobbled.',
      tracks: [
        {
          title: 'Certain Song',
          artist: 'Known Artist',
          localTrackId: 'track-9',
          localAlbumId: 'al-1',
          match: {
            trackId: 'track-9',
            albumId: 'al-1',
            title: 'Certain Song',
            artistName: 'Known Artist',
            albumTitle: 'Early',
            duration: 180,
            certainty: 'certain' as const,
            playable: true,
            note: 'Title and artist match your library exactly.',
          },
          why: 'From "Weekly Jams".',
        },
        {
          title: 'Maybe Song',
          artist: 'Known Artist',
          localTrackId: null,
          localAlbumId: 'al-1',
          match: {
            trackId: 'track-8',
            albumId: 'al-1',
            title: 'Maybe Song (Live)',
            artistName: 'Known Artist',
            albumTitle: 'Early',
            duration: 190,
            certainty: 'probable' as const,
            playable: false,
            note: 'It is not started automatically.',
          },
          why: 'From "Weekly Jams".',
        },
      ],
    },
  ],
};

describe('Discover page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.listenbrainzDiscover.mockResolvedValue({ data: discover });
    mocks.api.getRecommendationMix.mockResolvedValue({
      data: [mixItem],
      meta: { total: 1, basis: 'Built from the artists you played.', personalised: true },
    });
    mocks.api.getRecommendationSettings.mockResolvedValue({
      data: { useHistory: true, useFavorites: true },
    });
    mocks.api.updateRecommendationSettings.mockResolvedValue({
      data: { useHistory: false, useFavorites: false },
    });
    mocks.api.saveRecommendationMix.mockResolvedValue({
      data: { id: 'pl-9', name: 'Mix of 2026-09-18' },
      meta: { saved: 1, skipped: 0 },
    });
  });

  it('shows the local mix with the basis of each item', async () => {
    render(
      <MemoryRouter>
        <DiscoverPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Deep Cut')).toBeTruthy();
    expect(screen.getByText('Built from the artists you played.')).toBeTruthy();
    expect(screen.getByText(/played Known Artist 4 times/)).toBeTruthy();
  });

  it('plays a certain match and refuses to play a probable one', async () => {
    render(
      <MemoryRouter>
        <DiscoverPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Certain Song')).toBeTruthy();
    expect(screen.getByLabelText('Play Certain Song')).toBeTruthy();
    expect(screen.queryByLabelText('Play Maybe Song')).toBeNull();
    expect(screen.getByText('It is not started automatically.')).toBeTruthy();

    screen.getByLabelText('Play Certain Song').click();
    expect(mocks.audio.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'track-9', source: 'local' }),
    );
  });

  it('switches the personal basis off and reloads the mix', async () => {
    render(
      <MemoryRouter>
        <DiscoverPage />
      </MemoryRouter>,
    );
    await screen.findByText(/Use my listening history/);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() =>
      expect(mocks.api.updateRecommendationSettings).toHaveBeenCalledWith({
        useHistory: false,
        useFavorites: false,
      }),
    );
    expect(mocks.api.getRecommendationMix).toHaveBeenCalledTimes(2);
  });

  it('keeps a mix by saving it as a playlist', async () => {
    render(
      <MemoryRouter>
        <DiscoverPage />
      </MemoryRouter>,
    );
    const save = await screen.findByText('Save as playlist');
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.api.saveRecommendationMix).toHaveBeenCalledWith(expect.any(String), ['track-1']),
    );
    expect(await screen.findByText('Mix of 2026-09-18')).toBeTruthy();
  });
});

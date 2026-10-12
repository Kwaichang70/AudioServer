import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The heart everywhere (R06.3): one request per type fills every heart, and
 * a toggle in one place is the same heart in all the others.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getFavoriteIds: vi.fn(),
    toggleFavorite: vi.fn(),
    checkFavorite: vi.fn(),
  },
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({
    playAlbum: vi.fn(),
    playNow: vi.fn(),
    playNextTracks: vi.fn(),
    queueTracks: vi.fn(),
  }),
}));
vi.mock('../Toast.js', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { default: FavoriteButton } = await import('../FavoriteButton.js');
const { CardActions } = await import('../PlayActions.js');
const { noteFavorite, resetFavorites } = await import('../../hooks/useFavorite.js');

describe('The heart everywhere', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFavorites();
    mocks.api.getFavoriteIds.mockImplementation((type: string) =>
      Promise.resolve({ data: type === 'track' ? ['t-1'] : [] }),
    );
    mocks.api.toggleFavorite.mockResolvedValue({ data: { favorited: false } });
  });

  it('fills a whole list from one request per type', async () => {
    render(
      <>
        {['t-1', 't-2', 't-3'].map((id) => (
          <FavoriteButton key={id} kind="track" id={id} title={id} />
        ))}
      </>,
    );
    expect(
      await screen.findByRole('button', { name: 'Remove t-1 from favorites' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Add t-2 to favorites' })).toBeInTheDocument();
    expect(mocks.api.getFavoriteIds).toHaveBeenCalledTimes(1);
  });

  it('is the same heart in the player bar and in the queue', async () => {
    render(
      <>
        <div data-testid="bar">
          <FavoriteButton kind="track" id="t-1" title="So What" />
        </div>
        <div data-testid="queue">
          <FavoriteButton kind="track" id="t-1" title="So What" />
        </div>
      </>,
    );
    const hearts = await screen.findAllByRole('button', { name: 'Remove So What from favorites' });
    expect(hearts).toHaveLength(2);
    fireEvent.click(hearts[0]);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Add So What to favorites' })).toHaveLength(2),
    );
    expect(mocks.api.toggleFavorite).toHaveBeenCalledWith('track', 't-1');
  });

  it('does not play the row it sits in', async () => {
    const play = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
      <div onClick={play}>
        <FavoriteButton kind="track" id="t-2" title="Blue" />
      </div>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add Blue to favorites' }));
    expect(play).not.toHaveBeenCalled();
  });

  it('shows no heart for an item without a library id', () => {
    render(<FavoriteButton kind="track" id="qobuz:123" title="Stream" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('puts a heart on album cards that follows a toggle made elsewhere', async () => {
    render(
      <div className="group relative" data-play-actions-row>
        <CardActions target={{ kind: 'album', albumId: 'al-1', title: 'Kind of Blue' }} />
      </div>,
    );
    expect(
      await screen.findByRole('button', { name: 'Add Kind of Blue to favorites' }),
    ).toHaveAttribute('tabindex', '-1');
    act(() => noteFavorite('album', 'al-1', true));
    expect(
      screen.getByRole('button', { name: 'Remove Kind of Blue from favorites' }),
    ).toBeInTheDocument();
  });
});

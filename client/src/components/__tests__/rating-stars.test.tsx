import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Ratings (R06.4): stars from one shared map; the set star again clears. */

const mocks = vi.hoisted(() => ({
  api: { getRatings: vi.fn(), setRating: vi.fn() },
}));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));

const { default: RatingStars } = await import('../RatingStars.js');
const { resetRatings } = await import('../../hooks/useRating.js');
const { activeFilters } = await import('../../utils/focus.js');

describe('RatingStars', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRatings();
    mocks.api.getRatings.mockResolvedValue({ data: { 'al-1': 3 } });
    mocks.api.setRating.mockResolvedValue({ data: {} });
  });

  it('shows your rating and changes it, everywhere at once', async () => {
    render(
      <>
        <RatingStars kind="album" id="al-1" title="Kind of Blue" />
        <RatingStars kind="album" id="al-1" title="Kind of Blue" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('radio', { name: '3 stars' })[0]).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(mocks.api.getRatings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByRole('radio', { name: '5 stars' })[0]);
    await waitFor(() =>
      expect(screen.getAllByRole('radio', { name: '5 stars' })[1]).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(mocks.api.setRating).toHaveBeenCalledWith('album', 'al-1', 5);
  });

  it('clears the rating when the set star is clicked again', async () => {
    render(<RatingStars kind="album" id="al-1" title="Kind of Blue" />);
    const three = await screen.findByRole('radio', { name: '3 stars' });
    await waitFor(() => expect(three).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(three);
    await waitFor(() => expect(mocks.api.setRating).toHaveBeenCalledWith('album', 'al-1', null));
    await waitFor(() => expect(three).toHaveAttribute('aria-checked', 'false'));
  });

  it('is not shown for a streaming item', () => {
    render(<RatingStars kind="track" id="qobuz:1" title="Stream" />);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('reads as a Focus chip', () => {
    expect(activeFilters(new URLSearchParams('ratingMin=4')).map((c) => c.label)).toEqual(['★ 4+']);
    expect(activeFilters(new URLSearchParams('ratingMin=5')).map((c) => c.label)).toEqual(['★ 5']);
  });
});

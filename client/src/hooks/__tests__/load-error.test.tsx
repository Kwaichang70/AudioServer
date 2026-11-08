import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useInfiniteLoad } from '../useInfiniteLoad.js';
import LoadError from '../../components/LoadError.js';

/**
 * U03: a list the server could not deliver says so and offers to try again,
 * instead of looking like an empty library.
 */
function Albums({ fetch }: { fetch: (p: number, l: number) => Promise<never> | Promise<unknown> }) {
  const { items, loading, error, retry } = useInfiniteLoad<{ id: string }>(fetch as never, 10);
  if (loading && items.length === 0) return <p>Loading</p>;
  if (error && items.length === 0)
    return <LoadError what="albums" message={error} onRetry={retry} />;
  if (items.length === 0) return <p>No albums found in your library.</p>;
  return <p>{items.length} albums</p>;
}

describe('a list that fails to load', () => {
  it('says why, offers to try again, and then shows the albums', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Service Unavailable'))
      .mockResolvedValueOnce({
        data: [{ id: 'a' }, { id: 'b' }],
        meta: { page: 1, limit: 10, total: 2, totalPages: 1 },
      });
    render(<Albums fetch={fetch} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load albums.');
    expect(screen.getByRole('alert')).toHaveTextContent('Service Unavailable');
    expect(screen.queryByText(/No albums found/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('2 albums')).toBeInTheDocument());
  });
});

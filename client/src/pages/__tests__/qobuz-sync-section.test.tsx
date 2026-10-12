import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Qobuz favourites in Settings (R07.2): sync now, and decide what was removed on Qobuz. */

const mocks = vi.hoisted(() => ({
  api: { getQobuzSync: vi.fn(), runQobuzSync: vi.fn(), decideQobuzRemoval: vi.fn() },
}));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));

const { default: QobuzSyncSection } = await import('../settings/QobuzSyncSection.js');

const waiting = [{ id: 'qobuz:1', title: 'Kind of Blue', artistName: 'Miles Davis' }];

describe('Qobuz favourites section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getQobuzSync.mockResolvedValue({ data: { last: null, waiting } });
    mocks.api.runQobuzSync.mockResolvedValue({
      data: {
        last: {
          at: 1_700_000_000,
          addedToLibrary: ['qobuz:2'],
          favoritedOnQobuz: [],
          unfavoritedOnQobuz: [],
          removedOnQobuz: [],
          errors: [],
        },
        waiting,
      },
    });
    mocks.api.decideQobuzRemoval.mockResolvedValue({ data: { last: null, waiting: [] } });
  });

  it('syncs on request and reports what happened', async () => {
    render(<QobuzSyncSection />, { wrapper: MemoryRouter });
    fireEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText(/1 added to the library/)).toBeInTheDocument();
  });

  it('lists albums removed on Qobuz and removes one only when you say so', async () => {
    render(<QobuzSyncSection />, { wrapper: MemoryRouter });
    const list = await screen.findByRole('list', { name: 'Waiting for your decision' });
    expect(within(list).getByText(/Kind of Blue/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(mocks.api.decideQobuzRemoval).toHaveBeenCalledWith('qobuz:1', 'remove'),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('list', { name: 'Waiting for your decision' }),
      ).not.toBeInTheDocument(),
    );
  });
});

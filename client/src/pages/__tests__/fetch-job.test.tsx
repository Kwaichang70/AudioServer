import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FetchJob from '../settings/FetchJob.js';

/** Cover / artist-image fetch with its progress on the page. */

const status = (
  s: Partial<{
    isRunning: boolean;
    total: number;
    processed: number;
    found: number;
    notFound: number;
  }>,
) => ({
  data: { isRunning: false, total: 0, processed: 0, found: 0, notFound: 0, ...s },
});

describe('A fetch job on the settings page', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const renderJob = (statusFn: () => Promise<unknown>, startFn = vi.fn()) =>
    render(
      <FetchJob
        title="Fetch Missing Cover Art"
        description="d"
        button="Fetch Covers"
        noun="albums"
        start={startFn as never}
        status={statusFn as never}
      />,
    );

  it('picks up a job already running, shows the bar, and the result when done', async () => {
    const statusFn = vi
      .fn()
      .mockResolvedValueOnce(status({ isRunning: true, total: 1262, processed: 316, found: 200 }))
      .mockResolvedValueOnce(
        status({ isRunning: false, total: 1262, processed: 1262, found: 900, notFound: 362 }),
      );
    renderJob(statusFn);
    await act(async () => {});
    expect(screen.getByText('316 of 1262 albums · 200 found · 25%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByRole('button', { name: 'Fetching…' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(
      screen.getByText('Done: 900 found, 362 not found (of 1262 albums).'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fetch Covers' })).toBeEnabled();
  });

  it('starts a job and follows it', async () => {
    const statusFn = vi
      .fn()
      .mockResolvedValueOnce(status({}))
      .mockResolvedValue(status({ isRunning: true, total: 10, processed: 5, found: 4 }));
    const startFn = vi.fn().mockResolvedValue(status({ isRunning: true, total: 10 }));
    renderJob(statusFn, startFn);
    await act(async () => {});
    expect(screen.getByText('Not run since the server started.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fetch Covers' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(startFn).toHaveBeenCalledOnce();
    expect(screen.getByText('5 of 10 albums · 4 found · 50%')).toBeInTheDocument();
  });
});

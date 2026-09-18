import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sleep timer menu (E01). It only sets and cancels: the server runs the
 * timer, so what this component must get right is showing what was set and
 * not pretending to stop the music itself.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getSleepTimer: vi.fn(),
    setSleepTimer: vi.fn(),
    cancelSleepTimer: vi.fn(),
  },
  sleepTimer: null,
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({ sleepTimer: mocks.sleepTimer }),
}));

const { default: SleepTimerMenu } = await import('../SleepTimerMenu.js');

describe('SleepTimerMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getSleepTimer.mockResolvedValue({ data: null });
    mocks.api.setSleepTimer.mockResolvedValue({
      data: {
        zoneId: 'zone-browser',
        mode: 'in',
        stopAt: 1,
        secondsRemaining: 1800,
        description: 'The music stops in about 30 minutes, wherever the track is by then.',
      },
      meta: {},
    });
    mocks.api.cancelSleepTimer.mockResolvedValue({ data: { ok: true, cancelled: true } });
  });

  it('sets a timed sleep and shows what the server said', async () => {
    render(<SleepTimerMenu />);
    fireEvent.click(screen.getByLabelText('Sleep timer'));
    fireEvent.click(await screen.findByText('30m'));

    await waitFor(() => expect(mocks.api.setSleepTimer).toHaveBeenCalledWith('in', 30));
    expect(await screen.findByText(/29:5\d|30:00/)).toBeTruthy();
  });

  it('sets a boundary timer without minutes', async () => {
    mocks.api.setSleepTimer.mockResolvedValue({
      data: {
        zoneId: 'zone-browser',
        mode: 'endOfAlbum',
        stopAt: null,
        secondsRemaining: null,
        description: 'The music stops when the last track of this album ends.',
      },
      meta: { note: 'Shuffle is on, so this will usually stop after the current track.' },
    });
    render(<SleepTimerMenu />);
    fireEvent.click(screen.getByLabelText('Sleep timer'));
    fireEvent.click(await screen.findByText('After this album'));

    await waitFor(() =>
      expect(mocks.api.setSleepTimer).toHaveBeenCalledWith('endOfAlbum', undefined),
    );
    fireEvent.click(screen.getByLabelText(/Sleep timer:/));
    expect(await screen.findByText(/Shuffle is on/)).toBeTruthy();
  });

  it('cancels a running timer', async () => {
    mocks.api.getSleepTimer.mockResolvedValue({
      data: {
        zoneId: 'zone-browser',
        mode: 'in',
        stopAt: 1,
        secondsRemaining: 600,
        description: 'The music stops in about 10 minutes, wherever the track is by then.',
      },
    });
    render(<SleepTimerMenu />);
    const button = await screen.findByLabelText(/Sleep timer:/);
    fireEvent.click(button);
    fireEvent.click(await screen.findByText('Cancel the timer'));

    await waitFor(() => expect(mocks.api.cancelSleepTimer).toHaveBeenCalled());
    expect(await screen.findByLabelText('Sleep timer')).toBeTruthy();
  });
});

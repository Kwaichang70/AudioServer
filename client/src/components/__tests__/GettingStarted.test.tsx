import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: {
    getStats: vi.fn(),
    getScanStatus: vi.fn(),
    getProviderStatus: vi.fn(),
    getDevices: vi.fn(),
  },
  selectedDeviceId: 'browser',
  isAdmin: true,
}));

vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../context/AudioContext.js', () => ({
  useAudioContext: () => ({ selectedDeviceId: mocks.selectedDeviceId }),
}));
vi.mock('../../context/AuthContext.js', () => ({
  useAuth: () => ({ isAdmin: mocks.isAdmin }),
}));

const { default: GettingStarted } = await import('../GettingStarted.js');

const providers = {
  qobuz: { available: true, authenticated: false, configured: true },
  spotify: { available: false, authenticated: false, configured: false },
  tidal: { available: false, authenticated: false, configured: false },
};

/** V08.2: real status per step, a short next step, no promises. */
describe('GettingStarted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.selectedDeviceId = 'browser';
    mocks.api.getProviderStatus.mockResolvedValue({ data: providers });
    mocks.api.getDevices.mockResolvedValue({ data: [] });
  });

  it('tells a fresh installation what to do first', async () => {
    mocks.api.getStats.mockResolvedValue({ data: { artists: 0, albums: 0, tracks: 0 } });
    mocks.api.getScanStatus.mockResolvedValue({
      data: { isScanning: false },
      lastSuccessfulRun: null,
    });
    render(
      <MemoryRouter>
        <GettingStarted />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('step-library')).toHaveTextContent('No scan has run yet'),
    );
    expect(screen.getByTestId('step-library')).toHaveTextContent('To do');
    expect(screen.getByTestId('step-sources')).toHaveTextContent(
      'qobuz is configured but not signed in',
    );
    expect(screen.getByTestId('step-output')).toHaveTextContent('No Sonos/DLNA speakers found yet');
    // An empty library cannot be hidden away.
    expect(screen.queryByRole('button', { name: 'Hide getting started' })).toBeNull();
  });

  it('names an unreadable music folder and an unreachable speaker', async () => {
    mocks.selectedDeviceId = 'sonos:1';
    mocks.api.getStats.mockResolvedValue({ data: { artists: 3, albums: 5, tracks: 120 } });
    mocks.api.getScanStatus.mockResolvedValue({
      data: { isScanning: false },
      lastSuccessfulRun: {
        finishedAt: 1_700_000_000,
        failedRoots: [{ path: '/music/offline', error: 'ENOENT', failedDirs: [] }],
      },
    });
    mocks.api.getDevices.mockResolvedValue({
      data: [{ id: 'sonos:1', name: 'Studeerkamer', type: 'sonos', isOnline: false }],
    });
    render(
      <MemoryRouter>
        <GettingStarted />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('step-library')).toHaveTextContent('/music/offline'),
    );
    expect(screen.getByTestId('step-library')).toHaveTextContent('Existing music was kept');
    expect(screen.getByTestId('step-output')).toHaveTextContent('Studeerkamer is not reachable');
    expect(screen.getByRole('button', { name: 'Hide getting started' })).toBeInTheDocument();
  });

  it('stays hidden once dismissed while the library has music', async () => {
    localStorage.setItem('audioserver_onboarding_dismissed', '1');
    mocks.api.getStats.mockResolvedValue({ data: { artists: 3, albums: 5, tracks: 120 } });
    mocks.api.getScanStatus.mockResolvedValue({
      data: { isScanning: false },
      lastSuccessfulRun: null,
    });
    render(
      <MemoryRouter>
        <GettingStarted />
      </MemoryRouter>,
    );
    await waitFor(() => expect(mocks.api.getStats).toHaveBeenCalled());
    expect(screen.queryByTestId('getting-started')).toBeNull();
  });
});

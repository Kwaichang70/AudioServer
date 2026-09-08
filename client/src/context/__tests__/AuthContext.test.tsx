import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Set<(err: { isUnauthorized: boolean }) => void>();
  return {
    listeners,
    api: {
      getSetupStatus: vi.fn(),
      getMe: vi.fn(),
      logout: vi.fn(() => Promise.resolve({ data: { ok: true } })),
    },
    ensureStreamToken: vi.fn(() => Promise.resolve('stream')),
    clearStreamToken: vi.fn(),
    onApiError: vi.fn((l: (err: { isUnauthorized: boolean }) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
  };
});

vi.mock('../../api/client.js', () => ({
  api: mocks.api,
  ensureStreamToken: mocks.ensureStreamToken,
  clearStreamToken: mocks.clearStreamToken,
  onApiError: mocks.onApiError,
}));

import { AuthProvider, SESSION_LOST_EVENT, useAuth } from '../AuthContext.js';

function Probe() {
  const { status, user, isAdmin, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? '-'}</span>
      <span data-testid="admin">{String(isAdmin)}</span>
      <button onClick={() => signOut()}>out</button>
    </div>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    localStorage.clear();
  });

  it('shows setup when the server has no accounts, and drops a stale token', async () => {
    localStorage.setItem('audioserver_token', 'stale');
    mocks.api.getSetupStatus.mockResolvedValue({ data: { needsSetup: true } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('setup'));
    expect(localStorage.getItem('audioserver_token')).toBeNull();
    expect(mocks.api.getMe).not.toHaveBeenCalled();
  });

  it('asks the server instead of trusting localStorage: rejected token → login', async () => {
    localStorage.setItem('audioserver_token', 'expired-or-revoked');
    mocks.api.getSetupStatus.mockResolvedValue({ data: { needsSetup: false } });
    mocks.api.getMe.mockResolvedValue({ data: null });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
    expect(localStorage.getItem('audioserver_token')).toBeNull();
  });

  it('authenticates from /auth/me and signs out on a later 401 or a revoked socket', async () => {
    localStorage.setItem('audioserver_token', 'valid');
    mocks.api.getSetupStatus.mockResolvedValue({ data: { needsSetup: false } });
    mocks.api.getMe.mockResolvedValue({
      data: { id: 'u1', username: 'danny', role: 'admin', sessionId: 's1' },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    expect(screen.getByTestId('user').textContent).toBe('danny');
    expect(screen.getByTestId('admin').textContent).toBe('true');
    expect(mocks.ensureStreamToken).toHaveBeenCalled();

    // A 401 from any API call means the session is gone.
    await waitFor(() => expect(mocks.listeners.size).toBe(1));
    act(() => {
      for (const l of mocks.listeners) l({ isUnauthorized: true });
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
    expect(localStorage.getItem('audioserver_token')).toBeNull();
  });

  it('reacts to the session-lost window event from the socket layer', async () => {
    localStorage.setItem('audioserver_token', 'valid');
    mocks.api.getSetupStatus.mockResolvedValue({ data: { needsSetup: false } });
    mocks.api.getMe.mockResolvedValue({
      data: { id: 'u1', username: 'danny', role: 'user', sessionId: 's1' },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    act(() => {
      window.dispatchEvent(new Event(SESSION_LOST_EVENT));
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
  });

  it('signOut revokes the server session and clears local state', async () => {
    localStorage.setItem('audioserver_token', 'valid');
    mocks.api.getSetupStatus.mockResolvedValue({ data: { needsSetup: false } });
    mocks.api.getMe.mockResolvedValue({
      data: { id: 'u1', username: 'danny', role: 'user', sessionId: 's1' },
    });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authenticated'));
    act(() => {
      screen.getByText('out').click();
    });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('anonymous'));
    expect(mocks.api.logout).toHaveBeenCalled();
    expect(mocks.clearStreamToken).toHaveBeenCalled();
    expect(localStorage.getItem('audioserver_token')).toBeNull();
  });
});

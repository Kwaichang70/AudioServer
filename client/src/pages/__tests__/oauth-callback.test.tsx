import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The provider's redirect carries `code` and `state`; the page hands both to
 * the server, which connects only for this admin's own Connect click (B04).
 */

const mocks = vi.hoisted(() => ({
  api: { providerAuthCallback: vi.fn(), providerAuthInit: vi.fn() },
}));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));

const { default: OAuthCallbackPage } = await import('../OAuthCallbackPage.js');

function renderAt(search: string) {
  window.history.pushState({}, '', `/settings/callback/spotify${search}`);
  const router = createMemoryRouter(
    [
      { path: '/settings/callback/:provider', element: <OAuthCallbackPage /> },
      { path: '/settings', element: <p>settings</p> },
    ],
    { initialEntries: [`/settings/callback/spotify${search}`] },
  );
  render(<RouterProvider router={router} />);
}

describe('OAuth callback page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the code together with the state', async () => {
    mocks.api.providerAuthCallback.mockResolvedValue({ data: { authenticated: true } });
    renderAt('?code=abc&state=xyz');
    await waitFor(() =>
      expect(mocks.api.providerAuthCallback).toHaveBeenCalledWith(
        'spotify',
        'abc',
        `${window.location.origin}/settings/callback/spotify`,
        'xyz',
      ),
    );
    expect(await screen.findByText('Connected!')).toBeInTheDocument();
  });

  it('shows the server’s reason when the state is refused', async () => {
    mocks.api.providerAuthCallback.mockRejectedValue(
      new Error('This sign-in did not come from your own "Connect" click'),
    );
    renderAt('?code=abc&state=stolen');
    expect(await screen.findByText(/did not come from your own/)).toBeInTheDocument();
  });
});

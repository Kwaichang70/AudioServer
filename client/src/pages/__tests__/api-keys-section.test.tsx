import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** API keys for Grok, Jarvis and Homey in Settings → Account. */

const mocks = vi.hoisted(() => ({
  api: {
    getApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(() => Promise.resolve({ data: { ok: true } })),
  },
  toast: vi.fn(),
}));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));
vi.mock('../../components/Toast.js', () => ({ useToast: () => ({ toast: mocks.toast }) }));

const { default: ApiKeysSection } = await import('../settings/ApiKeysSection.js');

const jarvis = { id: 'k1', name: 'Jarvis', prefix: 'as_abcdefg', createdAt: 1, lastUsedAt: null };

describe('API keys in settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.getApiKeys.mockResolvedValue({ data: [jarvis] });
  });

  it('makes a key and shows it once, with how to send it', async () => {
    mocks.api.createApiKey.mockResolvedValue({
      data: { ...jarvis, id: 'k2', name: 'Grok', key: 'as_secret-value-shown-once' },
    });
    render(<ApiKeysSection />);
    fireEvent.change(screen.getByLabelText('Key name'), { target: { value: 'Grok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make key' }));
    expect(await screen.findByText('as_secret-value-shown-once')).toBeInTheDocument();
    expect(mocks.api.createApiKey).toHaveBeenCalledWith('Grok');
    fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByText('as_secret-value-shown-once')).toBeNull();
  });

  it('lists keys by name and prefix, and revokes one after asking', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ApiKeysSection />);
    expect(await screen.findByText('Jarvis')).toBeInTheDocument();
    expect(screen.getByText(/as_abcdefg… · made .* · never used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(mocks.api.revokeApiKey).toHaveBeenCalledWith('k1'));
  });
});

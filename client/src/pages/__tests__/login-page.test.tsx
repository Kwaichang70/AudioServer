import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: { login: vi.fn(), register: vi.fn() },
}));
vi.mock('../../api/client.js', () => ({ api: mocks.api }));

const { default: LoginPage } = await import('../LoginPage.js');

/** V08.3: sign-in works by keyboard and screen reader: labelled fields, an announced error. */
describe('LoginPage accessibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('labels every field and announces a failed sign-in', async () => {
    mocks.api.login.mockRejectedValue(new Error('Invalid credentials'));
    const onAuth = vi.fn();
    render(<LoginPage mode="login" onAuth={onAuth} />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'danny' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-word' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials'));
    expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
    expect(onAuth).not.toHaveBeenCalled();
  });

  it('exposes the setup code field by label in setup mode', () => {
    render(<LoginPage mode="setup" onAuth={vi.fn()} />);
    expect(screen.getByLabelText('Setup code')).toBeInTheDocument();
    expect(screen.getByLabelText('Password (8+ characters)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create admin account' })).toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppStatusBanners from '../AppStatusBanners.js';
import { markUpdateReadyForTests, resetServiceWorkerStateForTests } from '../../sw/register.js';

describe('AppStatusBanners (V08.1)', () => {
  afterEach(() => {
    resetServiceWorkerStateForTests();
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('shows an honest offline notice and hides it again when the network returns', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    render(<AppStatusBanners />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('keeps playing on the NAS');
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('offers a reload when a new build is waiting, and tells the waiting worker to take over', () => {
    const postMessage = vi.fn();
    render(<AppStatusBanners />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
    act(() => {
      markUpdateReadyForTests({ waiting: { postMessage } } as unknown as ServiceWorkerRegistration);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reload now' }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  });
});

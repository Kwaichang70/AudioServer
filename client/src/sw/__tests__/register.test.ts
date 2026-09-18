import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '../register.js';

/**
 * R00.6: the worker caches one build's shell — the point in production, a trap
 * under `vite dev`, where it kept serving a cached bundle so edits did not show
 * up in the browser. Vitest runs with DEV true, which is exactly the case under
 * test here.
 */
describe('registerServiceWorker in development', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubServiceWorker(registrations: { unregister: () => Promise<boolean> }[]) {
    const register = vi.fn(() => Promise.resolve({}));
    const getRegistrations = vi.fn(() => Promise.resolve(registrations));
    vi.stubGlobal('navigator', {
      serviceWorker: { register, getRegistrations, addEventListener: vi.fn() },
    });
    return { register, getRegistrations };
  }

  it('registers no worker', async () => {
    expect(import.meta.env.DEV).toBe(true);
    const { register } = stubServiceWorker([]);

    registerServiceWorker();
    window.dispatchEvent(new Event('load'));
    await Promise.resolve();

    expect(register).not.toHaveBeenCalled();
  });

  it('releases a worker an earlier dev session left behind', async () => {
    const unregister = vi.fn(() => Promise.resolve(true));
    const { getRegistrations } = stubServiceWorker([{ unregister }]);

    registerServiceWorker();
    await vi.waitFor(() => expect(unregister).toHaveBeenCalled());

    expect(getRegistrations).toHaveBeenCalled();
  });

  it('does nothing at all where the browser has no service workers', () => {
    vi.stubGlobal('navigator', {});
    expect(() => registerServiceWorker()).not.toThrow();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Plan §6 "Streamtokencache": a stream-token request that was already on its
 * way when the user signed out must not refill the cache afterwards. Else the
 * next account's covers and streams carry the old session's token (refused,
 * since that session ended) until it expires an hour later.
 */

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { clearStreamToken, ensureStreamToken, api } = await import('../client');

function deferredJson() {
  let resolve!: (token: string) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = (token: string) =>
      r({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: () => Promise.resolve({ data: { token, expiresIn: 3600 } }),
      });
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockFetch.mockReset();
  clearStreamToken();
});

describe('stream token cache', () => {
  it('ignores a token that arrives after sign-out', async () => {
    const old = deferredJson();
    mockFetch.mockReturnValueOnce(old.promise);
    const pending = ensureStreamToken();

    clearStreamToken(); // sign-out while the request is out
    old.resolve('token-of-old-session');
    await pending.catch(() => {});

    expect(api.getAlbumCoverUrl('al-1')).not.toContain('token-of-old-session');
  });

  it('asks again for the new session instead of sharing the old request', async () => {
    const old = deferredJson();
    mockFetch.mockReturnValueOnce(old.promise);
    void ensureStreamToken().catch(() => {});

    clearStreamToken();
    const fresh = deferredJson();
    mockFetch.mockReturnValueOnce(fresh.promise);
    const next = ensureStreamToken();
    old.resolve('token-of-old-session');
    fresh.resolve('token-of-new-session');

    expect(await next).toBe('token-of-new-session');
    expect(api.getAlbumCoverUrl('al-1')).toContain('t=token-of-new-session');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps a token fetched for the current session', async () => {
    const now = deferredJson();
    mockFetch.mockReturnValueOnce(now.promise);
    const pending = ensureStreamToken();
    now.resolve('current');

    expect(await pending).toBe('current');
    expect(api.getAlbumCoverUrl('al-1')).toContain('t=current');
  });
});

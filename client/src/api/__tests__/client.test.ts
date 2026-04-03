import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock localStorage
const storage: Record<string, string> = {};
Object.defineProperty(global, 'localStorage', {
  value: {
    getItem: (key: string) => storage[key] || null,
    setItem: (key: string, val: string) => { storage[key] = val; },
    removeItem: (key: string) => { delete storage[key]; },
  },
});

// Import after mocks are set up
const { api } = await import('../client');

beforeEach(() => {
  mockFetch.mockReset();
  delete storage['audioserver_token'];
});

function mockJsonResponse(data: any, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

describe('API client', () => {
  it('includes auth token when available', async () => {
    storage['audioserver_token'] = 'test-jwt-token';
    mockJsonResponse({ data: [] });

    await api.getArtists();

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/library/artists?page=1&limit=50',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-jwt-token',
        }),
      }),
    );
  });

  it('omits auth header when no token', async () => {
    mockJsonResponse({ data: [] });

    await api.getArtists();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws on non-200 response', async () => {
    mockJsonResponse({ message: 'Not Found' }, 404);

    await expect(api.getArtist('invalid')).rejects.toThrow('Not Found');
  });

  it('passes page and limit params', async () => {
    mockJsonResponse({ data: [], meta: { page: 2, limit: 30, total: 100, totalPages: 4 } });

    await api.getAlbums(2, 30);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/library/albums?page=2&limit=30',
      expect.anything(),
    );
  });

  it('getStreamUrl returns URL string (not a fetch)', () => {
    const url = api.getStreamUrl('track-123');
    expect(url).toBe('/api/library/tracks/track-123/stream');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('login sends credentials', async () => {
    mockJsonResponse({ data: { token: 'jwt', user: { id: '1', username: 'admin' } } });

    await api.login('admin', 'password123');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'password123' }),
      }),
    );
  });

  it('register sends credentials', async () => {
    mockJsonResponse({ data: { token: 'jwt', user: { id: '1', username: 'admin' } } });

    await api.register('admin', 'password123');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/auth/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'admin', password: 'password123' }),
      }),
    );
  });
});

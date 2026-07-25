import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRawDb, initDatabase } from '../db/index.js';
import { loadTokens } from '../services/tokenstore.js';
import {
  createQobuzStreamSignature,
  QobuzProvider,
  QobuzProviderError,
} from '../providers/qobuz.js';

function mockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe('QobuzProvider', () => {
  let tmp: string | null = null;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'audioserver-qobuz-test-'));
    await initDatabase(join(tmp, 'test.db'));
    vi.stubEnv('QOBUZ_APP_ID', 'app-id');
    vi.stubEnv('QOBUZ_APP_SECRET', 'app-secret');
    vi.stubEnv('QOBUZ_AUDIO_FORMAT', '6');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    try {
      getRawDb().close();
    } catch {
      // ignore
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('creates the expected track/getFileUrl signature', () => {
    expect(createQobuzStreamSignature('123', '5', '1700000000', 'secret')).toBe(
      '8e429262c9465f5fdc24ef1744a1ae90',
    );
  });

  it('reports streaming disabled when app credentials are missing', async () => {
    vi.stubEnv('QOBUZ_APP_ID', '');
    vi.stubEnv('QOBUZ_APP_SECRET', '');
    const provider = new QobuzProvider();

    expect(provider.getStatus()).toMatchObject({
      configured: false,
      authenticated: false,
      streamingAvailable: false,
      reason: 'qobuz_not_configured',
    });
    await expect(provider.getStreamInfo('qobuz:123')).rejects.toMatchObject({
      code: 'qobuz_not_configured',
    });
  });

  it('stores only the Qobuz user token and metadata after login', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        user_auth_token: 'user-token',
        user: { id: 42, display_name: 'Danny' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new QobuzProvider();
    await provider.auth.login({ username: 'danny@example.com', password: 'super-secret' });

    const stored = loadTokens('qobuz');
    expect(stored?.accessToken).toBe('user-token');
    expect(stored?.refreshToken).not.toContain('super-secret');
    expect(stored?.refreshToken).not.toContain('danny@example.com');
    expect(JSON.parse(stored!.refreshToken)).toMatchObject({
      userId: 42,
      displayName: 'Danny',
    });
  });

  it('requests a signed Qobuz stream URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          user_auth_token: 'user-token',
          user: { id: 42, display_name: 'Danny' },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ url: 'https://cdn.qobuz.test/track.flac' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new QobuzProvider();
    await provider.auth.login({ username: 'danny@example.com', password: 'super-secret' });
    const stream = await provider.getStreamInfo('qobuz:123');

    expect(stream).toMatchObject({
      url: 'https://cdn.qobuz.test/track.flac',
      formatId: '6',
    });

    const requestUrl = new URL(fetchMock.mock.calls[1][0] as string);
    const requestTs = requestUrl.searchParams.get('request_ts')!;
    expect(requestUrl.pathname).toContain('/track/getFileUrl');
    expect(requestUrl.searchParams.get('app_id')).toBe('app-id');
    expect(requestUrl.searchParams.get('track_id')).toBe('123');
    expect(requestUrl.searchParams.get('format_id')).toBe('6');
    expect(requestUrl.searchParams.get('intent')).toBe('stream');
    expect(requestUrl.searchParams.get('request_sig')).toBe(
      createQobuzStreamSignature('123', '6', requestTs, 'app-secret'),
    );
  });

  it('maps blocked stream responses to a clear error code', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          user_auth_token: 'user-token',
          user: { id: 42, display_name: 'Danny' },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ message: 'Track not available in your region' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new QobuzProvider();
    await provider.auth.login({ username: 'danny@example.com', password: 'super-secret' });

    const request = provider.getStreamInfo('qobuz:123');
    await expect(request).rejects.toBeInstanceOf(QobuzProviderError);
    await expect(request).rejects.toMatchObject({
      code: 'qobuz_geo_or_subscription_blocked',
    });
  });

  it('maps typed Qobuz search resources to domain objects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse({
          user_auth_token: 'user-token',
          user: { id: 42, display_name: 'Danny' },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse({
          artists: { items: [null, { id: 7, name: 'Nina Simone' }] },
          albums: {
            items: [
              {
                id: 'album-7',
                title: 'Pastel Blues',
                artist: { id: 7, name: 'Nina Simone' },
                released_at: 1_435_708_800,
                image: { large: 'cover.jpg' },
                tracks_count: 9,
              },
            ],
          },
          tracks: {
            items: [
              {
                id: 99,
                title: 'Sinnerman',
                performer: { id: 7, name: 'Nina Simone' },
                album: { id: 'album-7', title: 'Pastel Blues' },
                duration: 622,
                maximum_sampling_rate: 96,
                maximum_bit_depth: 24,
              },
            ],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new QobuzProvider();
    await provider.auth.login({ username: 'danny@example.com', password: 'super-secret' });
    const results = await provider.search('Nina Simone');

    expect(results.artists[0]).toMatchObject({
      id: 'qobuz:7',
      name: 'Nina Simone',
      source: 'qobuz',
    });
    expect(results.albums[0]).toMatchObject({
      id: 'qobuz:album-7',
      artistId: 'qobuz:7',
      coverUrl: 'cover.jpg',
    });
    expect(results.tracks[0]).toMatchObject({
      id: 'qobuz:99',
      albumId: 'qobuz:album-7',
      sampleRate: 96_000,
      bitDepth: 24,
    });
    expect(results.artists).toHaveLength(1);
  });
});

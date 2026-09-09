import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// The registry constructs its providers at import time, so the credentials
// must exist before any module below is loaded.
vi.hoisted(() => {
  process.env.SPOTIFY_CLIENT_ID = 'spotify-client';
  process.env.SPOTIFY_CLIENT_SECRET = 'spotify-secret';
});

import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { saveTokens } from '../services/tokenstore.js';
import { providers } from '../providers/registry.js';

/**
 * V04.4: provider failures reach the browser with a status the UI can act
 * on, not a generic 500.
 */
describe('provider error mapping', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
    saveTokens('spotify', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3_600_000,
    });
    await providers.spotify.initialize();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    teardown();
  });

  it('answers 429 with the Spotify reason and a Retry-After header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":{"status":429}}', {
            status: 429,
            headers: { 'Retry-After': '9', 'Content-Type': 'application/json' },
          }),
      ),
    );
    const res = await request(app).get('/api/providers/spotify/connect/devices');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'spotify_rate_limited' });
    expect(res.body.message).toMatch(/rate-limit/);
    expect(res.headers['retry-after']).toBe('9');
  });
});

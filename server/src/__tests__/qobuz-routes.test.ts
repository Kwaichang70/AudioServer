import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';

describe('Qobuz provider routes', () => {
  let app: Express;
  let teardown: () => void;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    teardown();
  });

  it('reports honest disabled status without app credentials', async () => {
    vi.stubEnv('QOBUZ_APP_ID', '');
    vi.stubEnv('QOBUZ_APP_SECRET', '');

    const res = await request(app).get('/api/providers/qobuz/status');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      configured: false,
      authenticated: false,
      streamingAvailable: false,
      reason: 'qobuz_not_configured',
    });
  });

  it('returns a structured error when streaming is not configured', async () => {
    vi.stubEnv('QOBUZ_APP_ID', '');
    vi.stubEnv('QOBUZ_APP_SECRET', '');

    const res = await request(app).get('/api/providers/qobuz/tracks/123/stream');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: 'qobuz_not_configured',
    });
  });

  it('marks Tidal full playback as unsupported', async () => {
    const res = await request(app).get('/api/providers/tidal/tracks/123/stream');

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({
      error: 'tidal_preview_only',
    });
  });
});

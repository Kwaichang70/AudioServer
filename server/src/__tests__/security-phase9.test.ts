import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import { createTestApp, seedUser, TEST_PASSWORD, type TestUser } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import { config } from '../config.js';
import { radioProvider } from '../providers/radio.js';
import { TidalProvider } from '../providers/tidal.js';
import { skipsGlobalLimit } from '../middleware/rateLimiter.js';
import { signSystemStreamToken, getPrincipalFromToken } from '../middleware/auth.js';
import { scrobbler } from '../services/scrobbler.js';
import { topArtists } from '../services/listenbrainz.js';
import { isSealed, loadTokens, saveTokens } from '../services/tokenstore.js';
import { outboundFetch } from '../utils/outbound-fetch.js';

/**
 * Phase 9 (S01–S12): what a signed-in person can make the server, the
 * speakers and the household do, and what the server keeps about accounts.
 */

let app: Express;
let teardown: () => void;
let admin: TestUser;
let member: TestUser;

beforeAll(async () => {
  const ctx = await createTestApp();
  app = ctx.app;
  teardown = ctx.teardown;
  admin = ctx.admin!;
  member = ctx.member!;
});

afterAll(() => teardown());

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const as = (user: TestUser) => ({
  post: (path: string) =>
    request(app)
      .post(path)
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-Client-Id', 'phase9'),
});

describe('the radio station cache (S01)', () => {
  const stored = (uuid: string) =>
    getRawDb().prepare('SELECT stream_url, name FROM radio_stations WHERE uuid = ?').get(uuid) as
      { stream_url: string; name: string } | undefined;

  it('stores what the server finds, not the stream URL a user sends', async () => {
    const station = radioProvider.getFeaturedStations()[0];
    const res = await as(member).post('/api/radio/stations/cache').send({
      uuid: station.uuid,
      name: station.name,
      streamUrl: 'http://attacker.example/evil.mp3',
      faviconUrl: 'http://attacker.example/pixel.gif',
    });
    expect(res.status).toBe(200);
    expect(stored(station.uuid)).toEqual({ stream_url: station.streamUrl, name: station.name });
  });

  it('refuses a station the directory does not know, and an id that is not one', async () => {
    vi.spyOn(radioProvider, 'getStation').mockResolvedValue(null);
    const unknown = await as(member)
      .post('/api/radio/stations/cache')
      .send({ uuid: 'no-such-station', name: 'X', streamUrl: 'http://attacker.example/x' });
    expect(unknown.status).toBe(404);
    expect(stored('no-such-station')).toBeUndefined();

    const bad = await as(member)
      .post('/api/radio/stations/cache')
      .send({ uuid: '../../etc', streamUrl: 'http://x' });
    expect(bad.status).toBe(400);
  });
});

describe('what a tab may hand to a speaker (S02)', () => {
  it.each([
    ['a file address', { streamUrl: 'file:///etc/passwd' }],
    ['something that is no address', { streamUrl: 'not a url' }],
    ['no address at all', {}],
    [
      'metadata that is not text',
      { streamUrl: 'http://nas/x.flac', metadata: { title: { a: 1 } } },
    ],
  ])('refuses %s', async (_name, body) => {
    const res = await as(member).post('/api/devices/speaker-1/play').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });

  it('refuses a volume outside 0–100 and hides raw errors', async () => {
    expect(
      (await as(member).post('/api/devices/speaker-1/volume').send({ volume: 500 })).status,
    ).toBe(400);
    // A speaker nobody knows: a plain message, not the error's own text.
    const res = await as(member)
      .post('/api/devices/speaker-1/play')
      .send({ streamUrl: 'http://nas:3001/api/library/tracks/t/stream?t=x' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'DeviceError' });
    expect(JSON.stringify(res.body)).not.toContain('fresh search');
  });
});

describe('the global rate limit (S04)', () => {
  it('exempts own covers, audio and status polls, and nothing that calls a provider', () => {
    expect(skipsGlobalLimit('/api/library/tracks/t1/stream')).toBe(true);
    expect(skipsGlobalLimit('/api/library/albums/a1/cover')).toBe(true);
    expect(skipsGlobalLimit('/api/library/artists/x/image')).toBe(true);
    expect(skipsGlobalLimit('/api/devices/sonos-1/status')).toBe(true);
    expect(skipsGlobalLimit('/api/librespot/stream')).toBe(true);

    expect(skipsGlobalLimit('/api/providers/qobuz/tracks/1/stream')).toBe(false);
    expect(skipsGlobalLimit('/api/radio/stations/abc/stream')).toBe(false);
    expect(skipsGlobalLimit('/api/library/covers/fetch')).toBe(false);
    expect(skipsGlobalLimit('/api/providers/spotify/images/x')).toBe(false);
  });
});

describe('scrobble credentials at rest (S05)', () => {
  const row = (userId: string) =>
    getRawDb()
      .prepare(
        'SELECT lastfm_session_key, listenbrainz_token FROM scrobble_config WHERE user_id = ?',
      )
      .get(userId) as { lastfm_session_key: string | null; listenbrainz_token: string | null };

  it('are encrypted in the database and readable by the server', () => {
    scrobbler.saveConfig(member.id, { lastfmSessionKey: 'lastfm-secret-key' });
    scrobbler.saveConfig(member.id, { listenbrainzEnabled: true, listenbrainzToken: 'lb-token' });
    const saved = row(member.id);
    expect(isSealed(saved.lastfm_session_key)).toBe(true);
    expect(isSealed(saved.listenbrainz_token)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('lastfm-secret-key');
    expect(JSON.stringify(saved)).not.toContain('lb-token');
    expect(scrobbler.getConfig(member.id)).toMatchObject({
      lastfmSessionKey: 'lastfm-secret-key',
      listenbrainzToken: 'lb-token',
    });
  });

  it('seals rows stored as plain text before, once, and keeps them working', async () => {
    scrobbler.saveConfig(admin.id, { listenbrainzEnabled: true });
    getRawDb()
      .prepare(
        'UPDATE scrobble_config SET lastfm_session_key = ?, listenbrainz_token = ? WHERE user_id = ?',
      )
      .run('old-plain-key', 'old-plain-token', admin.id);
    // Readable before the sweep (a request may arrive first)…
    expect(scrobbler.getConfig(admin.id).lastfmSessionKey).toBe('old-plain-key');

    expect(scrobbler.sealStoredCredentials()).toBe(1);
    expect(scrobbler.sealStoredCredentials()).toBe(0);
    expect(isSealed(row(admin.id).lastfm_session_key)).toBe(true);
    expect(scrobbler.getConfig(admin.id)).toMatchObject({
      lastfmSessionKey: 'old-plain-key',
      listenbrainzToken: 'old-plain-token',
    });

    // …and the ListenBrainz reader sends the real token, not the stored form.
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await topArtists(admin.id, 'week').catch(() => null);
    const sent = JSON.stringify(fetchMock.mock.calls);
    expect(sent).toContain('old-plain-token');
    expect(sent).not.toContain('enc:v1:');
  });
});

describe('requests to outside services (S06)', () => {
  it('end at their time limit when the other side says nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      ),
    );
    const started = Date.now();
    await expect(outboundFetch('https://slow.example/', {}, 60)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still honours the caller’s own signal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted by caller')));
          }),
      ),
    );
    const control = new AbortController();
    const pending = outboundFetch('https://slow.example/', { signal: control.signal }, 60_000);
    control.abort();
    await expect(pending).rejects.toThrow('aborted by caller');
  });
});

describe('the live Spotify stream for a speaker (S07)', () => {
  const noLogin = (path: string) => request(app).get(path).set('Authorization', 'Bearer none');

  it('is reachable with a system stream token only', async () => {
    expect((await noLogin('/api/librespot/stream')).status).toBe(401);
    const token = encodeURIComponent(signSystemStreamToken());
    // Past the login check: librespot is simply not running in a test.
    expect((await noLogin(`/api/librespot/stream?t=${token}`)).status).toBe(503);
  });

  it('checks the body of play-to-device', async () => {
    expect((await as(member).post('/api/librespot/play-to-device').send({})).status).toBe(400);
  });
});

describe('Tidal token refresh (S08)', () => {
  const expired = () =>
    saveTokens('tidal', { accessToken: 'old', refreshToken: 'refresh', expiresAt: Date.now() - 1 });

  async function provider(): Promise<TidalProvider> {
    vi.stubEnv('TIDAL_CLIENT_ID', 'id');
    vi.stubEnv('TIDAL_CLIENT_SECRET', 'secret');
    expired();
    const tidal = new TidalProvider();
    await tidal.initialize();
    return tidal;
  }

  it('refreshes once when several requests find the token expired', async () => {
    let refreshes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/token')) {
          refreshes++;
          await new Promise((r) => setTimeout(r, 20));
          return Response.json({ access_token: 'new', expires_in: 3600 });
        }
        return Response.json({ data: [] });
      }),
    );
    const tidal = await provider(); // restoring refreshed once already
    refreshes = 0;
    // The token runs out while the app is open; three requests notice at once.
    (tidal as unknown as { tokens: { expiresAt: number } }).tokens.expiresAt = 0;
    await Promise.all([
      tidal.getAlbum('tidal:1').catch(() => null),
      tidal.getAlbum('tidal:2').catch(() => null),
      tidal.getAlbum('tidal:3').catch(() => null),
    ]);
    expect(refreshes).toBe(1);
  });

  it('disconnects when the refresh token is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid_grant', { status: 400 })),
    );
    // Restoring the saved (expired) tokens already asks for a refresh.
    const tidal = await provider();
    expect(tidal.auth.isAuthenticated).toBe(false);
    expect(loadTokens('tidal')).toBeNull();
  });
});

describe('Spotify Connect commands (S09)', () => {
  it.each([
    ['a device id with extra parameters', '/pause', { deviceId: 'abc&market=XX' }],
    ['a uri that is not a Spotify uri', '/play', { trackUri: 'http://evil.example/' }],
    ['a volume outside 0–100', '/volume', { volume: 900 }],
  ])('refuses %s', async (_name, path, body) => {
    const res = await as(member).post(`/api/providers/spotify/connect${path}`).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('ValidationError');
  });
});

describe('accounts (S12)', () => {
  it('answers an unknown username like a wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody-here', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('accepts only tokens signed the way the server signs them', () => {
    const sessionId = admin.sessionId;
    const good = jwt.sign({ userId: admin.id, sid: sessionId }, config.jwtSecret);
    const other = jwt.sign({ userId: admin.id, sid: sessionId }, config.jwtSecret, {
      algorithm: 'HS512',
    });
    expect(getPrincipalFromToken(good)?.userId).toBe(admin.id);
    expect(getPrincipalFromToken(other)).toBeNull();
  });

  it('leaves nothing of a deleted account behind', async () => {
    const leaver = await seedUser('leaver', 'user');
    const db = getRawDb();
    db.prepare(
      "INSERT INTO ratings (user_id, item_type, item_id, rating) VALUES (?, 'track', 't', 4)",
    ).run(leaver.id);
    db.prepare("INSERT INTO tags (id, user_id, name) VALUES ('tag-l', ?, 'Mine')").run(leaver.id);
    db.prepare(
      "INSERT INTO tag_items (tag_id, item_type, item_id) VALUES ('tag-l', 'track', 't')",
    ).run();
    db.prepare(
      "INSERT INTO bookmarks (id, user_id, name, path, query) VALUES ('bm-l', ?, 'B', '/albums', '')",
    ).run(leaver.id);

    const res = await request(app)
      .delete(`/api/auth/users/${leaver.id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.status).toBe(200);
    const left = (table: string, column = 'user_id', value = leaver.id) =>
      (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as {
          n: number;
        }
      ).n;
    expect(left('ratings')).toBe(0);
    expect(left('tags')).toBe(0);
    expect(left('tag_items', 'tag_id', 'tag-l')).toBe(0);
    expect(left('bookmarks')).toBe(0);
  });
});

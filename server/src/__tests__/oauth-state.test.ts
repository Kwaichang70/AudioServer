import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, seedUser, type TestUser } from './helpers/testApp.js';
import { providers } from '../providers/registry.js';
import {
  beginOAuth,
  clearOAuthTransactions,
  finishOAuth,
  OAuthStateError,
} from '../services/oauth-transactions.js';

/**
 * ANALYSE_EN_VERBETERPLAN B04: a provider callback only connects when it
 * carries the state of this admin's own Connect click — once, within ten
 * minutes, for the same provider and redirect URI. A link someone else sends
 * cannot attach their Spotify or Tidal account to this installation, and two
 * Tidal attempts keep their own PKCE verifier.
 */

const redirect = 'https://music.example.org/settings/callback/spotify';

describe('OAuth transactions', () => {
  afterEach(() => clearOAuthTransactions());

  it('accepts its own state once', () => {
    const state = beginOAuth('spotify', 'session-1', redirect);
    expect(finishOAuth(state, 'spotify', 'session-1', redirect).provider).toBe('spotify');
    expect(() => finishOAuth(state, 'spotify', 'session-1', redirect)).toThrow(OAuthStateError);
  });

  it('refuses a missing, foreign, mismatched or expired state', () => {
    expect(() => finishOAuth(undefined, 'spotify', 's', redirect)).toThrow(OAuthStateError);
    expect(() => finishOAuth('made-up', 'spotify', 's', redirect)).toThrow(OAuthStateError);
    const other = beginOAuth('spotify', 'someone-else', redirect);
    expect(() => finishOAuth(other, 'spotify', 'me', redirect)).toThrow(OAuthStateError);
    const tidal = beginOAuth('tidal', 'me', redirect);
    expect(() => finishOAuth(tidal, 'spotify', 'me', redirect)).toThrow(OAuthStateError);
    const elsewhere = beginOAuth('spotify', 'me', redirect);
    expect(() => finishOAuth(elsewhere, 'spotify', 'me', 'https://evil.example/cb')).toThrow(
      OAuthStateError,
    );
    const old = beginOAuth('spotify', 'me', redirect, undefined, 0);
    expect(() => finishOAuth(old, 'spotify', 'me', redirect, 11 * 60_000)).toThrow(OAuthStateError);
  });

  it('keeps two attempts apart, each with its own verifier', () => {
    const a = beginOAuth('tidal', 'me', redirect, 'verifier-a');
    const b = beginOAuth('tidal', 'me', redirect, 'verifier-b');
    expect(finishOAuth(b, 'tidal', 'me', redirect).verifier).toBe('verifier-b');
    expect(finishOAuth(a, 'tidal', 'me', redirect).verifier).toBe('verifier-a');
  });
});

describe('Connect Spotify end to end', () => {
  let app: Express;
  let teardown: () => void;
  let admin: TestUser;
  let other: TestUser;
  const spotify = providers.spotify;
  const was = spotify.isAvailable;

  beforeAll(async () => {
    const ctx = await createTestApp({ auth: 'none' });
    app = ctx.app;
    teardown = ctx.teardown;
    admin = await seedUser('anna', 'admin');
    other = await seedUser('beheer', 'admin');
    spotify.isAvailable = true;
  });

  afterAll(() => {
    spotify.isAvailable = was;
    teardown();
  });

  const as = (user: TestUser) => ({
    post: (path: string) => request(app).post(path).set('Authorization', `Bearer ${user.token}`),
  });

  it('puts a state in the Spotify URL and needs it back from the same admin', async () => {
    const login = vi.spyOn(spotify.auth, 'login').mockResolvedValue();
    const init = await as(admin)
      .post('/api/providers/spotify/auth/init')
      .send({ redirectUri: redirect });
    const state = new URL(init.body.data.authUrl).searchParams.get('state');
    expect(state).toMatch(/^[\w-]{20,}$/);

    // Without the state, or from another admin's session: refused, no exchange.
    const none = await as(admin)
      .post('/api/providers/spotify/auth/callback')
      .send({ code: 'c', redirectUri: redirect });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('oauth_state');
    const foreign = await as(other)
      .post('/api/providers/spotify/auth/callback')
      .send({ code: 'c', redirectUri: redirect, state });
    expect(foreign.status).toBe(400);
    expect(login).not.toHaveBeenCalled();

    // The foreign try used the state up: even the right admin must click again.
    const again = await as(admin)
      .post('/api/providers/spotify/auth/init')
      .send({ redirectUri: redirect });
    const fresh = new URL(again.body.data.authUrl).searchParams.get('state');
    const ok = await as(admin)
      .post('/api/providers/spotify/auth/callback')
      .send({ code: 'c', redirectUri: redirect, state: fresh });
    expect(ok.status).toBe(200);
    expect(login).toHaveBeenCalledWith({ code: 'c', redirectUri: redirect });
    login.mockRestore();
  });
});

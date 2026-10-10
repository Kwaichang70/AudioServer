import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from './helpers/testApp.js';
import { getRawDb } from '../db/index.js';
import {
  BIO_TTL_SECONDS,
  cleanLastfmSummary,
  configureArtistBio,
  getArtistBio,
  MISS_TTL_SECONDS,
} from '../services/artist-bio.js';
import { configureMusicBrainz } from '../services/musicbrainz.js';

/**
 * Artist biographies (R04.1).
 *
 * The chain is identity-based on purpose — MBID → Wikidata → Wikipedia, Dutch
 * before English — with Last.fm only as a fallback. What these tests pin down
 * is the order, the cache (a second visit costs nothing), and that a source
 * and licence always travel with the text.
 */

type Responder = (url: string) => unknown | null;

describe('Artist biographies', () => {
  let app: Express;
  let teardown: () => void;
  let calls: string[] = [];
  let respond: Responder = () => null;
  let clock = 1_700_000_000;

  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    const body = respond(String(url));
    return {
      ok: body !== null,
      status: body === null ? 404 : 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    const ctx = await createTestApp();
    app = ctx.app;
    teardown = ctx.teardown;
  });

  afterAll(() => teardown());

  beforeEach(() => {
    calls = [];
    clock = 1_700_000_000;
    const db = getRawDb();
    db.prepare('DELETE FROM artist_bios').run();
    db.prepare('DELETE FROM artists').run();
    db.prepare(
      "INSERT INTO artists (id, name, mbid) VALUES ('ar-id', 'Herman Brood', 'mb-1')",
    ).run();
    db.prepare("INSERT INTO artists (id, name) VALUES ('ar-name', 'Unidentified Band')").run();
    configureMusicBrainz({ fetch: fakeFetch, sleep: async () => {}, now: () => 0 });
    configureArtistBio({ fetch: fakeFetch, now: () => clock, lastfmKey: () => 'test-key' });
  });

  /** The full chain for an identified artist, with a Dutch article. */
  const wikipediaChain: Responder = (url) => {
    if (url.includes('musicbrainz.org/ws/2/artist/mb-1')) {
      return {
        relations: [{ type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q1' } }],
      };
    }
    if (url.includes('wikidata.org/wiki/Special:EntityData/Q1.json')) {
      return {
        entities: {
          Q1: {
            sitelinks: { nlwiki: { title: 'Herman Brood' }, enwiki: { title: 'Herman Brood' } },
          },
        },
      };
    }
    if (url.includes('nl.wikipedia.org/api/rest_v1/page/summary/Herman_Brood')) {
      return {
        extract: 'Herman Brood was een Nederlandse muzikant en kunstschilder.',
        type: 'standard',
        content_urls: { desktop: { page: 'https://nl.wikipedia.org/wiki/Herman_Brood' } },
      };
    }
    return null;
  };

  it('follows the identity chain to the Dutch Wikipedia article, with its licence', async () => {
    respond = wikipediaChain;
    const bio = await getArtistBio('ar-id');
    expect(bio?.source).toBe('wikipedia');
    expect(bio?.language).toBe('nl');
    expect(bio?.summary).toMatch(/Nederlandse muzikant/);
    expect(bio?.url).toBe('https://nl.wikipedia.org/wiki/Herman_Brood');
    expect(bio?.license).toMatch(/CC BY-SA/);
  });

  it('falls back to English when there is no Dutch article', async () => {
    respond = (url) => {
      if (url.includes('nl.wikipedia.org')) return null;
      if (url.includes('en.wikipedia.org/api/rest_v1/page/summary/Herman_Brood')) {
        return { extract: 'Herman Brood was a Dutch musician.', type: 'standard' };
      }
      return wikipediaChain(url);
    };
    const bio = await getArtistBio('ar-id');
    expect(bio?.language).toBe('en');
  });

  it('skips a disambiguation page instead of showing it as a biography', async () => {
    respond = (url) => {
      if (url.includes('nl.wikipedia.org')) {
        return { extract: 'Herman Brood kan verwijzen naar:', type: 'disambiguation' };
      }
      if (url.includes('en.wikipedia.org')) return null;
      if (url.includes('audioscrobbler')) return null;
      return wikipediaChain(url);
    };
    expect(await getArtistBio('ar-id')).toBeNull();
  });

  it('uses Last.fm, by name, for an artist without an identity', async () => {
    respond = (url) =>
      url.includes('audioscrobbler')
        ? {
            artist: {
              url: 'https://www.last.fm/music/Unidentified+Band',
              bio: {
                summary:
                  'A band from Utrecht. <a href="https://www.last.fm/music/Unidentified+Band">Read more on Last.fm</a>',
              },
            },
          }
        : null;
    const bio = await getArtistBio('ar-name');
    expect(bio?.source).toBe('lastfm');
    expect(bio?.summary).toBe('A band from Utrecht.');
    expect(bio?.license).toMatch(/Last\.fm/);
    // No MBID, so MusicBrainz and Wikidata are never asked.
    expect(calls.some((u) => u.includes('musicbrainz') || u.includes('wikidata'))).toBe(false);
    expect(calls.find((u) => u.includes('audioscrobbler'))).toContain('artist=Unidentified%20Band');
  });

  it('asks Last.fm by MBID when the artist has one', async () => {
    respond = (url) =>
      url.includes('audioscrobbler')
        ? { artist: { bio: { summary: 'Rock-n-roll junkie.' } } }
        : null;
    await getArtistBio('ar-id');
    expect(calls.find((u) => u.includes('audioscrobbler'))).toContain('mbid=mb-1');
  });

  it('serves the second visit from the cache, without a single request', async () => {
    respond = wikipediaChain;
    await getArtistBio('ar-id');
    calls = [];
    const again = await getArtistBio('ar-id');
    expect(again?.source).toBe('wikipedia');
    expect(calls).toEqual([]);
  });

  it('caches a miss, for a shorter time than a hit', async () => {
    respond = () => null;
    expect(await getArtistBio('ar-name')).toBeNull();
    calls = [];
    expect(await getArtistBio('ar-name')).toBeNull();
    expect(calls).toEqual([]);

    const row = getRawDb()
      .prepare("SELECT fetched_at, expires_at FROM artist_bios WHERE artist_id = 'ar-name'")
      .get() as { fetched_at: number; expires_at: number };
    expect(row.expires_at - row.fetched_at).toBe(MISS_TTL_SECONDS);
    expect(MISS_TTL_SECONDS).toBeLessThan(BIO_TTL_SECONDS);

    // Once the miss expires, the artist is asked about again.
    clock += MISS_TTL_SECONDS + 1;
    await getArtistBio('ar-name');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('keeps an expired biography when the refresh finds nothing', async () => {
    respond = wikipediaChain;
    await getArtistBio('ar-id');
    clock += BIO_TTL_SECONDS + 1;
    respond = () => null; // every source is down
    const bio = await getArtistBio('ar-id');
    expect(bio?.summary).toMatch(/Nederlandse muzikant/);
  });

  it('strips the Last.fm link and licence footer', () => {
    expect(
      cleanLastfmSummary(
        'Great band.  <a href="x">Read more on Last.fm</a>. User-contributed text is available under the Creative Commons By-SA License.',
      ),
    ).toBe('Great band.');
  });

  it('answers over HTTP, and 404 for an unknown artist', async () => {
    respond = wikipediaChain;
    const res = await request(app).get('/api/library/artists/ar-id/bio');
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('wikipedia');
    expect((await request(app).get('/api/library/artists/nobody/bio')).status).toBe(404);
  });
});

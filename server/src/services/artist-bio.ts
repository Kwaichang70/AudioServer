import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';
import { MUSICBRAINZ_HEADERS, mbFetch } from './musicbrainz.js';

/**
 * Artist biographies (R04.1).
 *
 * Where a biography comes from decides whether it can be trusted, so the
 * route is fixed and every step is identity-based rather than name-based:
 *
 *   artist MBID → MusicBrainz url-relation → Wikidata item → Wikipedia article
 *
 * Dutch first, English second. Only when that chain does not exist does the
 * Last.fm wiki text step in — by MBID when we have one, by name otherwise,
 * because a name lookup on "Genesis" or "Nirvana" can return someone else.
 * Whatever is shown carries its source, a link to it and its licence: both
 * Wikipedia and the Last.fm wiki are CC BY-SA, which requires exactly that.
 *
 * Results are cached in the database. A biography changes rarely, and a page
 * that waits on three external services on every visit is a slow page; the
 * second visit is served from the cache. "Nothing found" is cached too, for a
 * shorter time, so an artist without a Wikipedia page does not cost three
 * requests every time someone opens it.
 */

export interface ArtistBio {
  artistId: string;
  summary: string;
  /** 'wikipedia' | 'lastfm' */
  source: 'wikipedia' | 'lastfm';
  /** Language of the text, e.g. 'nl' or 'en'. */
  language: string | null;
  /** Where the full text lives; shown as "read more". */
  url: string | null;
  /** The licence the text is published under, shown next to it. */
  license: string;
  fetchedAt: number;
}

/** Positive results are kept a month, misses three days. */
export const BIO_TTL_SECONDS = 30 * 86400;
export const MISS_TTL_SECONDS = 3 * 86400;
/** Languages tried, in order. */
export const BIO_LANGUAGES = ['nl', 'en'] as const;

export interface BioDeps {
  fetch: typeof fetch;
  now: () => number;
  lastfmKey: () => string | undefined;
}

let deps: BioDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Math.floor(Date.now() / 1000),
  lastfmKey: () => process.env.LASTFM_API_KEY || undefined,
};

export function configureArtistBio(overrides: Partial<BioDeps>): void {
  deps = { ...deps, ...overrides };
}

interface CacheRow {
  artist_id: string;
  summary: string | null;
  source: string | null;
  language: string | null;
  url: string | null;
  license: string | null;
  fetched_at: number;
  expires_at: number;
}

function readCache(artistId: string): { bio: ArtistBio | null; fresh: boolean } | null {
  try {
    const row = getRawDb()
      .prepare('SELECT * FROM artist_bios WHERE artist_id = ?')
      .get(artistId) as CacheRow | undefined;
    if (!row) return null;
    const fresh = row.expires_at > deps.now();
    const bio =
      row.summary && row.source
        ? {
            artistId,
            summary: row.summary,
            source: row.source as ArtistBio['source'],
            language: row.language,
            url: row.url,
            license: row.license ?? '',
            fetchedAt: row.fetched_at,
          }
        : null;
    return { bio, fresh };
  } catch {
    return null;
  }
}

function writeCache(artistId: string, bio: Omit<ArtistBio, 'artistId' | 'fetchedAt'> | null) {
  const now = deps.now();
  try {
    getRawDb()
      .prepare(
        `INSERT INTO artist_bios (artist_id, summary, source, language, url, license, fetched_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(artist_id) DO UPDATE SET
           summary = excluded.summary, source = excluded.source, language = excluded.language,
           url = excluded.url, license = excluded.license,
           fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      )
      .run(
        artistId,
        bio?.summary ?? null,
        bio?.source ?? null,
        bio?.language ?? null,
        bio?.url ?? null,
        bio?.license ?? null,
        now,
        now + (bio ? BIO_TTL_SECONDS : MISS_TTL_SECONDS),
      );
  } catch (err) {
    logger.debug(`ArtistBio: could not cache ${artistId}: ${err}`);
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await deps.fetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    logger.debug(`ArtistBio: ${url} failed: ${err}`);
    return null;
  }
}

/** The Wikidata item an artist's MusicBrainz entry points at, e.g. "Q2831". */
async function wikidataIdFor(mbid: string): Promise<string | null> {
  try {
    const res = await mbFetch(`/artist/${encodeURIComponent(mbid)}?inc=url-rels&fmt=json`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      relations?: Array<{ type?: string; url?: { resource?: string } }>;
    };
    const link = data.relations?.find((r) => r.type === 'wikidata')?.url?.resource;
    return link?.split('/').pop() ?? null;
  } catch (err) {
    logger.debug(`ArtistBio: MusicBrainz relations of ${mbid} failed: ${err}`);
    return null;
  }
}

/** The Wikipedia article titles of a Wikidata item, per language. */
async function wikipediaTitles(qid: string): Promise<Partial<Record<string, string>>> {
  const data = await getJson<{
    entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }>;
  }>(`https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`, {
    headers: MUSICBRAINZ_HEADERS,
  });
  const links = data?.entities?.[qid]?.sitelinks ?? {};
  const titles: Partial<Record<string, string>> = {};
  for (const lang of BIO_LANGUAGES) {
    const title = links[`${lang}wiki`]?.title;
    if (title) titles[lang] = title;
  }
  return titles;
}

async function fromWikipedia(
  mbid: string,
): Promise<Omit<ArtistBio, 'artistId' | 'fetchedAt'> | null> {
  const qid = await wikidataIdFor(mbid);
  if (!qid) return null;
  const titles = await wikipediaTitles(qid);
  for (const lang of BIO_LANGUAGES) {
    const title = titles[lang];
    if (!title) continue;
    const summary = await getJson<{
      extract?: string;
      type?: string;
      content_urls?: { desktop?: { page?: string } };
    }>(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      { headers: MUSICBRAINZ_HEADERS },
    );
    // A disambiguation page is a list of other pages, not this artist.
    if (!summary?.extract || summary.type === 'disambiguation') continue;
    return {
      summary: summary.extract.trim(),
      source: 'wikipedia',
      language: lang,
      url: summary.content_urls?.desktop?.page ?? null,
      license: 'CC BY-SA 4.0 — Wikipedia',
    };
  }
  return null;
}

/** Last.fm's wiki text ends with a "Read more on Last.fm" link; drop it. */
export function cleanLastfmSummary(text: string): string {
  return text
    .replace(/<a\b[^>]*>.*?<\/a>\.?/gis, '')
    .replace(/<[^>]+>/g, '')
    .replace(/User-contributed text is available under.*$/is, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fromLastfm(
  name: string,
  mbid: string | null,
): Promise<Omit<ArtistBio, 'artistId' | 'fetchedAt'> | null> {
  const key = deps.lastfmKey();
  if (!key) return null;
  // By MBID when we have one: a name lookup on a common band name can land
  // on a different artist with the same name.
  const who = mbid ? `mbid=${encodeURIComponent(mbid)}` : `artist=${encodeURIComponent(name)}`;
  const data = await getJson<{
    artist?: { url?: string; bio?: { summary?: string } };
  }>(
    `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&${who}&api_key=${key}&format=json&lang=nl`,
  );
  const summary = data?.artist?.bio?.summary ? cleanLastfmSummary(data.artist.bio.summary) : '';
  if (!summary) return null;
  return {
    summary,
    source: 'lastfm',
    language: null,
    url: data?.artist?.url ?? null,
    license: 'CC BY-SA — Last.fm (user-contributed)',
  };
}

/**
 * The biography of one artist: from the cache when it is fresh, otherwise
 * Wikipedia via the artist's identity, otherwise Last.fm, otherwise nothing —
 * and "nothing" is a cached answer too.
 */
export async function getArtistBio(
  artistId: string,
  options: { refresh?: boolean } = {},
): Promise<ArtistBio | null> {
  const cached = readCache(artistId);
  if (cached?.fresh && !options.refresh) return cached.bio;

  const artist = getRawDb()
    .prepare('SELECT id, name, mbid FROM artists WHERE id = ?')
    .get(artistId) as { id: string; name: string; mbid: string | null } | undefined;
  if (!artist) return null;

  const found =
    (artist.mbid ? await fromWikipedia(artist.mbid) : null) ??
    (await fromLastfm(artist.name, artist.mbid));

  // A failed refresh must not throw away a biography we already had: keep
  // showing the stale one rather than an empty space.
  if (!found && cached?.bio) return cached.bio;

  writeCache(artistId, found);
  return found ? { ...found, artistId, fetchedAt: deps.now() } : null;
}

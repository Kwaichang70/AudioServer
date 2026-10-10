import { logger } from '../logger.js';

/**
 * One door to MusicBrainz (R03.3).
 *
 * MusicBrainz asks for at most one request per second per application, and
 * that budget belongs to the whole server, not to each job. Before this
 * module the cover job kept its own timer; a second job with its own timer
 * would have doubled the rate while both believed they were being polite. So
 * every call goes through here, through one queue, with the user agent the
 * project is identified by.
 */

const API = 'https://musicbrainz.org/ws/2';
const USER_AGENT = 'AudioServer/1.0 (https://github.com/Kwaichang70/AudioServer)';
/** 1.1 s, so a clock that drifts slightly still stays under one per second. */
export const MIN_INTERVAL_MS = 1100;

export interface MusicBrainzDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

let deps: MusicBrainzDeps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function configureMusicBrainz(overrides: Partial<MusicBrainzDeps>): void {
  deps = { ...deps, ...overrides };
}

let lastRequestAt = 0;
/** Serialises the waiting, so ten callers at once still produce one per second. */
let queue: Promise<unknown> = Promise.resolve();

async function waitForTurn(): Promise<void> {
  const wait = Math.max(0, MIN_INTERVAL_MS - (deps.now() - lastRequestAt));
  if (wait > 0) await deps.sleep(wait);
  lastRequestAt = deps.now();
}

/**
 * Take a turn in the queue without making a request. The Cover Art Archive
 * is a different host but the same project's budget, so it waits here too.
 */
export async function awaitMusicBrainzTurn(): Promise<void> {
  const turn = queue.then(waitForTurn, waitForTurn);
  queue = turn;
  await turn;
}

/** A rate-limited GET against the MusicBrainz web service. */
export async function mbFetch(path: string): Promise<Response> {
  await awaitMusicBrainzTurn();
  return deps.fetch(`${API}${path}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
}

/** The headers every request of this project identifies itself with. */
export const MUSICBRAINZ_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
} as const;

export interface ReleaseCandidate {
  mbid: string;
  title: string;
  artist: string;
  artistMbid?: string;
  releaseGroupMbid?: string;
  label?: string;
  catalogNumber?: string;
  date?: string;
  trackCount?: number;
  /** MusicBrainz's own search score, 0–100. */
  score: number;
}

interface SearchResponse {
  releases?: Array<{
    id: string;
    title?: string;
    score?: number;
    date?: string;
    'track-count'?: number;
    'artist-credit'?: Array<{ name?: string; artist?: { id?: string; name?: string } }>;
    'release-group'?: { id?: string };
    'label-info'?: Array<{ 'catalog-number'?: string; label?: { name?: string } }>;
    media?: Array<{ 'track-count'?: number }>;
  }>;
}

/** Lucene is picky about quotes and colons; a tag can contain both. */
function escapeQuery(value: string): string {
  return value
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Search releases by artist, title and track count. The track count is part
 * of the query rather than a filter afterwards, because it is the cheapest
 * way to keep a single-disc album from matching a box set.
 */
export async function searchReleases(input: {
  artist: string;
  title: string;
  trackCount?: number;
  limit?: number;
}): Promise<ReleaseCandidate[]> {
  const artist = escapeQuery(input.artist);
  const title = escapeQuery(input.title);
  if (!artist || !title) return [];
  const parts = [`release:"${title}"`, `artist:"${artist}"`];
  if (input.trackCount && input.trackCount > 0) parts.push(`tracks:${input.trackCount}`);
  const query = encodeURIComponent(parts.join(' AND '));
  try {
    const res = await mbFetch(`/release?query=${query}&limit=${input.limit ?? 5}&fmt=json`);
    if (!res.ok) {
      logger.debug(`MusicBrainz: search returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as SearchResponse;
    return (data.releases ?? []).map((release) => {
      const credit = release['artist-credit']?.[0];
      const labelInfo = release['label-info']?.[0];
      const media = release.media ?? [];
      return {
        mbid: release.id,
        title: release.title ?? '',
        artist: credit?.artist?.name ?? credit?.name ?? '',
        artistMbid: release['artist-credit']?.length === 1 ? credit?.artist?.id : undefined,
        releaseGroupMbid: release['release-group']?.id,
        label: labelInfo?.label?.name,
        catalogNumber: labelInfo?.['catalog-number'],
        date: release.date,
        trackCount:
          release['track-count'] ??
          (media.length > 0
            ? media.reduce((sum, m) => sum + (m['track-count'] ?? 0), 0)
            : undefined),
        score: release.score ?? 0,
      };
    });
  } catch (err) {
    logger.debug(`MusicBrainz: search failed: ${err}`);
    return [];
  }
}

/** One release by id, for a choice an admin made by hand. */
export async function lookupRelease(mbid: string): Promise<ReleaseCandidate | null> {
  try {
    const res = await mbFetch(
      `/release/${encodeURIComponent(mbid)}?inc=artist-credits+labels+release-groups&fmt=json`,
    );
    if (!res.ok) return null;
    const release = (await res.json()) as NonNullable<SearchResponse['releases']>[number];
    // A 200 is not the same as a release: an error body parses fine and would
    // otherwise become an identity with an undefined id.
    if (!release?.id) return null;
    const credit = release['artist-credit']?.[0];
    const labelInfo = release['label-info']?.[0];
    return {
      mbid: release.id,
      title: release.title ?? '',
      artist: credit?.artist?.name ?? credit?.name ?? '',
      artistMbid: release['artist-credit']?.length === 1 ? credit?.artist?.id : undefined,
      releaseGroupMbid: release['release-group']?.id,
      label: labelInfo?.label?.name,
      catalogNumber: labelInfo?.['catalog-number'],
      date: release.date,
      trackCount: release['track-count'],
      score: 100,
    };
  } catch (err) {
    logger.debug(`MusicBrainz: lookup of ${mbid} failed: ${err}`);
    return null;
  }
}

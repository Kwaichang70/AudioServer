import { getRawDb } from '../db/index.js';
import { getCapabilities, sourceOf } from './playback-resolver.js';

/**
 * Shuffle rounds (V12.3).
 *
 * Random-with-replacement is what most players call shuffle: every track end
 * draws a new random position, so a ten-track queue happily plays the same
 * song three times before touching the fourth. A ROUND is the alternative
 * this module implements: every queue position is played exactly once, in a
 * random order, and only when the round is empty does anything repeat — and
 * then only if repeat is on. With repeat off, the round IS the queue: it ends
 * when everything has been heard once.
 *
 * Two preferences shape the order inside a round:
 *
 * - **Less recently heard first.** Not a strict sort — that would make
 *   "shuffle" deterministic — but two buckets: what the listener has not
 *   heard in the last month (or ever) is drawn before what they heard last
 *   week, each bucket shuffled.
 * - **Nothing that cannot play.** A local file marked missing and a provider
 *   track whose source is not connected are left out of the round: a shuffle
 *   that lands on something unplayable spends the listener's attention on an
 *   error instead of music. They stay in the queue and can still be started
 *   by hand; the round simply does not choose them.
 */

export interface ShuffleCandidate {
  itemId: string;
  trackId: string;
  source?: string;
}

export interface ShuffleDeps {
  /** Can this track be started right now? */
  isPlayable: (trackId: string, source?: string) => boolean;
  /** Unix seconds of the last time this listener heard each track. */
  lastHeard: (trackIds: string[], userId: string | null) => Map<string, number>;
  random: () => number;
}

/** Heard within this many days counts as "recent" and goes in the second bucket. */
export const RECENT_DAYS = 30;

function localAvailability(trackId: string): string | null | undefined {
  try {
    const row = getRawDb().prepare('SELECT availability FROM tracks WHERE id = ?').get(trackId) as
      | { availability: string | null }
      | undefined;
    return row ? (row.availability ?? 'available') : undefined;
  } catch {
    return undefined;
  }
}

const defaults: ShuffleDeps = {
  isPlayable: (trackId, source) => {
    const kind = (source as ReturnType<typeof sourceOf>) || sourceOf(trackId);
    if (kind === 'local') {
      const availability = localAvailability(trackId);
      // A track the library has never heard of is not evidence of anything —
      // a queue can outlive a database that was restored from a backup — so
      // it is left in rather than quietly skipped.
      if (availability === undefined) return true;
      return availability !== 'missing';
    }
    try {
      const caps = getCapabilities(kind);
      return caps.serverDispatch || caps.browser || caps.externalPlayer !== null;
    } catch {
      return true;
    }
  },
  lastHeard: (trackIds, userId) => {
    const heard = new Map<string, number>();
    if (trackIds.length === 0) return heard;
    try {
      const placeholders = trackIds.map(() => '?').join(',');
      const rows = getRawDb()
        .prepare(
          `SELECT track_id, MAX(started_at) as last
             FROM listening_sessions
            WHERE track_id IN (${placeholders})
              AND started_at IS NOT NULL
              AND (? IS NULL OR user_id = ?)
            GROUP BY track_id`,
        )
        .all(...trackIds, userId, userId) as Array<{ track_id: string; last: number | null }>;
      for (const row of rows) if (row.last) heard.set(row.track_id, row.last);
    } catch {
      // No database, no history: every track is equally fresh.
    }
    return heard;
  },
  random: Math.random,
};

let deps: ShuffleDeps = { ...defaults };

export function configureShuffle(overrides: Partial<ShuffleDeps>): void {
  deps = { ...deps, ...overrides };
}

export function resetShuffleDeps(): void {
  deps = { ...defaults };
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(deps.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * The order of one round: every playable candidate exactly once, the ones
 * not heard lately first. Items that cannot play are not in the result.
 */
export function buildShuffleRound(
  candidates: ShuffleCandidate[],
  options: { userId?: string | null; now?: number } = {},
): string[] {
  const playable = candidates.filter((c) => deps.isPlayable(c.trackId, c.source));
  if (playable.length === 0) return [];

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const cutoff = now - RECENT_DAYS * 86400;
  const heard = deps.lastHeard(
    [...new Set(playable.map((c) => c.trackId))],
    options.userId ?? null,
  );

  const fresh: ShuffleCandidate[] = [];
  const recent: ShuffleCandidate[] = [];
  for (const candidate of playable) {
    const last = heard.get(candidate.trackId);
    if (last !== undefined && last >= cutoff) recent.push(candidate);
    else fresh.push(candidate);
  }

  return [...shuffled(fresh), ...shuffled(recent)].map((c) => c.itemId);
}

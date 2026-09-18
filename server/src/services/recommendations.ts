import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Recommendations (V12.2).
 *
 * Two things this module is strict about.
 *
 * **A name is not an identity.** "Adagio" by "The Orchestra" exists a hundred
 * times over, and a recommendation that starts a coincidentally same-named
 * track is worse than one that starts nothing. A match is therefore either
 * CERTAIN — title and artist agree exactly, ignoring case and punctuation —
 * or PROBABLE, and only a certain match may be played automatically. A
 * probable match is offered as a link the listener can follow, never started
 * on their behalf.
 *
 * **Every recommendation says where it came from.** Each item carries one
 * plain sentence of basis ("you played this artist eleven times in the last
 * six months"), and the listener can switch the personal basis off entirely —
 * then nothing from their history is read and the mix says so.
 *
 * A local mix needs no external account: the library and the listener's own
 * history are enough.
 */

export type MatchCertainty = 'certain' | 'probable';

export interface LocalMatch {
  trackId: string;
  albumId: string | null;
  title: string;
  artistName: string;
  albumTitle: string;
  duration: number | null;
  certainty: MatchCertainty;
  /** True when this track can be started right now. */
  playable: boolean;
  /** How the match was made, and what is uncertain about it. */
  note: string;
}

interface TrackRow {
  id: string;
  title: string;
  artist_name: string;
  album_title: string;
  album_id: string | null;
  duration: number | null;
  availability: string | null;
}

/**
 * Compare-form of a name: case, accents, punctuation and the usual release
 * decorations removed. Two names that differ only in those are the same name;
 * anything more is a different recording until something better than a string
 * says otherwise.
 */
export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(
      /\s*[([][^)\]]*(remaster|remastered|live|mono|stereo|version|edit|mix)[^)\]]*[)\]]/g,
      '',
    )
    .replace(/\s*-\s*(\d{4}\s+)?(remaster(ed)?|live|mono|stereo)(\s+\d{4})?$/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const SELECT_TRACK = `SELECT id, title, artist_name, album_title, album_id, duration, availability
                        FROM tracks`;

function rowsByExactNames(title: string, artist: string): TrackRow[] {
  try {
    return getRawDb()
      .prepare(`${SELECT_TRACK} WHERE LOWER(title) = LOWER(?) AND LOWER(artist_name) = LOWER(?)`)
      .all(title, artist) as TrackRow[];
  } catch {
    return [];
  }
}

function rowsByArtist(artist: string): TrackRow[] {
  try {
    return getRawDb()
      .prepare(`${SELECT_TRACK} WHERE LOWER(artist_name) = LOWER(?) LIMIT 2000`)
      .all(artist) as TrackRow[];
  } catch {
    return [];
  }
}

/** Artists whose name matches in compare-form; the artists table is small. */
function artistsLike(artist: string): string[] {
  const wanted = normalizeName(artist);
  if (!wanted) return [];
  try {
    const rows = getRawDb().prepare('SELECT name FROM artists').all() as Array<{ name: string }>;
    return rows.filter((r) => normalizeName(r.name) === wanted).map((r) => r.name);
  } catch {
    return [];
  }
}

function preferAvailable(rows: TrackRow[]): TrackRow | undefined {
  return rows.find((r) => r.availability !== 'missing') ?? rows[0];
}

function toMatch(row: TrackRow, certainty: MatchCertainty, note: string): LocalMatch {
  const available = row.availability !== 'missing';
  return {
    trackId: row.id,
    albumId: row.album_id,
    title: row.title,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    duration: row.duration,
    certainty,
    playable: certainty === 'certain' && available,
    note: available
      ? note
      : `${note} The file is marked missing, so it cannot be played until it is back.`,
  };
}

/**
 * Find the recommended recording in the local library.
 *
 * Certain: title and artist both agree, ignoring case, accents and
 * punctuation. Probable: they agree only after a release decoration
 * ("- 2011 Remaster", "(Live)") is dropped, which usually means the same
 * song and sometimes a different recording — so it is offered, not started.
 */
export function matchRecommendation(title: string, artist: string): LocalMatch | null {
  if (!title.trim() || !artist.trim()) return null;

  const exact = preferAvailable(rowsByExactNames(title, artist));
  if (exact) return toMatch(exact, 'certain', 'Title and artist match your library exactly.');

  const names = artistsLike(artist);
  if (names.length === 0) return null;

  const wantedTitle = normalizeName(title);
  const candidates = names.flatMap((name) => rowsByArtist(name));
  const sameName = candidates.filter((row) => normalizeName(row.title) === wantedTitle);
  if (sameName.length === 0) return null;

  const rawEqual = sameName.filter(
    (row) => row.title.trim().toLowerCase() === title.trim().toLowerCase(),
  );
  if (rawEqual.length > 0) {
    const row = preferAvailable(rawEqual);
    if (row) {
      return toMatch(
        row,
        'certain',
        'Title and artist match your library; only the spelling of the artist differs.',
      );
    }
  }

  const row = preferAvailable(sameName);
  if (!row) return null;
  return toMatch(
    row,
    'probable',
    `Your library has "${row.title}" by ${row.artist_name}, which may be this recording or another version of it. It is not started automatically.`,
  );
}

// ─── Preferences ─────────────────────────────────────────────────────────────

export interface RecommendationSettings {
  /** Read the listener's own history to build recommendations. */
  useHistory: boolean;
  /** Include the artists they marked as favourites. */
  useFavorites: boolean;
}

const DEFAULTS: RecommendationSettings = { useHistory: true, useFavorites: true };

export function getSettings(userId: string): RecommendationSettings {
  try {
    const rows = getRawDb()
      .prepare("SELECT key, value FROM user_preferences WHERE user_id = ? AND key LIKE 'rec.%'")
      .all(userId) as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      useHistory: map.get('rec.useHistory') !== '0',
      useFavorites: map.get('rec.useFavorites') !== '0',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSettings(
  userId: string,
  updates: Partial<RecommendationSettings>,
): RecommendationSettings {
  const db = getRawDb();
  const write = db.prepare(
    `INSERT INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
  );
  if (updates.useHistory !== undefined) {
    write.run(userId, 'rec.useHistory', updates.useHistory ? '1' : '0');
  }
  if (updates.useFavorites !== undefined) {
    write.run(userId, 'rec.useFavorites', updates.useFavorites ? '1' : '0');
  }
  return getSettings(userId);
}

// ─── A mix from the local library ────────────────────────────────────────────

export interface MixItem {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId: string | null;
  duration: number | null;
  source: 'local';
  /** Why this track is here, in one sentence the listener can check. */
  why: string;
  /** Which basis produced it, for grouping and for switching a basis off. */
  basis: 'history' | 'favorites' | 'library';
}

export interface LocalMix {
  items: MixItem[];
  /** What the mix was built from, in the listener's words. */
  basis: string;
  /** False when the personal basis is switched off; then nothing personal is read. */
  personalised: boolean;
}

const RECENT_DAYS = 30;
const HISTORY_DAYS = 180;

interface ArtistCount {
  artist_id: string | null;
  artist_name: string;
  plays: number;
}

function listenedArtists(userId: string, since: number): ArtistCount[] {
  try {
    return getRawDb()
      .prepare(
        `SELECT artist_id, artist_name, COUNT(*) as plays
           FROM listening_sessions
          WHERE user_id = ? AND qualified = 1 AND started_at IS NOT NULL AND started_at >= ?
          GROUP BY LOWER(artist_name)
          ORDER BY plays DESC
          LIMIT 25`,
      )
      .all(userId, since) as ArtistCount[];
  } catch {
    return [];
  }
}

function recentlyHeardTrackIds(userId: string, since: number): Set<string> {
  try {
    const rows = getRawDb()
      .prepare(
        `SELECT DISTINCT track_id FROM listening_sessions
          WHERE user_id = ? AND track_id IS NOT NULL AND started_at IS NOT NULL AND started_at >= ?`,
      )
      .all(userId, since) as Array<{ track_id: string }>;
    return new Set(rows.map((r) => r.track_id));
  } catch {
    return new Set();
  }
}

function favoriteArtistNames(userId: string): string[] {
  try {
    const rows = getRawDb()
      .prepare(
        `SELECT DISTINCT a.name as name
           FROM favorites f JOIN artists a ON a.id = f.item_id
          WHERE f.user_id = ? AND f.item_type = 'artist'
          LIMIT 25`,
      )
      .all(userId) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

function availableTracksByArtist(artistName: string, limit: number): TrackRow[] {
  try {
    return getRawDb()
      .prepare(
        `${SELECT_TRACK} WHERE LOWER(artist_name) = LOWER(?) AND availability != 'missing'
          ORDER BY RANDOM() LIMIT ?`,
      )
      .all(artistName, limit) as TrackRow[];
  } catch {
    return [];
  }
}

function randomAvailableTracks(limit: number): TrackRow[] {
  try {
    return getRawDb()
      .prepare(`${SELECT_TRACK} WHERE availability != 'missing' ORDER BY RANDOM() LIMIT ?`)
      .all(limit) as TrackRow[];
  } catch {
    return [];
  }
}

function toMixItem(row: TrackRow, basis: MixItem['basis'], why: string): MixItem {
  return {
    id: row.id,
    title: row.title,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    albumId: row.album_id,
    duration: row.duration,
    source: 'local',
    why,
    basis,
  };
}

/**
 * A mix from the listener's own library. No external account is involved:
 * their history and their library are enough, and when the personal basis is
 * switched off the mix is simply a draw from the library that says so.
 *
 * Tracks whose file is missing are left out: a mix that cannot play is not a
 * mix. Tracks heard in the last month are skipped too — a "discovery" that
 * plays what was on yesterday is not discovery.
 */
export function localMix(userId: string, options: { limit?: number } = {}): LocalMix {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const settings = getSettings(userId);
  const now = Math.floor(Date.now() / 1000);

  if (!settings.useHistory && !settings.useFavorites) {
    const items = randomAvailableTracks(limit).map((row) =>
      toMixItem(
        row,
        'library',
        'Picked from your library at random: recommendations from your listening history are switched off.',
      ),
    );
    return {
      items,
      basis:
        'Your listening history is not used. This is a random draw from the tracks in your library.',
      personalised: false,
    };
  }

  const skip = settings.useHistory
    ? recentlyHeardTrackIds(userId, now - RECENT_DAYS * 86400)
    : new Set<string>();
  const picked = new Map<string, MixItem>();

  if (settings.useHistory) {
    for (const artist of listenedArtists(userId, now - HISTORY_DAYS * 86400)) {
      if (picked.size >= limit) break;
      const plays = artist.plays;
      for (const row of availableTracksByArtist(artist.artist_name, 3)) {
        if (picked.size >= limit) break;
        if (skip.has(row.id) || picked.has(row.id)) continue;
        picked.set(
          row.id,
          toMixItem(
            row,
            'history',
            `You played ${artist.artist_name} ${plays} time${plays === 1 ? '' : 's'} in the last six months; this track has not been on in the last month.`,
          ),
        );
      }
    }
  }

  if (settings.useFavorites) {
    for (const name of favoriteArtistNames(userId)) {
      if (picked.size >= limit) break;
      for (const row of availableTracksByArtist(name, 2)) {
        if (picked.size >= limit) break;
        if (skip.has(row.id) || picked.has(row.id)) continue;
        picked.set(
          row.id,
          toMixItem(row, 'favorites', `${name} is one of your favourite artists.`),
        );
      }
    }
  }

  if (picked.size < limit) {
    for (const row of randomAvailableTracks(limit * 2)) {
      if (picked.size >= limit) break;
      if (skip.has(row.id) || picked.has(row.id)) continue;
      picked.set(
        row.id,
        toMixItem(row, 'library', 'From your library, to fill out the mix with something else.'),
      );
    }
  }

  const items = [...picked.values()];
  if (items.length === 0) {
    logger.debug(`Recommendations: no local mix for ${userId}; library may be empty`);
  }
  const parts: string[] = [];
  if (settings.useHistory) parts.push('the artists you played in the last six months');
  if (settings.useFavorites) parts.push('your favourite artists');
  return {
    items,
    basis: `Built from ${parts.join(' and ')}, without anything you heard in the last month. Nothing outside this server was asked.`,
    personalised: true,
  };
}

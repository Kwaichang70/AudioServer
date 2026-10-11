import { getRawDb } from '../db/index.js';
import { encodeRule, parseRuleParams, ruleSql, type Rule } from './focus-rules.js';

/**
 * Focus (R05.1): every list is a question to the library.
 *
 * One filter language for albums, tracks and artists, so a bookmark or a
 * smart playlist (R05.3) is the same question stored. The rules:
 *
 * - several values WITHIN one facet are OR  (genre = jazz OR blues)
 * - facets AMONG each other are AND          (jazz AND 1970s AND hi-res)
 * - facet counts are computed with every filter EXCEPT the facet's own, so
 *   the chips show what you could switch to, not just what you already have
 * - listening data is personal (V09): plays, last played, unplayed and
 *   favourites always mean "for the listener who asks"
 *
 * Nothing from the request reaches SQL as text: sort keys are looked up in a
 * whitelist, every value is a bound parameter.
 */

export const SORT_KEYS = [
  'title',
  'artist',
  'year',
  'added',
  'lastPlayed',
  'plays',
  'duration',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface FocusQuery {
  sort?: SortKey;
  order?: 'asc' | 'desc';
  genre?: string[];
  yearFrom?: number;
  yearTo?: number;
  format?: string[];
  quality?: 'lossless' | 'hires';
  source?: string[];
  favorite?: boolean;
  label?: string[];
  /** Composer artist ids. */
  composer?: string[];
  /** Played by this listener in the last N days. */
  playedWithin?: number;
  /** Added to the library in the last N days. */
  addedWithin?: number;
  /** Never played by this listener. */
  unplayed?: boolean;
  /** Show one edition per album, the best quality (R05.4). */
  dedupeEditions?: boolean;
  /** Field conditions, as the pre-Focus smart playlists had them (R05.3). */
  rules?: Rule[];
}

export type FacetKey =
  | 'genre'
  | 'year'
  | 'format'
  | 'quality'
  | 'source'
  | 'favorite'
  | 'label'
  | 'composer'
  | 'playedWithin'
  | 'addedWithin'
  | 'unplayed';

export const LOSSLESS_FORMATS = ['flac', 'wav', 'aiff', 'aif', 'alac', 'ape'];
/** A fixed whitelist, so it can be inlined as literals. */
const LOSSLESS_LIST = () => LOSSLESS_FORMATS.map((f) => `'${f}'`).join(',');

// ─── Parsing ────────────────────────────────────────────────────────────────

function list(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const out = raw
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 50);
  return out.length > 0 ? [...new Set(out)] : undefined;
}

function int(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(Math.max(Math.round(n), min), max);
}

function flag(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return value === true || value === 'true' || value === '1';
}

/**
 * Read a Focus query from request parameters. Arrays may come as repeated
 * keys (`genre=a&genre=b`), bracket keys or comma lists; anything unknown is
 * ignored rather than rejected, so an old bookmark never breaks a page.
 */
export function parseFocusQuery(input: Record<string, unknown>): FocusQuery {
  const get = (key: string) => input[key] ?? input[`${key}[]`];
  // A repeated scalar (`sort=a&sort=b`) arrives as an array: the first wins.
  const one = (key: string) => {
    const value = get(key);
    return Array.isArray(value) ? value[0] : value;
  };
  const sort = String(one('sort') ?? '');
  const quality = String(one('quality') ?? '');
  return {
    sort: (SORT_KEYS as readonly string[]).includes(sort) ? (sort as SortKey) : undefined,
    order: one('order') === 'desc' ? 'desc' : one('order') === 'asc' ? 'asc' : undefined,
    genre: list(get('genre')),
    yearFrom: int(one('yearFrom'), 0, 3000),
    yearTo: int(one('yearTo'), 0, 3000),
    format: list(get('format'))?.map((f) => f.toLowerCase()),
    quality: quality === 'lossless' || quality === 'hires' ? quality : undefined,
    source: list(get('source')),
    favorite: flag(one('favorite')),
    label: list(get('label')),
    composer: list(get('composer')),
    playedWithin: int(one('playedWithin'), 1, 36500),
    addedWithin: int(one('addedWithin'), 1, 36500),
    unplayed: flag(one('unplayed')),
    dedupeEditions: flag(one('dedupeEditions')),
    // JSON objects contain commas: never split these like the other lists.
    rules: parseRuleParams(
      (Array.isArray(get('rule'))
        ? (get('rule') as unknown[])
        : get('rule')
          ? [get('rule')]
          : []
      ).map(String),
    ),
  };
}

/** The query as URL parameters again — what a bookmark stores (R05.3). */
export function serializeFocusQuery(query: FocusQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === false) continue;
    if (key === 'rules') {
      (value as Rule[]).forEach((rule) => params.append('rule', encodeRule(rule)));
      continue;
    }
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.set(key, String(value));
  }
  return params.toString();
}

// ─── SQL building ───────────────────────────────────────────────────────────

interface Clause {
  sql: string[];
  params: unknown[];
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',');

const DAY = 86400;

/**
 * "Hide duplicate editions" (R05.4): one album per identity — the release
 * group when known, otherwise artist + title — keeping the best quality.
 * Ranked once over the whole table (a window, not a correlated subquery), so
 * it stays linear in the number of albums: the correlated form took 700 ms at
 * 10 000 tracks.
 */
const BEST_EDITIONS_SQL = `SELECT id FROM (
    SELECT b.id, ROW_NUMBER() OVER (
             PARTITION BY COALESCE(b.release_group_mbid, LOWER(b.artist_name) || '|' || LOWER(b.title))
             ORDER BY (COALESCE(b.bit_depth, 0) * COALESCE(b.sample_rate, 0)) DESC,
                      (LOWER(b.format) IN (${LOSSLESS_LIST()})) DESC,
                      b.id) as edition_rank
      FROM albums b)
   WHERE edition_rank = 1`;
const now = () => Math.floor(Date.now() / 1000);

/**
 * The WHERE clauses for albums (alias `a`). `except` leaves one facet out,
 * which is how facet counts show the alternatives within that facet.
 */
export function albumClauses(
  q: FocusQuery,
  userId: string | null,
  except?: FacetKey,
  played?: PlayedAlbums,
): Clause {
  const sql: string[] = [];
  const params: unknown[] = [];
  const add = (fragment: string, ...values: unknown[]) => {
    sql.push(fragment);
    params.push(...values);
  };

  if (q.genre && except !== 'genre') {
    add(
      `(a.id IN (SELECT album_id FROM album_genres WHERE genre IN (${placeholders(q.genre.length)}))
        OR a.genre IN (${placeholders(q.genre.length)}))`,
      ...q.genre,
      ...q.genre,
    );
  }
  if (except !== 'year') {
    if (q.yearFrom !== undefined) add('COALESCE(a.original_year, a.year) >= ?', q.yearFrom);
    if (q.yearTo !== undefined) add('COALESCE(a.original_year, a.year) <= ?', q.yearTo);
  }
  if (q.format && except !== 'format') {
    add(`LOWER(a.format) IN (${placeholders(q.format.length)})`, ...q.format);
  }
  if (q.quality && except !== 'quality') {
    add(`LOWER(a.format) IN (${placeholders(LOSSLESS_FORMATS.length)})`, ...LOSSLESS_FORMATS);
    if (q.quality === 'hires') add('(a.bit_depth > 16 OR a.sample_rate > 48000)');
  }
  if (q.source && except !== 'source') {
    add(`a.source IN (${placeholders(q.source.length)})`, ...q.source);
  }
  if (q.label && except !== 'label') {
    add(`a.label IN (${placeholders(q.label.length)})`, ...q.label);
  }
  if (q.composer && except !== 'composer') {
    add(
      `a.id IN (SELECT t.album_id FROM tracks t JOIN track_artists ta ON ta.track_id = t.id
                 WHERE ta.role = 'composer' AND ta.artist_id IN (${placeholders(q.composer.length)}))`,
      ...q.composer,
    );
  }
  if (q.addedWithin && except !== 'addedWithin') {
    add('a.created_at >= ?', now() - q.addedWithin * DAY);
  }
  if (q.dedupeEditions) add(`a.id IN (${BEST_EDITIONS_SQL})`);
  if (q.rules) {
    // Conditions are about tracks: an album answers when one of its tracks does.
    const rules = ruleSql(q.rules);
    add(
      `EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = a.id AND ${rules.sql.join(' AND ')})`,
      ...rules.params,
    );
  }
  if (userId) {
    if (q.favorite && except !== 'favorite') {
      add(
        `a.id IN (SELECT item_id FROM favorites WHERE user_id = ? AND item_type = 'album')`,
        userId,
      );
    }
    if (q.playedWithin && except !== 'playedWithin') {
      add(
        `a.id IN (SELECT t.album_id FROM listening_sessions ls JOIN tracks t ON t.id = ls.track_id
                   WHERE ls.user_id = ? AND ls.qualified = 1 AND ls.started_at >= ?)`,
        userId,
        now() - q.playedWithin * DAY,
      );
    }
    if (q.unplayed && except !== 'unplayed') {
      if (played) add('a.id NOT IN (SELECT value FROM json_each(?))', played.json);
      else add(`a.id NOT IN (${PLAYED_ALBUMS_SQL})`, userId);
    }
  }
  return { sql, params };
}

const PLAYED_ALBUMS_SQL = `SELECT DISTINCT t.album_id FROM listening_sessions ls JOIN tracks t ON t.id = ls.track_id
                            WHERE ls.user_id = ? AND ls.qualified = 1`;

/**
 * The albums one listener has played, worked out once. The facet counts run
 * ten queries per request; each would otherwise walk the whole listening
 * history again (measured: ~25 ms each at 40 000 plays).
 */
export interface PlayedAlbums {
  json: string;
}

function playedAlbums(userId: string): PlayedAlbums {
  const rows = getRawDb().prepare(PLAYED_ALBUMS_SQL).all(userId) as Array<{ album_id: string }>;
  return { json: JSON.stringify(rows.map((r) => r.album_id)) };
}

/** The same filters for tracks (alias `t`, its album joined as `a`). */
export function trackClauses(q: FocusQuery, userId: string | null, except?: FacetKey): Clause {
  const sql: string[] = [];
  const params: unknown[] = [];
  const add = (fragment: string, ...values: unknown[]) => {
    sql.push(fragment);
    params.push(...values);
  };

  if (q.genre && except !== 'genre') {
    add(
      `(t.id IN (SELECT track_id FROM track_genres WHERE genre IN (${placeholders(q.genre.length)}))
        OR a.id IN (SELECT album_id FROM album_genres WHERE genre IN (${placeholders(q.genre.length)}))
        OR a.genre IN (${placeholders(q.genre.length)}))`,
      ...q.genre,
      ...q.genre,
      ...q.genre,
    );
  }
  if (except !== 'year') {
    if (q.yearFrom !== undefined) add('COALESCE(a.original_year, a.year) >= ?', q.yearFrom);
    if (q.yearTo !== undefined) add('COALESCE(a.original_year, a.year) <= ?', q.yearTo);
  }
  if (q.format && except !== 'format') {
    add(`LOWER(t.format) IN (${placeholders(q.format.length)})`, ...q.format);
  }
  if (q.quality && except !== 'quality') {
    add(`LOWER(t.format) IN (${placeholders(LOSSLESS_FORMATS.length)})`, ...LOSSLESS_FORMATS);
    if (q.quality === 'hires') add('(t.bit_depth > 16 OR t.sample_rate > 48000)');
  }
  if (q.source && except !== 'source') {
    add(`t.source IN (${placeholders(q.source.length)})`, ...q.source);
  }
  if (q.label && except !== 'label') {
    add(`a.label IN (${placeholders(q.label.length)})`, ...q.label);
  }
  if (q.composer && except !== 'composer') {
    add(
      `t.id IN (SELECT track_id FROM track_artists
                 WHERE role = 'composer' AND artist_id IN (${placeholders(q.composer.length)}))`,
      ...q.composer,
    );
  }
  if (q.addedWithin && except !== 'addedWithin') {
    add('t.created_at >= ?', now() - q.addedWithin * DAY);
  }
  if (q.dedupeEditions) add(`t.album_id IN (${BEST_EDITIONS_SQL})`);
  if (q.rules) {
    const rules = ruleSql(q.rules);
    rules.sql.forEach((fragment) => sql.push(fragment));
    params.push(...rules.params);
  }
  if (userId) {
    if (q.favorite && except !== 'favorite') {
      add(
        `t.id IN (SELECT item_id FROM favorites WHERE user_id = ? AND item_type = 'track')`,
        userId,
      );
    }
    if (q.playedWithin && except !== 'playedWithin') {
      add(
        `t.id IN (SELECT track_id FROM listening_sessions
                   WHERE user_id = ? AND qualified = 1 AND started_at >= ?)`,
        userId,
        now() - q.playedWithin * DAY,
      );
    }
    if (q.unplayed && except !== 'unplayed') {
      add(
        `t.id NOT IN (SELECT track_id FROM listening_sessions
                       WHERE user_id = ? AND qualified = 1 AND track_id IS NOT NULL)`,
        userId,
      );
    }
  }
  return { sql, params };
}

const where = (clause: Clause) => (clause.sql.length ? `WHERE ${clause.sql.join(' AND ')}` : '');

// ─── Albums ─────────────────────────────────────────────────────────────────

export interface AlbumListOptions {
  limit: number;
  offset: number;
}

const ALBUM_ORDER: Record<SortKey, { expr: string; defaultOrder: 'asc' | 'desc' }> = {
  title: { expr: 'a.title COLLATE NOCASE', defaultOrder: 'asc' },
  artist: { expr: 'a.artist_name COLLATE NOCASE', defaultOrder: 'asc' },
  year: { expr: 'COALESCE(a.original_year, a.year)', defaultOrder: 'asc' },
  added: { expr: 'a.created_at', defaultOrder: 'desc' },
  lastPlayed: { expr: 'stats.last_played', defaultOrder: 'desc' },
  plays: { expr: 'stats.plays', defaultOrder: 'desc' },
  duration: { expr: 'dur.duration', defaultOrder: 'desc' },
};

/**
 * Albums for a Focus query, a page at a time. Returns the rows with the
 * listener's play count and last play, so the list can show them, and the
 * total that matches the whole query.
 */
export function focusAlbums(
  q: FocusQuery,
  userId: string | null,
  options: AlbumListOptions,
): { rows: Array<Record<string, unknown>>; total: number } {
  const db = getRawDb();
  const clause = albumClauses(q, userId);
  const sort = ALBUM_ORDER[q.sort ?? 'title'];
  const order = (q.order ?? sort.defaultOrder) === 'desc' ? 'DESC' : 'ASC';
  // NULLs last whichever way you sort: an unplayed album is not "most played".
  const orderBy = `${sort.expr} IS NULL, ${sort.expr} ${order}, a.title COLLATE NOCASE, a.id`;

  const stats = userId
    ? `LEFT JOIN (SELECT t.album_id, COUNT(*) as plays, MAX(ls.started_at) as last_played
                    FROM listening_sessions ls JOIN tracks t ON t.id = ls.track_id
                   WHERE ls.user_id = ? AND ls.qualified = 1
                   GROUP BY t.album_id) stats ON stats.album_id = a.id`
    : 'LEFT JOIN (SELECT NULL as album_id, NULL as plays, NULL as last_played) stats ON 0';
  const statsParams = userId ? [userId] : [];
  const duration =
    q.sort === 'duration'
      ? 'LEFT JOIN (SELECT album_id, SUM(duration) as duration FROM tracks GROUP BY album_id) dur ON dur.album_id = a.id'
      : 'LEFT JOIN (SELECT NULL as album_id, NULL as duration) dur ON 0';

  const filter = where(clause);

  const total =
    (
      db.prepare(`SELECT COUNT(*) as count FROM albums a ${filter}`).get(...clause.params) as {
        count: number;
      }
    )?.count ?? 0;

  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.artist_id as artistId, a.artist_name as artistName,
              COALESCE(a.original_year, a.year) as year, a.cover_url as coverUrl, a.genre,
              a.track_count as trackCount, a.source, a.format, a.sample_rate as sampleRate,
              a.bit_depth as bitDepth, a.label, a.replay_gain_album as replayGainAlbum,
              a.replay_gain_album_peak as replayGainAlbumPeak,
              a.created_at as createdAt, a.updated_at as updatedAt,
              stats.plays as plays, stats.last_played as lastPlayed
         FROM albums a ${stats} ${duration}
         ${filter}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
    )
    .all(...statsParams, ...clause.params, options.limit, options.offset) as Array<
    Record<string, unknown>
  >;
  return { rows, total };
}

// ─── Tracks ─────────────────────────────────────────────────────────────────

/** Album by album, each in its own running order — how a record is heard. */
const ALBUM_TRACK_ORDER =
  'a.title COLLATE NOCASE, t.album_id, t.disc_number, t.track_number, t.title COLLATE NOCASE';

const TRACK_ORDER: Record<SortKey, { expr: string; defaultOrder: 'asc' | 'desc' }> = {
  title: { expr: 't.title COLLATE NOCASE', defaultOrder: 'asc' },
  artist: { expr: 't.artist_name COLLATE NOCASE', defaultOrder: 'asc' },
  year: { expr: 'COALESCE(a.original_year, a.year)', defaultOrder: 'asc' },
  added: { expr: 't.created_at', defaultOrder: 'desc' },
  lastPlayed: { expr: 'stats.last_played', defaultOrder: 'desc' },
  plays: { expr: 'stats.plays', defaultOrder: 'desc' },
  duration: { expr: 't.duration', defaultOrder: 'desc' },
};

export function focusTracks(
  q: FocusQuery,
  userId: string | null,
  options: AlbumListOptions,
  defaultOrder = ALBUM_TRACK_ORDER,
): { rows: Array<Record<string, unknown>>; total: number } {
  return focusTrackGroups([q], q, userId, options, defaultOrder);
}

/**
 * Tracks matching ANY of several Focus queries (R05.3: the OR groups of a
 * smart playlist), in one order. A single group is just `focusTracks`.
 */
export function focusTrackGroups(
  groups: FocusQuery[],
  sortBy: Pick<FocusQuery, 'sort' | 'order'>,
  userId: string | null,
  options: AlbumListOptions,
  defaultOrder = ALBUM_TRACK_ORDER,
): { rows: Array<Record<string, unknown>>; total: number } {
  const db = getRawDb();
  const clauses = groups.map((group) => trackClauses(group, userId));
  // A group without conditions matches every track, and so does the OR.
  const matchesAll = clauses.length === 0 || clauses.some((c) => c.sql.length === 0);
  const filter = matchesAll
    ? ''
    : `WHERE ${clauses.map((c) => `(${c.sql.join(' AND ')})`).join(' OR ')}`;
  const filterParams = matchesAll ? [] : clauses.flatMap((c) => c.params);
  const stats = userId
    ? `LEFT JOIN (SELECT track_id, COUNT(*) as plays, MAX(started_at) as last_played
                    FROM listening_sessions WHERE user_id = ? AND qualified = 1
                   GROUP BY track_id) stats ON stats.track_id = t.id`
    : 'LEFT JOIN (SELECT NULL as track_id, NULL as plays, NULL as last_played) stats ON 0';
  const statsParams = userId ? [userId] : [];
  let orderBy = `${defaultOrder}, t.id`;
  if (sortBy.sort) {
    const sort = TRACK_ORDER[sortBy.sort];
    const order = (sortBy.order ?? sort.defaultOrder) === 'desc' ? 'DESC' : 'ASC';
    // Ties keep album order, so "sorted by year" still plays each album through.
    orderBy = `${sort.expr} IS NULL, ${sort.expr} ${order}, ${ALBUM_TRACK_ORDER}, t.id`;
  }

  const total =
    (
      db
        .prepare(
          `SELECT COUNT(*) as count FROM tracks t LEFT JOIN albums a ON a.id = t.album_id ${filter}`,
        )
        .get(...filterParams) as { count: number }
    )?.count ?? 0;

  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.album_id as albumId, t.album_title as albumTitle,
              t.artist_id as artistId, t.artist_name as artistName,
              t.artist_names as artistNames, t.composer, t.conductor,
              t.track_number as trackNumber, t.disc_number as discNumber, t.duration,
              t.format, t.sample_rate as sampleRate, t.bit_depth as bitDepth,
              t.file_path as filePath, t.cover_url as coverUrl,
              t.replay_gain_track as replayGainTrack, t.replay_gain_track_peak as replayGainTrackPeak,
              a.replay_gain_album as replayGainAlbum, a.replay_gain_album_peak as replayGainAlbumPeak,
              t.source, t.availability, t.created_at as createdAt, t.updated_at as updatedAt,
              stats.plays as plays, stats.last_played as lastPlayed
         FROM tracks t
         LEFT JOIN albums a ON a.id = t.album_id
         ${stats}
         ${filter}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
    )
    .all(...statsParams, ...filterParams, options.limit, options.offset) as Array<
    Record<string, unknown>
  >;
  return { rows, total };
}

// ─── Artists ────────────────────────────────────────────────────────────────

/**
 * Artists whose own albums answer the query. An artist list is a question
 * about their records ("who made hi-res jazz?"), so the album filters decide.
 */
export function focusArtists(
  q: FocusQuery,
  userId: string | null,
  options: AlbumListOptions,
): { rows: Array<Record<string, unknown>>; total: number } {
  const db = getRawDb();
  const clause = albumClauses(q, userId);
  const hasFilter = clause.sql.length > 0;
  const matching = hasFilter ? `ar.id IN (SELECT a.artist_id FROM albums a ${where(clause)})` : '1';
  const stats = userId
    ? `LEFT JOIN (SELECT t.artist_id, COUNT(*) as plays, MAX(ls.started_at) as last_played
                    FROM listening_sessions ls JOIN tracks t ON t.id = ls.track_id
                   WHERE ls.user_id = ? AND ls.qualified = 1
                   GROUP BY t.artist_id) stats ON stats.artist_id = ar.id`
    : 'LEFT JOIN (SELECT NULL as artist_id, NULL as plays, NULL as last_played) stats ON 0';
  const statsParams = userId ? [userId] : [];
  const sortKey = q.sort ?? 'title';
  const expr =
    sortKey === 'plays'
      ? 'stats.plays'
      : sortKey === 'lastPlayed'
        ? 'stats.last_played'
        : sortKey === 'added'
          ? 'ar.created_at'
          : 'ar.name COLLATE NOCASE';
  const defaultOrder = ['plays', 'lastPlayed', 'added'].includes(sortKey) ? 'desc' : 'asc';
  const order = (q.order ?? defaultOrder) === 'desc' ? 'DESC' : 'ASC';

  const total =
    (
      db
        .prepare(`SELECT COUNT(*) as count FROM artists ar WHERE ${matching}`)
        .get(...clause.params) as { count: number }
    )?.count ?? 0;
  const rows = db
    .prepare(
      `SELECT ar.id, ar.name, ar.image_url as imageUrl, ar.source,
              ar.created_at as createdAt, ar.updated_at as updatedAt,
              stats.plays as plays, stats.last_played as lastPlayed
         FROM artists ar ${stats}
        WHERE ${matching}
        ORDER BY ${expr} IS NULL, ${expr} ${order}, ar.name COLLATE NOCASE, ar.id
        LIMIT ? OFFSET ?`,
    )
    .all(...statsParams, ...clause.params, options.limit, options.offset) as Array<
    Record<string, unknown>
  >;
  return { rows, total };
}

// ─── Facets ─────────────────────────────────────────────────────────────────

export interface FacetValue {
  value: string;
  count: number;
}

export interface AlbumFacets {
  total: number;
  genre: FacetValue[];
  decade: FacetValue[];
  format: FacetValue[];
  quality: FacetValue[];
  source: FacetValue[];
  label: FacetValue[];
  composer: Array<FacetValue & { name: string }>;
  favorite: number;
  unplayed: number;
}

/**
 * Counts per facet value for albums, each computed with every filter except
 * the facet's own — so ticking "Jazz" still shows how many Blues albums there
 * would be, which is what makes the chips a menu rather than a receipt.
 */
export function albumFacets(q: FocusQuery, userId: string | null): AlbumFacets {
  const db = getRawDb();
  const played = userId ? playedAlbums(userId) : undefined;
  const run = <T>(sql: string, except: FacetKey | undefined, extra: unknown[] = []) => {
    const clause = albumClauses(q, userId, except, played);
    const filter = clause.sql.length ? `AND ${clause.sql.join(' AND ')}` : '';
    return db.prepare(sql.replace('/*FILTER*/', filter)).all(...extra, ...clause.params) as T[];
  };

  const total =
    run<{ count: number }>(
      'SELECT COUNT(*) as count FROM albums a WHERE 1 /*FILTER*/',
      undefined,
    )[0]?.count ?? 0;

  const genre = run<FacetValue>(
    `SELECT g.genre as value, COUNT(DISTINCT a.id) as count
       FROM albums a JOIN album_genres g ON g.album_id = a.id
      WHERE 1 /*FILTER*/
      GROUP BY g.genre ORDER BY count DESC, value LIMIT 60`,
    'genre',
  );
  const decade = run<{ value: number; count: number }>(
    `SELECT (COALESCE(a.original_year, a.year) / 10) * 10 as value, COUNT(*) as count
       FROM albums a
      WHERE COALESCE(a.original_year, a.year) IS NOT NULL /*FILTER*/
      GROUP BY value ORDER BY value`,
    'year',
  ).map((row) => ({ value: String(row.value), count: row.count }));
  const format = run<FacetValue>(
    `SELECT LOWER(a.format) as value, COUNT(*) as count FROM albums a
      WHERE a.format IS NOT NULL /*FILTER*/
      GROUP BY LOWER(a.format) ORDER BY count DESC`,
    'format',
  );
  const qualityRows = run<{ lossless: number | null; hires: number | null }>(
    `SELECT SUM(CASE WHEN LOWER(a.format) IN (${placeholders(LOSSLESS_FORMATS.length)}) THEN 1 ELSE 0 END) as lossless,
            SUM(CASE WHEN LOWER(a.format) IN (${placeholders(LOSSLESS_FORMATS.length)})
                      AND (a.bit_depth > 16 OR a.sample_rate > 48000) THEN 1 ELSE 0 END) as hires
       FROM albums a WHERE 1 /*FILTER*/`,
    'quality',
    [...LOSSLESS_FORMATS, ...LOSSLESS_FORMATS],
  )[0];
  const quality = [
    { value: 'lossless', count: qualityRows?.lossless ?? 0 },
    { value: 'hires', count: qualityRows?.hires ?? 0 },
  ];
  const source = run<FacetValue>(
    `SELECT a.source as value, COUNT(*) as count FROM albums a WHERE 1 /*FILTER*/
      GROUP BY a.source ORDER BY count DESC`,
    'source',
  );
  const label = run<FacetValue>(
    `SELECT a.label as value, COUNT(*) as count FROM albums a
      WHERE a.label IS NOT NULL AND a.label != '' /*FILTER*/
      GROUP BY a.label ORDER BY count DESC, value LIMIT 40`,
    'label',
  );
  const composer = run<{ value: string; name: string; count: number }>(
    `SELECT ar.id as value, ar.name as name, COUNT(DISTINCT a.id) as count
       FROM albums a
       JOIN tracks t ON t.album_id = a.id
       JOIN track_artists ta ON ta.track_id = t.id AND ta.role = 'composer'
       JOIN artists ar ON ar.id = ta.artist_id
      WHERE 1 /*FILTER*/
      GROUP BY ar.id ORDER BY count DESC, ar.name LIMIT 40`,
    'composer',
  );
  let favorite = 0;
  let unplayed = 0;
  if (userId) {
    favorite =
      run<{ count: number }>(
        `SELECT COUNT(*) as count FROM albums a
          WHERE a.id IN (SELECT item_id FROM favorites WHERE user_id = ? AND item_type = 'album')
          /*FILTER*/`,
        'favorite',
        [userId],
      )[0]?.count ?? 0;
    unplayed =
      run<{ count: number }>(
        `SELECT COUNT(*) as count FROM albums a
          WHERE a.id NOT IN (SELECT value FROM json_each(?)) /*FILTER*/`,
        'unplayed',
        [played!.json],
      )[0]?.count ?? 0;
  }
  return { total, genre, decade, format, quality, source, label, composer, favorite, unplayed };
}

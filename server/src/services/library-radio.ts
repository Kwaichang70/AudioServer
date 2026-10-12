import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';
import { getSimilarArtists, similarArtistsAvailable } from './similar-artists.js';
import type { TrackInfo } from './playback.js';

/**
 * Radio per zone (R08.1): the music does not stop.
 *
 * When a zone's queue is about to run out and radio is on, the server picks
 * the next tracks from the library — local files and added Qobuz albums —
 * close to a seed (an artist, album, track, genre or tag; or, when radio was
 * simply switched on, what is playing). Closeness comes from three things,
 * each of which becomes part of the "why" the player shows:
 *
 *   - Last.fm says the artist is related (when a Last.fm key is configured)
 *   - the album shares a genre
 *   - the track or album shares one of your tags
 *
 * Never chosen: anything that cannot play now, anything already in the
 * queue, and anything played or picked among the last 50. When nothing
 * qualifies the radio says so and stops instead of repeating itself.
 */

export type RadioSeedType = 'artist' | 'album' | 'track' | 'genre' | 'tag';

export interface RadioSeed {
  type: RadioSeedType;
  id: string;
  /** For people: "Miles Davis", "Kind of Blue", "Jazz". */
  label: string;
}

export interface RadioPick {
  track: TrackInfo;
  why: string;
}

export interface RadioState {
  enabled: boolean;
  /** Null: radio follows whatever is playing. */
  seed: RadioSeed | null;
  /** Reasons for the tracks radio picked, by track id (latest first wins). */
  reasons: Record<string, string>;
}

export const RECENT_WINDOW = 50;
const BATCH = 5;
const MAX_PER_ARTIST = 2;
const SIMILAR_TIMEOUT_MS = 1500;
const SIMILAR_TTL_MS = 24 * 60 * 60 * 1000;

interface RadioDeps {
  similar: (
    artistName: string,
  ) => Promise<Array<{ name: string; match: number; localArtistId: string | null }>>;
  similarAvailable: () => boolean;
  random: () => number;
  now: () => number;
}

const defaults = (): RadioDeps => ({
  similar: (name) => getSimilarArtists(name),
  similarAvailable: () => similarArtistsAvailable(),
  random: Math.random,
  now: () => Math.floor(Date.now() / 1000),
});

let deps = defaults();
const similarCache = new Map<
  string,
  { at: number; artists: Awaited<ReturnType<RadioDeps['similar']>> }
>();

export function configureRadio(overrides: Partial<RadioDeps>): void {
  deps = { ...defaults(), ...overrides };
  similarCache.clear();
}

export function resetRadio(): void {
  deps = defaults();
  similarCache.clear();
}

const db = () => getRawDb();
const PLAYABLE = "COALESCE(t.availability, 'available') NOT IN ('missing', 'unavailable')";

// ─── State ──────────────────────────────────────────────────────────────────

export function getRadioState(zoneId: string): RadioState {
  const row = db().prepare('SELECT enabled, seed FROM zone_radio WHERE zone_id = ?').get(zoneId) as
    | { enabled: number; seed: string | null }
    | undefined;
  const picks = db()
    .prepare('SELECT track_id, why FROM radio_picks WHERE zone_id = ? ORDER BY id DESC LIMIT 200')
    .all(zoneId) as Array<{ track_id: string; why: string }>;
  const reasons: Record<string, string> = {};
  for (const p of picks) if (!(p.track_id in reasons)) reasons[p.track_id] = p.why;
  let seed: RadioSeed | null = null;
  try {
    seed = row?.seed ? (JSON.parse(row.seed) as RadioSeed) : null;
  } catch {
    seed = null;
  }
  return { enabled: row?.enabled === 1, seed, reasons };
}

export function setRadio(
  zoneId: string,
  enabled: boolean,
  seed: RadioSeed | null,
  userId: string | null,
): RadioState {
  db()
    .prepare(
      `INSERT INTO zone_radio (zone_id, enabled, seed, user_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(zone_id) DO UPDATE SET enabled = excluded.enabled, seed = excluded.seed,
                                          user_id = excluded.user_id, updated_at = excluded.updated_at`,
    )
    .run(zoneId, enabled ? 1 : 0, seed ? JSON.stringify(seed) : null, userId, deps.now());
  return getRadioState(zoneId);
}

function radioOwner(zoneId: string): string | null {
  return (
    (
      db().prepare('SELECT user_id FROM zone_radio WHERE zone_id = ?').get(zoneId) as
        | { user_id: string | null }
        | undefined
    )?.user_id ?? null
  );
}

// ─── Seeds ──────────────────────────────────────────────────────────────────

/** A seed from what the request names; null when it does not exist. */
export function resolveSeed(
  type: RadioSeedType,
  id: string,
  userId: string | null,
): RadioSeed | null {
  const one = <T>(sql: string, ...params: unknown[]) =>
    db()
      .prepare(sql)
      .get(...params) as T | undefined;
  switch (type) {
    case 'artist': {
      const r = one<{ name: string }>('SELECT name FROM artists WHERE id = ?', id);
      return r ? { type, id, label: r.name } : null;
    }
    case 'album': {
      const r = one<{ title: string }>('SELECT title FROM albums WHERE id = ?', id);
      return r ? { type, id, label: r.title } : null;
    }
    case 'track': {
      const r = one<{ title: string }>('SELECT title FROM tracks WHERE id = ?', id);
      return r ? { type, id, label: r.title } : null;
    }
    case 'genre':
      return id.trim() ? { type, id: id.trim(), label: id.trim() } : null;
    case 'tag': {
      const r = one<{ name: string }>(
        'SELECT name FROM tags WHERE id = ? AND (user_id = ? OR shared = 1)',
        id,
        userId,
      );
      return r ? { type, id, label: r.name } : null;
    }
  }
}

interface SeedContext {
  artists: Map<string, string>; // id → name
  genres: Set<string>;
  tags: Map<string, string>; // id → name
}

function genresOfAlbums(albumIds: string[]): string[] {
  if (albumIds.length === 0) return [];
  const marks = albumIds.map(() => '?').join(',');
  const rows = db()
    .prepare(
      `SELECT genre, COUNT(*) as n FROM (
         SELECT genre FROM album_genres WHERE album_id IN (${marks})
         UNION ALL SELECT genre FROM albums WHERE id IN (${marks}) AND genre IS NOT NULL AND genre != ''
       ) GROUP BY genre ORDER BY n DESC LIMIT 3`,
    )
    .all(...albumIds, ...albumIds) as Array<{ genre: string }>;
  return rows.map((r) => r.genre);
}

function tagsOn(items: Array<[string, string]>, userId: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!userId) return out;
  const stmt = db().prepare(
    `SELECT tg.id, tg.name FROM tag_items ti JOIN tags tg ON tg.id = ti.tag_id
      WHERE ti.item_type = ? AND ti.item_id = ? AND (tg.user_id = ? OR tg.shared = 1)`,
  );
  for (const [type, id] of items) {
    for (const t of stmt.all(type, id, userId) as Array<{ id: string; name: string }>) {
      out.set(t.id, t.name);
    }
  }
  return out;
}

function seedContext(seed: RadioSeed, userId: string | null): SeedContext {
  const ctx: SeedContext = { artists: new Map(), genres: new Set(), tags: new Map() };
  const artistName = (id: string) =>
    (db().prepare('SELECT name FROM artists WHERE id = ?').get(id) as { name: string } | undefined)
      ?.name;
  if (seed.type === 'artist') {
    ctx.artists.set(seed.id, seed.label);
    const albums = (
      db().prepare('SELECT id FROM albums WHERE artist_id = ?').all(seed.id) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    genresOfAlbums(albums).forEach((g) => ctx.genres.add(g));
    tagsOn(
      [['artist', seed.id], ...albums.map((a) => ['album', a] as [string, string])],
      userId,
    ).forEach((name, id) => ctx.tags.set(id, name));
  } else if (seed.type === 'album' || seed.type === 'track') {
    const row = (
      seed.type === 'album'
        ? db().prepare('SELECT id as album_id, artist_id FROM albums WHERE id = ?').get(seed.id)
        : db().prepare('SELECT album_id, artist_id FROM tracks WHERE id = ?').get(seed.id)
    ) as { album_id: string; artist_id: string } | undefined;
    if (row) {
      const name = artistName(row.artist_id);
      if (name) ctx.artists.set(row.artist_id, name);
      genresOfAlbums([row.album_id]).forEach((g) => ctx.genres.add(g));
      const items: Array<[string, string]> = [
        ['album', row.album_id],
        ['artist', row.artist_id],
      ];
      if (seed.type === 'track') items.push(['track', seed.id]);
      tagsOn(items, userId).forEach((n, id) => ctx.tags.set(id, n));
    }
  } else if (seed.type === 'genre') {
    ctx.genres.add(seed.id);
  } else if (seed.type === 'tag') {
    ctx.tags.set(seed.id, seed.label);
    const albums = (
      db()
        .prepare(
          `SELECT item_id as id FROM tag_items WHERE tag_id = ? AND item_type = 'album'
           UNION SELECT album_id FROM tracks WHERE id IN (SELECT item_id FROM tag_items WHERE tag_id = ? AND item_type = 'track')`,
        )
        .all(seed.id, seed.id) as Array<{ id: string }>
    ).map((r) => r.id);
    genresOfAlbums(albums).forEach((g) => ctx.genres.add(g));
  }
  return ctx;
}

async function similarTo(names: string[]): Promise<Map<string, { match: number; via: string }>> {
  const out = new Map<string, { match: number; via: string }>();
  if (!deps.similarAvailable()) return out;
  for (const name of names.slice(0, 2)) {
    const key = name.toLowerCase();
    let cached = similarCache.get(key);
    if (!cached || Date.now() - cached.at > SIMILAR_TTL_MS) {
      try {
        const artists = await Promise.race([
          deps.similar(name),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), SIMILAR_TIMEOUT_MS),
          ),
        ]);
        cached = { at: Date.now(), artists };
        similarCache.set(key, cached);
      } catch (err) {
        // Last.fm slow or down: radio works from genres and tags alone.
        logger.debug(`Radio: no Last.fm similar artists for ${name}: ${err}`);
        continue;
      }
    }
    for (const a of cached.artists) {
      if (!a.localArtistId) continue;
      const prev = out.get(a.localArtistId);
      if (!prev || prev.match < a.match) out.set(a.localArtistId, { match: a.match, via: name });
    }
  }
  return out;
}

// ─── Picking ────────────────────────────────────────────────────────────────

interface CandidateRow {
  id: string;
  title: string;
  album_id: string;
  album_title: string;
  artist_id: string;
  artist_name: string;
  duration: number | null;
  format: string | null;
  sample_rate: number | null;
  bit_depth: number | null;
  source: string;
  replay_gain_track: number | null;
  replay_gain_track_peak: number | null;
  genres: string | null;
}

function toTrackInfo(row: CandidateRow): TrackInfo {
  const metadata: Record<string, unknown> = {};
  if (row.format) metadata.format = row.format;
  if (row.sample_rate) metadata.sampleRate = row.sample_rate;
  if (row.bit_depth) metadata.bitDepth = row.bit_depth;
  if (row.replay_gain_track !== null) metadata.replayGainTrack = row.replay_gain_track;
  if (row.replay_gain_track_peak !== null)
    metadata.replayGainTrackPeak = row.replay_gain_track_peak;
  return {
    id: row.id,
    title: row.title,
    artistName: row.artist_name,
    albumTitle: row.album_title,
    albumId: row.album_id,
    duration: row.duration ?? undefined,
    source: row.source,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/** Track ids radio must not choose now: queue, recent plays, recent picks. */
export function recentlyHeard(
  zoneId: string,
  queueTrackIds: string[],
  userId: string | null,
): Set<string> {
  const ids = new Set(queueTrackIds);
  const recentPicks = db()
    .prepare('SELECT track_id FROM radio_picks WHERE zone_id = ? ORDER BY id DESC LIMIT ?')
    .all(zoneId, RECENT_WINDOW) as Array<{ track_id: string }>;
  recentPicks.forEach((r) => ids.add(r.track_id));
  if (userId) {
    const played = db()
      .prepare(
        `SELECT track_id FROM listening_sessions WHERE user_id = ? AND track_id IS NOT NULL
          ORDER BY started_at DESC LIMIT ?`,
      )
      .all(userId, RECENT_WINDOW) as Array<{ track_id: string }>;
    played.forEach((r) => ids.add(r.track_id));
  }
  return ids;
}

/**
 * Up to `count` tracks close to the seed, each with its reason. An empty
 * result means: nothing in the library qualifies — not "try again".
 */
export async function pickRadioTracks(
  seed: RadioSeed,
  options: { count: number; exclude: Set<string>; userId: string | null },
): Promise<RadioPick[]> {
  const ctx = seedContext(seed, options.userId);
  const similar = await similarTo([...ctx.artists.values()]);
  const artistIds = [...new Set([...ctx.artists.keys(), ...similar.keys()])];
  const genres = [...ctx.genres];
  const tagIds = [...ctx.tags.keys()];
  if (artistIds.length === 0 && genres.length === 0 && tagIds.length === 0) return [];

  const conds: string[] = [];
  const params: unknown[] = [];
  const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');
  if (artistIds.length) {
    conds.push(
      `t.artist_id IN (${marks(artistIds.length)}) OR a.artist_id IN (${marks(artistIds.length)})`,
    );
    params.push(...artistIds, ...artistIds);
  }
  if (genres.length) {
    conds.push(
      `a.genre IN (${marks(genres.length)}) OR a.id IN (SELECT album_id FROM album_genres WHERE genre IN (${marks(genres.length)}))`,
    );
    params.push(...genres, ...genres);
  }
  if (tagIds.length) {
    conds.push(
      `t.id IN (SELECT item_id FROM tag_items WHERE item_type = 'track' AND tag_id IN (${marks(tagIds.length)}))
       OR a.id IN (SELECT item_id FROM tag_items WHERE item_type = 'album' AND tag_id IN (${marks(tagIds.length)}))
       OR t.artist_id IN (SELECT item_id FROM tag_items WHERE item_type = 'artist' AND tag_id IN (${marks(tagIds.length)}))`,
    );
    params.push(...tagIds, ...tagIds, ...tagIds);
  }
  const rows = db()
    .prepare(
      `SELECT t.id, t.title, t.album_id, t.album_title, t.artist_id, t.artist_name, t.duration,
              t.format, t.sample_rate, t.bit_depth, t.source,
              t.replay_gain_track, t.replay_gain_track_peak,
              COALESCE((SELECT group_concat(genre, '|') FROM album_genres WHERE album_id = a.id), '') ||
                COALESCE('|' || a.genre, '') as genres
         FROM tracks t JOIN albums a ON a.id = t.album_id
        WHERE ${PLAYABLE} AND (${conds.map((c) => `(${c})`).join(' OR ')})
        ORDER BY RANDOM() LIMIT 1500`,
    )
    .all(...params) as CandidateRow[];

  const tagsOfTrack = (row: CandidateRow): string[] => {
    if (tagIds.length === 0) return [];
    return (
      db()
        .prepare(
          `SELECT DISTINCT tag_id FROM tag_items
            WHERE tag_id IN (${marks(tagIds.length)})
              AND ((item_type = 'track' AND item_id = ?) OR (item_type = 'album' AND item_id = ?)
                OR (item_type = 'artist' AND item_id = ?))`,
        )
        .all(...tagIds, row.id, row.album_id, row.artist_id) as Array<{ tag_id: string }>
    ).map((r) => r.tag_id);
  };

  const scored = rows
    .filter((row) => !options.exclude.has(row.id))
    .map((row) => {
      const why: string[] = [];
      let score = deps.random() * 1.5;
      if (ctx.artists.has(row.artist_id)) {
        score += 2.5;
        why.push(seed.type === 'artist' ? `by ${row.artist_name}` : `also by ${row.artist_name}`);
      } else if (similar.has(row.artist_id)) {
        const s = similar.get(row.artist_id)!;
        score += 1 + 3 * s.match;
        why.push(`related to ${s.via} (Last.fm)`);
      }
      const rowGenres = (row.genres ?? '').split('|').filter(Boolean);
      const sharedGenre = genres.find((g) =>
        rowGenres.some((rg) => rg.toLowerCase() === g.toLowerCase()),
      );
      if (sharedGenre) {
        score += 2;
        why.push(`genre ${sharedGenre}`);
      }
      const sharedTag = tagsOfTrack(row)[0];
      if (sharedTag) {
        score += 2;
        why.push(`tag ${ctx.tags.get(sharedTag)}`);
      }
      return { row, score, why };
    })
    .filter((c) => c.why.length > 0)
    .sort((a, b) => b.score - a.score);

  // Variety: at most two per artist and one per album in a batch, and never
  // the same artist twice in a row when there is anyone else.
  const picks: RadioPick[] = [];
  const perArtist = new Map<string, number>();
  const albums = new Set<string>();
  const pool = [...scored];
  while (picks.length < options.count && pool.length > 0) {
    const last = picks[picks.length - 1]?.track;
    let index = pool.findIndex(
      (c) =>
        (perArtist.get(c.row.artist_id) ?? 0) < MAX_PER_ARTIST &&
        !albums.has(c.row.album_id) &&
        c.row.artist_name !== last?.artistName,
    );
    if (index < 0)
      index = pool.findIndex((c) => (perArtist.get(c.row.artist_id) ?? 0) < MAX_PER_ARTIST);
    if (index < 0) break;
    const [chosen] = pool.splice(index, 1);
    perArtist.set(chosen.row.artist_id, (perArtist.get(chosen.row.artist_id) ?? 0) + 1);
    albums.add(chosen.row.album_id);
    const why = chosen.why.join(' · ');
    picks.push({ track: toTrackInfo(chosen.row), why: why.charAt(0).toUpperCase() + why.slice(1) });
  }
  return picks;
}

export function rememberPicks(zoneId: string, picks: RadioPick[]): void {
  const insert = db().prepare(
    'INSERT INTO radio_picks (zone_id, track_id, why, picked_at) VALUES (?, ?, ?, ?)',
  );
  const t = deps.now();
  db().transaction(() => {
    for (const p of picks) insert.run(zoneId, p.track.id, p.why, t);
  })();
  // Keep the log short: the window radio looks back on, and some slack.
  db()
    .prepare(
      `DELETE FROM radio_picks WHERE zone_id = ? AND id NOT IN
         (SELECT id FROM radio_picks WHERE zone_id = ? ORDER BY id DESC LIMIT 500)`,
    )
    .run(zoneId, zoneId);
}

// ─── Topping up a zone ──────────────────────────────────────────────────────

export interface RadioZoneAccess {
  /** Track ids in the zone's queue, and the track playing now. */
  queue: (zoneId: string) => { trackIds: string[]; current: { id: string; title: string } | null };
  append: (zoneId: string, tracks: TrackInfo[]) => void;
  announce: (zoneId: string, state: RadioState & { note?: string }) => void;
}

let access: RadioZoneAccess | null = null;
const filling = new Set<string>();

export function connectRadio(zoneAccess: RadioZoneAccess | null): void {
  access = zoneAccess;
}

/**
 * Called when a zone starts a track. With radio on and fewer than three
 * tracks left, picks the next batch and appends it.
 */
export async function topUp(zoneId: string, remaining: number): Promise<RadioPick[]> {
  if (!access || remaining >= 3 || filling.has(zoneId)) return [];
  const state = getRadioState(zoneId);
  if (!state.enabled) return [];
  filling.add(zoneId);
  try {
    const { trackIds, current } = access.queue(zoneId);
    const seed: RadioSeed | null =
      state.seed ?? (current ? { type: 'track', id: current.id, label: current.title } : null);
    if (!seed) return [];
    const userId = radioOwner(zoneId);
    const picks = await pickRadioTracks(seed, {
      count: BATCH,
      exclude: recentlyHeard(zoneId, trackIds, userId),
      userId,
    });
    if (picks.length === 0) {
      access.announce(zoneId, {
        ...getRadioState(zoneId),
        note: 'Radio found nothing new to play near this; it stops here.',
      });
      return [];
    }
    rememberPicks(zoneId, picks);
    access.append(
      zoneId,
      picks.map((p) => p.track),
    );
    access.announce(zoneId, getRadioState(zoneId));
    return picks;
  } catch (err) {
    logger.warn(`Radio: could not top up ${zoneId}: ${err}`);
    return [];
  } finally {
    filling.delete(zoneId);
  }
}

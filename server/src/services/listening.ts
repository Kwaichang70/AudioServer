import { randomUUID } from 'crypto';
import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';
import { scrobbler, type ScrobbleTrack } from './scrobbler.js';
import type { ListeningObserver, TrackInfo } from './playback.js';
import { DEFAULT_ZONE_ID } from '../db/index.js';

/**
 * Listening sessions (V05.2 / V05.3).
 *
 * One session per track start. It is the single source of "listened": history,
 * statistics and scrobbles all derive from it, so a failed play, an immediate
 * skip or a track paused for an hour never counts as a listen.
 *
 * Listened time is wall-clock time spent in the playing state, confirmed by
 * heartbeats: the device monitor's status samples for a speaker the NAS
 * drives, a progress report every few seconds for a browser that plays
 * itself. Each confirmed interval is capped (HEARTBEAT_CAP_MS), so a tab that
 * dies without saying goodbye adds at most one cap of phantom time. Seeking
 * does not add time (only elapsed playing time counts), pausing stops the
 * clock, and two controllers reporting the same session cannot double-count
 * because every heartbeat only credits the time since the previous one.
 *
 * Qualification follows Last.fm's rule: the track is longer than 30 s and
 * at least half of it, or four minutes, was heard, whichever comes first.
 * Without a known length, four minutes.
 *
 * One open session per zone (P07). With a single one for the whole house, a
 * track starting in the kitchen ended the living room's listen, and the
 * living room's heartbeats then credited the kitchen's track.
 */

export const HEARTBEAT_CAP_MS = 45_000;
export const MIN_TRACK_SECONDS = 30;
export const QUALIFY_CAP_SECONDS = 240;
const PERSIST_EVERY_MS = 10_000;

export interface ListeningTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle?: string | null;
  albumId?: string | null;
  artistId?: string | null;
  duration?: number | null;
  source?: string | null;
}

export interface ListeningContext {
  /** The room this listen happens in; the default zone when not said. */
  zoneId?: string | null;
  queueItemId?: string | null;
  deviceId?: string | null;
  userId?: string | null;
  /** Whether audio is already flowing when the session starts. */
  playing?: boolean;
}

export type SessionStatus = 'active' | 'ended' | 'failed';

interface ActiveSession {
  id: string;
  track: ListeningTrack;
  source: string;
  queueItemId: string | null;
  deviceId: string | null;
  userId: string | null;
  startedAtMs: number;
  listenedMs: number;
  /** Timestamp of the last confirmation that audio was playing, or null while not playing. */
  lastTickMs: number | null;
  persistedListenedMs: number;
}

export interface ListeningPolicy {
  /** Submit Spotify listens to Last.fm/ListenBrainz (off: Spotify scrobbles those itself). */
  scrobbleSpotify: boolean;
}

let policy: ListeningPolicy = {
  scrobbleSpotify: process.env.SCROBBLE_SPOTIFY === 'true',
};

const active = new Map<string, ActiveSession>();
let clock: () => number = () => Date.now();

function keyOf(zoneId: string | null | undefined): string {
  return zoneId || DEFAULT_ZONE_ID;
}

export function setListeningPolicy(overrides: Partial<ListeningPolicy>): void {
  policy = { ...policy, ...overrides };
}

/** Test hook: control time. */
export function setListeningClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

export function sourceOfTrack(track: ListeningTrack): string {
  if (track.source) return track.source;
  const idx = track.id.indexOf(':');
  return idx > 0 ? track.id.slice(0, idx) : 'local';
}

/** Last.fm's rule, shared by history and scrobbling. */
export function qualifies(durationSeconds: number | null | undefined, listenedMs: number): boolean {
  const listened = listenedMs / 1000;
  if (durationSeconds && durationSeconds > 0) {
    if (durationSeconds <= MIN_TRACK_SECONDS) return false;
    return listened >= Math.min(durationSeconds / 2, QUALIFY_CAP_SECONDS);
  }
  return listened >= QUALIFY_CAP_SECONDS;
}

function scrobbleable(session: ActiveSession): boolean {
  if (session.source === 'radio' || session.source === 'legacy') return false;
  if (session.source === 'spotify' && !policy.scrobbleSpotify) return false;
  return session.track.title.trim() !== '' && session.track.artistName.trim() !== '';
}

function toScrobbleTrack(track: ListeningTrack): ScrobbleTrack {
  return {
    title: track.title,
    artist: track.artistName,
    album: track.albumTitle ?? undefined,
    duration: track.duration ? Math.round(track.duration) : undefined,
  };
}

function accrue(session: ActiveSession, at: number): void {
  if (session.lastTickMs === null) return;
  const delta = at - session.lastTickMs;
  if (delta > 0) session.listenedMs += Math.min(delta, HEARTBEAT_CAP_MS);
  session.lastTickMs = at;
}

function persistProgress(session: ActiveSession, force = false): void {
  if (!force && session.listenedMs - session.persistedListenedMs < PERSIST_EVERY_MS) return;
  try {
    getRawDb()
      .prepare('UPDATE listening_sessions SET listened_ms = ? WHERE id = ?')
      .run(Math.round(session.listenedMs), session.id);
    session.persistedListenedMs = session.listenedMs;
  } catch (err) {
    logger.debug(`Listening: progress persist failed: ${err}`);
  }
}

function finish(session: ActiveSession, status: 'ended' | 'failed', at: number): void {
  accrue(session, at);
  session.lastTickMs = null;
  const qualified = status === 'ended' && qualifies(session.track.duration, session.listenedMs);
  const listenedMs = Math.round(session.listenedMs);
  try {
    getRawDb()
      .prepare(
        'UPDATE listening_sessions SET ended_at = ?, listened_ms = ?, status = ?, qualified = ? WHERE id = ?',
      )
      .run(Math.floor(at / 1000), listenedMs, status, qualified ? 1 : 0, session.id);
  } catch (err) {
    logger.warn(`Listening: could not close session ${session.id}: ${err}`);
  }
  logger.debug(
    `Listening: ${status} "${session.track.title}" after ${Math.round(listenedMs / 1000)}s (${qualified ? 'qualified' : 'not qualified'})`,
  );
  if (qualified && scrobbleable(session)) {
    scrobbler.scrobble(toScrobbleTrack(session.track), {
      sessionId: session.id,
      timestamp: Math.floor(session.startedAtMs / 1000),
      userId: session.userId,
    });
  }
}

/**
 * A track started. Ends the previous session (if any) and opens a new row.
 * Safe to call again for the same queue item: a restart of the same item is
 * a new listen, which is what "repeat one" means too.
 */
export function startSession(track: ListeningTrack, ctx: ListeningContext = {}): string {
  const at = clock();
  const key = keyOf(ctx.zoneId);
  const previous = active.get(key);
  if (previous) finish(previous, 'ended', at);
  const session: ActiveSession = {
    id: randomUUID(),
    track: { ...track, artistName: track.artistName ?? '', title: track.title ?? '' },
    source: sourceOfTrack(track),
    queueItemId: ctx.queueItemId ?? null,
    deviceId: ctx.deviceId ?? null,
    userId: ctx.userId ?? null,
    startedAtMs: at,
    listenedMs: 0,
    lastTickMs: ctx.playing === false ? null : at,
    persistedListenedMs: 0,
  };
  try {
    getRawDb()
      .prepare(
        `INSERT INTO listening_sessions
           (id, queue_item_id, track_id, source, title, artist_name, album_title, album_id, artist_id, duration, started_at, listened_ms, status, qualified, device_id, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', 0, ?, ?)`,
      )
      .run(
        session.id,
        session.queueItemId,
        track.id,
        session.source,
        session.track.title,
        session.track.artistName,
        track.albumTitle ?? null,
        track.albumId ?? null,
        track.artistId ?? null,
        track.duration ? Math.round(track.duration) : null,
        Math.floor(at / 1000),
        session.deviceId,
        session.userId,
      );
  } catch (err) {
    logger.warn(`Listening: could not open session for "${track.title}": ${err}`);
  }
  active.set(key, session);
  if (scrobbleable(session)) {
    scrobbler.nowPlaying(toScrobbleTrack(session.track), session.userId).catch(() => {});
  }
  return session.id;
}

/**
 * Transport changed. `playing` starts the clock, `paused` stops it, `stopped`
 * closes the session. With no open session and a current track, `playing`
 * opens one: that is the restart case, where the speaker kept playing while
 * the server was away.
 */
export function transport(
  state: 'playing' | 'paused' | 'stopped',
  current?: { track: ListeningTrack; ctx?: ListeningContext } | null,
  zoneId?: string | null,
): void {
  const at = clock();
  const key = keyOf(zoneId ?? current?.ctx?.zoneId);
  const session = active.get(key);
  if (!session) {
    if (state === 'playing' && current)
      startSession(current.track, { ...current.ctx, zoneId: key, playing: true });
    return;
  }
  if (state === 'playing') {
    if (session.lastTickMs === null) session.lastTickMs = at;
    else accrue(session, at);
    persistProgress(session);
    return;
  }
  accrue(session, at);
  session.lastTickMs = null;
  if (state === 'stopped') {
    finish(session, 'ended', at);
    active.delete(key);
  } else {
    persistProgress(session, true);
  }
}

/** Confirmation that audio is (still) playing. Credits the time since the last confirmation. */
export function heartbeat(zoneId?: string | null): void {
  const session = active.get(keyOf(zoneId));
  if (!session) return;
  const at = clock();
  if (session.lastTickMs === null) session.lastTickMs = at;
  else accrue(session, at);
  persistProgress(session);
}

/** Playback failed: the session ends unqualified, whatever was heard before. */
export function fail(zoneId?: string | null): void {
  const key = keyOf(zoneId);
  const session = active.get(key);
  if (!session) return;
  finish(session, 'failed', clock());
  active.delete(key);
}

export function getActiveSession(zoneId?: string | null): {
  id: string;
  trackId: string;
  listenedMs: number;
  playing: boolean;
} | null {
  const session = active.get(keyOf(zoneId));
  if (!session) return null;
  const at = clock();
  const pending =
    session.lastTickMs === null ? 0 : Math.min(at - session.lastTickMs, HEARTBEAT_CAP_MS);
  return {
    id: session.id,
    trackId: session.track.id,
    listenedMs: Math.round(session.listenedMs + pending),
    playing: session.lastTickMs !== null,
  };
}

/**
 * Startup: sessions the previous process left open are closed with what they
 * had accrued. A qualifying one still gets its (single) scrobble, the
 * unique (session, service) index makes a retry harmless.
 */
export function closeOrphanedSessions(): number {
  const db = getRawDb();
  const rows = db
    .prepare(
      "SELECT id, title, artist_name, album_title, duration, source, started_at, listened_ms, user_id FROM listening_sessions WHERE status = 'active'",
    )
    .all() as Array<{
    id: string;
    title: string;
    artist_name: string;
    album_title: string | null;
    duration: number | null;
    source: string;
    started_at: number | null;
    listened_ms: number;
    user_id: string | null;
  }>;
  const now = Math.floor(clock() / 1000);
  for (const row of rows) {
    const qualified = qualifies(row.duration, row.listened_ms);
    db.prepare(
      "UPDATE listening_sessions SET status = 'ended', ended_at = ?, qualified = ? WHERE id = ?",
    ).run(now, qualified ? 1 : 0, row.id);
    const fake: ActiveSession = {
      id: row.id,
      track: {
        id: '',
        title: row.title,
        artistName: row.artist_name,
        albumTitle: row.album_title,
        duration: row.duration,
      },
      source: row.source,
      queueItemId: null,
      deviceId: null,
      userId: null,
      startedAtMs: (row.started_at ?? now) * 1000,
      listenedMs: row.listened_ms,
      lastTickMs: null,
      persistedListenedMs: row.listened_ms,
    };
    if (qualified && scrobbleable(fake)) {
      scrobbler.scrobble(toScrobbleTrack(fake.track), {
        sessionId: row.id,
        timestamp: row.started_at ?? now,
        userId: row.user_id,
      });
    }
  }
  if (rows.length > 0)
    logger.info(`Listening: closed ${rows.length} session(s) left open by a previous run`);
  return rows.length;
}

/** Local tracks carry album/artist ids in the library; provider tracks only their names. */
function toListeningTrack(track: TrackInfo): ListeningTrack {
  let albumId: string | null = track.albumId ?? null;
  let artistId: string | null = null;
  if (sourceOfTrack(track) === 'local') {
    try {
      const row = getRawDb()
        .prepare('SELECT album_id, artist_id FROM tracks WHERE id = ?')
        .get(track.id) as { album_id: string | null; artist_id: string | null } | undefined;
      if (row) {
        albumId = albumId ?? row.album_id;
        artistId = row.artist_id;
      }
    } catch {
      // history still gets the snapshot names
    }
  }
  return {
    id: track.id,
    title: track.title,
    artistName: track.artistName,
    albumTitle: track.albumTitle,
    albumId,
    artistId,
    duration: track.duration ?? null,
    source: track.source ?? null,
  };
}

/** The observer PlaybackService calls; wired once at startup. */
export const playbackListeningObserver: ListeningObserver = {
  trackStarted(track, ctx) {
    startSession(toListeningTrack(track), ctx);
  },
  transport(state, current, zoneId) {
    transport(
      state,
      current ? { track: toListeningTrack(current.track), ctx: current.ctx } : null,
      zoneId,
    );
  },
  heartbeat: (zoneId) => heartbeat(zoneId),
  failed: (zoneId) => fail(zoneId),
};

/** Test hook. */
export function resetListeningForTests(): void {
  active.clear();
  clock = () => Date.now();
  policy = { scrobbleSpotify: process.env.SCROBBLE_SPOTIFY === 'true' };
}

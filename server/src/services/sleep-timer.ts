import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Sleep timers (E01).
 *
 * The point of this feature is what happens when nobody is watching: you fall
 * asleep, the tablet locks, and the music has to stop by itself. So the timer
 * lives on the server, per zone, next to the session that actually drives the
 * speaker — not in a browser tab that may be suspended, closed or asleep long
 * before the timer runs out.
 *
 * Four ways to say "stop":
 *
 * - `in`          after a number of minutes, wherever the music is by then;
 * - `endOfTrack`  when the track that is playing now ends;
 * - `endOfAlbum`  when the last track of the current album ends;
 * - `endOfQueue`  when the queue runs out — which is the only one that also
 *                 means something with repeat on, since a repeating queue
 *                 otherwise never runs out.
 *
 * A timer is stored, so a server restart does not lose it. One that ran out
 * while the server was down is not "fired late": the music stopped when the
 * server did, so the timer is simply dropped and said to be dropped.
 *
 * Firing stops the zone; it does not pause, clear the queue or change the
 * volume, so pressing play the next morning continues where it left off.
 * There is no fade-out: the server hands renderers a URL and does not control
 * their volume envelope, so a fade would be a promise this cannot keep.
 */

export type SleepMode = 'in' | 'endOfTrack' | 'endOfAlbum' | 'endOfQueue';

export interface SleepTimer {
  zoneId: string;
  mode: SleepMode;
  /** Unix seconds when a timed sleep fires; null for the boundary modes. */
  stopAt: number | null;
  /** The queue item the boundary modes were set against. */
  itemId: string | null;
  albumId: string | null;
  createdBy: string | null;
  createdAt: number;
}

export interface SleepTimerInfo extends SleepTimer {
  /** Seconds left on a timed sleep; null for the boundary modes. */
  secondsRemaining: number | null;
  /** One sentence describing exactly what will happen, for the UI. */
  description: string;
}

interface Row {
  zone_id: string;
  mode: string;
  stop_at: number | null;
  item_id: string | null;
  album_id: string | null;
  created_by: string | null;
  created_at: number | null;
}

export interface SleepDeps {
  /** Stop the music in this zone. Configured at startup; see configureSleepTimers. */
  stopZone: (zoneId: string, reason: SleepMode) => void;
  /** Tell connected clients the timer changed. */
  announce: (zoneId: string, timer: SleepTimerInfo | null) => void;
  now: () => number;
}

let deps: SleepDeps = {
  stopZone: (zoneId) => {
    logger.warn(`SleepTimer: nothing configured to stop ${zoneId}; the timer only expired`);
  },
  announce: () => {},
  now: () => Date.now(),
};

export function configureSleepTimers(overrides: Partial<SleepDeps>): void {
  deps = { ...deps, ...overrides };
}

/** In-memory timers for the `in` mode, keyed by zone. */
const pending = new Map<string, NodeJS.Timeout>();

function toRow(row: Row): SleepTimer {
  return {
    zoneId: row.zone_id,
    mode: row.mode as SleepMode,
    stopAt: row.stop_at,
    itemId: row.item_id,
    albumId: row.album_id,
    createdBy: row.created_by,
    createdAt: row.created_at ?? 0,
  };
}

function read(zoneId: string): SleepTimer | null {
  try {
    const row = getRawDb().prepare('SELECT * FROM sleep_timers WHERE zone_id = ?').get(zoneId) as
      | Row
      | undefined;
    return row ? toRow(row) : null;
  } catch {
    return null;
  }
}

function readAll(): SleepTimer[] {
  try {
    const rows = getRawDb().prepare('SELECT * FROM sleep_timers').all() as Row[];
    return rows.map(toRow);
  } catch {
    return [];
  }
}

function remove(zoneId: string): void {
  const timer = pending.get(zoneId);
  if (timer) {
    clearTimeout(timer);
    pending.delete(zoneId);
  }
  try {
    getRawDb().prepare('DELETE FROM sleep_timers WHERE zone_id = ?').run(zoneId);
  } catch {
    // A database that is not open has no timer to forget.
  }
}

function describe(timer: SleepTimer, secondsRemaining: number | null): string {
  switch (timer.mode) {
    case 'in': {
      if (secondsRemaining === null) return 'The music stops shortly.';
      const minutes = Math.max(1, Math.round(secondsRemaining / 60));
      return `The music stops in about ${minutes} minute${minutes === 1 ? '' : 's'}, wherever the track is by then.`;
    }
    case 'endOfTrack':
      return 'The music stops when this track ends.';
    case 'endOfAlbum':
      return 'The music stops when the last track of this album ends.';
    case 'endOfQueue':
      return 'The music stops when the queue runs out, repeat included.';
  }
}

function info(timer: SleepTimer): SleepTimerInfo {
  const secondsRemaining =
    timer.stopAt === null ? null : Math.max(0, timer.stopAt - Math.floor(deps.now() / 1000));
  return { ...timer, secondsRemaining, description: describe(timer, secondsRemaining) };
}

/** The timer of one zone, with its remaining time worked out. */
export function getSleepTimer(zoneId: string): SleepTimerInfo | null {
  const timer = read(zoneId);
  return timer ? info(timer) : null;
}

export function listSleepTimers(): SleepTimerInfo[] {
  return readAll().map(info);
}

export class SleepTimerError extends Error {
  constructor(
    readonly code: 'minutes_required' | 'nothing_playing',
    message: string,
  ) {
    super(message);
    this.name = 'SleepTimerError';
  }
}

export interface SetSleepInput {
  mode: SleepMode;
  minutes?: number;
  /** What is playing in this zone right now; the boundary modes are set against it. */
  current?: { itemId: string | null; albumId: string | null } | null;
  userId?: string | null;
}

/** The longest timer we accept. Beyond this it is not a sleep timer any more. */
export const MAX_MINUTES = 12 * 60;

export function setSleepTimer(zoneId: string, input: SetSleepInput): SleepTimerInfo {
  if (input.mode === 'in') {
    if (!input.minutes || input.minutes <= 0) {
      throw new SleepTimerError('minutes_required', 'A timed sleep needs a number of minutes.');
    }
  } else if (!input.current?.itemId) {
    throw new SleepTimerError(
      'nothing_playing',
      'There is nothing playing in this room, so there is no track or album to stop after.',
    );
  }

  const minutes = Math.min(Math.max(input.minutes ?? 0, 1), MAX_MINUTES);
  const nowSeconds = Math.floor(deps.now() / 1000);
  const timer: SleepTimer = {
    zoneId,
    mode: input.mode,
    stopAt: input.mode === 'in' ? nowSeconds + minutes * 60 : null,
    itemId: input.mode === 'in' ? null : (input.current?.itemId ?? null),
    albumId: input.mode === 'in' ? null : (input.current?.albumId ?? null),
    createdBy: input.userId ?? null,
    createdAt: nowSeconds,
  };

  remove(zoneId);
  getRawDb()
    .prepare(
      `INSERT INTO sleep_timers (zone_id, mode, stop_at, item_id, album_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      timer.zoneId,
      timer.mode,
      timer.stopAt,
      timer.itemId,
      timer.albumId,
      timer.createdBy,
      timer.createdAt,
    );

  if (timer.stopAt !== null) schedule(zoneId, timer.stopAt);
  const value = info(timer);
  logger.info(`SleepTimer[${zoneId}]: ${value.description}`);
  deps.announce(zoneId, value);
  return value;
}

export function cancelSleepTimer(zoneId: string): boolean {
  const existing = read(zoneId);
  remove(zoneId);
  if (existing) {
    logger.info(`SleepTimer[${zoneId}]: cancelled`);
    deps.announce(zoneId, null);
  }
  return !!existing;
}

function schedule(zoneId: string, stopAt: number): void {
  const delay = Math.max(0, stopAt * 1000 - deps.now());
  const handle = setTimeout(() => {
    pending.delete(zoneId);
    fire(zoneId, 'in');
  }, delay);
  // A sleep timer must never be the reason this process stays alive.
  handle.unref?.();
  pending.set(zoneId, handle);
}

function fire(zoneId: string, mode: SleepMode): void {
  remove(zoneId);
  logger.info(`SleepTimer[${zoneId}]: stopping the music (${mode})`);
  deps.announce(zoneId, null);
  deps.stopZone(zoneId, mode);
}

/**
 * Should the music stop instead of moving on? Called by the session at the
 * moment a track ends, because that is the only place that knows both what
 * just played and what would play next.
 *
 * `nextAlbumId` is undefined when there is no next track at all.
 */
export function stopsAtThisBoundary(
  zoneId: string,
  context: { currentAlbumId?: string | null; nextAlbumId?: string | null; hasNext: boolean },
): SleepMode | null {
  const timer = read(zoneId);
  if (!timer) return null;
  switch (timer.mode) {
    case 'endOfTrack':
      return 'endOfTrack';
    case 'endOfAlbum': {
      if (!context.hasNext) return 'endOfAlbum';
      const album = timer.albumId ?? context.currentAlbumId ?? null;
      // No album on either side is not evidence they are the same album, so
      // the safer reading of "stop after this album" is to stop.
      if (!album || !context.nextAlbumId) return 'endOfAlbum';
      return context.nextAlbumId === album ? null : 'endOfAlbum';
    }
    case 'endOfQueue':
      return context.hasNext ? null : 'endOfQueue';
    case 'in':
      return null;
  }
}

/** The session stopped because of the timer; forget it and tell the clients. */
export function noteSleepFired(zoneId: string, mode: SleepMode): void {
  remove(zoneId);
  logger.info(`SleepTimer[${zoneId}]: the music stopped (${mode})`);
  deps.announce(zoneId, null);
}

/**
 * Restore the stored timers at startup. One that ran out while the server was
 * down is dropped rather than fired: the music stopped when the server did,
 * and starting the day by stopping silence helps nobody.
 */
export function initializeSleepTimers(): void {
  const nowSeconds = Math.floor(deps.now() / 1000);
  let restored = 0;
  let expired = 0;
  for (const timer of readAll()) {
    if (timer.stopAt === null) {
      restored += 1;
      continue;
    }
    if (timer.stopAt <= nowSeconds) {
      remove(timer.zoneId);
      expired += 1;
      continue;
    }
    schedule(timer.zoneId, timer.stopAt);
    restored += 1;
  }
  if (restored > 0 || expired > 0) {
    logger.info(
      `SleepTimer: ${restored} timer(s) restored, ${expired} dropped because they ran out while the server was down`,
    );
  }
}

/** Test helper: drop every scheduled timeout without touching the database. */
export function resetSleepTimersForTests(): void {
  for (const handle of pending.values()) clearTimeout(handle);
  pending.clear();
  deps = {
    stopZone: () => {},
    announce: () => {},
    now: () => Date.now(),
  };
}

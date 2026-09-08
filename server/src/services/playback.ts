import { randomUUID } from 'crypto';
import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';
import type { NowPlaying, Track } from '@audioserver/shared';
import type {
  PlaybackOrigin,
  PlaybackQueueEntry,
  PlaybackSnapshot,
  PlaybackTrack,
  ServerToClientEvents,
} from '../types/socket-events.js';

/**
 * One playback session for the household (V03).
 *
 * Terminology:
 * - A TRACK is a piece of music (track id). It can occur several times in a
 *   queue (A → B → A → C).
 * - A QUEUE ITEM is one occurrence: it has its own stable `itemId`. The
 *   current position, remove/move commands, restart recovery and every
 *   socket event refer to items, never to "the first item with this track".
 * - The REVISION is a counter bumped on every mutation of queue or
 *   transport. Responses and events carry it so a client can spot a stale
 *   view (its edit is refused with 409 + fresh snapshot) and ignore events
 *   that are older than what it already has.
 * - The ORIGIN of a mutation is the client (browser tab) and login session
 *   that issued it. Events carry it so other tabs mirror the change without
 *   starting audio themselves.
 *
 * This module has no dependency on Socket.IO or on device code: events go
 * through an injected sink (`setEventSink`) and device dispatch through
 * injected hooks (`setHooks`). That keeps it importable in any order.
 */

export interface TrackInfo {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
  /** Extra fields the client needs to play the track (ReplayGain, format…). */
  metadata?: Record<string, unknown>;
}

interface PersistedState {
  deviceId: string;
  trackId: string | null;
  queueItemId: string | null;
  revision: number;
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  volume: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
}

export type QueueEntry = PlaybackQueueEntry;

interface PlaybackStateRow {
  device_id: string | null;
  track_id: string | null;
  queue_item_id: string | null;
  revision: number | null;
  state: string | null;
  position: number | null;
  volume: number | null;
  shuffle: number | boolean | null;
  repeat: string | null;
}

interface QueueItemRow {
  item_id: string | null;
  track_id: string;
  track_title: string;
  artist_name: string;
  album_title: string;
  album_id: string | null;
  duration: number | null;
  source: string | null;
  metadata: string | null;
  position: number;
}

interface TrackRow {
  id: string;
  title: string;
  album_id: string | null;
  album_title: string;
  artist_id: string | null;
  artist_name: string;
  duration: number | null;
  source: string | null;
}

/**
 * Hooks that let a server-side player (services/server-player.ts) react when
 * THIS service advances the queue or goes idle — that's what pushes the next
 * track to a DLNA/Sonos device without any client involvement, so playback
 * continues while the tablet sleeps.
 */
export interface PlaybackHooks {
  onAdvance?: (deviceId: string, track: TrackInfo) => void;
  onIdle?: (deviceId: string) => void;
}

export interface PlaybackEventSink {
  emit: <EventName extends keyof ServerToClientEvents>(
    event: EventName,
    ...args: Parameters<ServerToClientEvents[EventName]>
  ) => unknown;
}

export const SERVER_ORIGIN: PlaybackOrigin = { clientId: null, sessionId: null, server: true };

/** Thrown by position-sensitive commands when the caller's view is outdated. */
export class StaleRevisionError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
    readonly snapshot: PlaybackSnapshot,
  ) {
    super(`Queue changed on another device (you had revision ${expected}, now ${actual})`);
    this.name = 'StaleRevisionError';
  }
}

const COMMAND_MEMORY = 200;

export class PlaybackService {
  private state: PersistedState;
  private queue: QueueEntry[] = [];
  private queueIndex = -1;
  private currentTrack: TrackInfo | null = null;
  private hooks: PlaybackHooks = {};
  private sink: PlaybackEventSink | null = null;
  /** Browser tab that last took control (set queue / played). Not persisted. */
  private controllerClientId: string | null = null;
  /** Recently applied command ids → the snapshot they produced (retry safety). */
  private appliedCommands = new Map<string, PlaybackSnapshot>();

  constructor() {
    this.state = this.defaultState();
  }

  setHooks(hooks: PlaybackHooks): void {
    this.hooks = hooks;
  }

  /** Inject the Socket.IO server (or a test double). Events are dropped until then. */
  setEventSink(sink: PlaybackEventSink | null): void {
    this.sink = sink;
  }

  private defaultState(): PersistedState {
    return {
      deviceId: 'browser',
      trackId: null,
      queueItemId: null,
      revision: 0,
      state: 'stopped',
      position: 0,
      volume: 50,
      shuffle: false,
      repeat: 'off',
    };
  }

  /** Load state and queue from database on startup */
  initialize(): void {
    try {
      const db = getRawDb();
      this.state = this.defaultState();
      this.queue = [];
      this.queueIndex = -1;
      this.currentTrack = null;
      this.controllerClientId = null;
      this.appliedCommands.clear();

      const row = db.prepare('SELECT * FROM playback_state WHERE id = 1').get() as
        | PlaybackStateRow
        | undefined;
      if (row) {
        this.state = {
          deviceId: row.device_id || 'browser',
          trackId: row.track_id,
          queueItemId: row.queue_item_id,
          revision: row.revision ?? 0,
          state: this.normalizePlaybackState(row.state),
          position: row.position ?? 0,
          volume: row.volume ?? 50,
          shuffle: !!row.shuffle,
          repeat: this.normalizeRepeat(row.repeat),
        };
      }

      const queueRows = db
        .prepare('SELECT * FROM queue_items ORDER BY position ASC')
        .all() as QueueItemRow[];
      let backfilled = false;
      this.queue = queueRows.map((r, i) => {
        if (!r.item_id) backfilled = true;
        return {
          itemId: r.item_id ?? randomUUID(),
          trackId: r.track_id,
          trackTitle: r.track_title,
          artistName: r.artist_name,
          albumTitle: r.album_title,
          albumId: r.album_id ?? undefined,
          duration: r.duration ?? undefined,
          source: r.source ?? undefined,
          metadata: parseMetadata(r.metadata),
          position: i,
        };
      });
      // Queues written before V03 have no item ids; give them stable ones now.
      if (backfilled) this.persistQueue();

      this.restoreCurrentTrack();

      logger.info(
        `PlaybackService: loaded state (track=${this.state.trackId ?? 'none'}, item=${this.state.queueItemId ?? 'none'}, rev=${this.state.revision}, state=${this.state.state}, pos=${this.state.position}, vol=${this.state.volume}, queue=${this.queue.length} items, shuffle=${this.state.shuffle}, repeat=${this.state.repeat})`,
      );
    } catch (err) {
      logger.warn(`PlaybackService: failed to load state: ${err}`);
    }
  }

  // ─── Snapshot / state ─────────────────────────────────────────

  getState(): NowPlaying {
    return {
      track: this.currentTrack as Track | null,
      state: this.state.state,
      position: this.state.position,
      duration: this.currentTrack?.duration || 0,
      volume: this.state.volume,
      deviceId: this.state.deviceId,
    };
  }

  getRevision(): number {
    return this.state.revision;
  }

  getActiveDeviceId(): string {
    return this.state.deviceId;
  }

  getCurrentItemId(): string | null {
    return this.state.queueItemId;
  }

  getSnapshot(): PlaybackSnapshot {
    return {
      revision: this.state.revision,
      queue: this.getQueue(),
      currentItemId: this.state.queueItemId,
      queueIndex: this.queueIndex,
      state: this.getState(),
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      controller: { clientId: this.controllerClientId, deviceId: this.state.deviceId },
    };
  }

  /**
   * Transport status pushed by the device monitor. Only the ACTIVE device may
   * write here: a second monitored speaker must not overwrite the session.
   */
  setState(updates: {
    deviceId?: string;
    state?: 'playing' | 'paused' | 'stopped';
    position?: number;
  }): void {
    if (updates.deviceId && updates.deviceId !== this.state.deviceId) {
      logger.debug(
        `PlaybackService: ignoring status from ${updates.deviceId} (active device is ${this.state.deviceId})`,
      );
      return;
    }
    const wasState = this.state.state;
    if (updates.state !== undefined) this.state.state = updates.state;
    if (updates.position !== undefined) this.state.position = updates.position;
    if (
      updates.state === 'stopped' &&
      this.currentTrack?.duration &&
      this.state.position >= this.currentTrack.duration - 2
    ) {
      this.advance(SERVER_ORIGIN);
      return;
    }
    if (wasState !== this.state.state) this.bump();
    this.persistState();
    this.emitState(SERVER_ORIGIN);
  }

  /**
   * A client reports that it started `track` on `deviceId`. When `itemId` is
   * given (or the track matches the current item) the queue position stays
   * exactly where it is; only otherwise do we fall back to the first
   * occurrence of the track. That is the B03 fix: A → B → A → C no longer
   * jumps back to the first A.
   */
  play(
    track: TrackInfo,
    deviceId?: string,
    itemId?: string,
    origin: PlaybackOrigin = SERVER_ORIGIN,
  ): void {
    this.currentTrack = track;
    this.state.trackId = track.id;
    this.state.state = 'playing';
    this.state.position = 0;
    if (deviceId) this.setDevice(deviceId, origin);
    const byItem = itemId ? this.queue.findIndex((item) => item.itemId === itemId) : -1;
    if (byItem >= 0) {
      this.queueIndex = byItem;
    } else if (this.queue[this.queueIndex]?.trackId !== track.id) {
      this.queueIndex = this.queue.findIndex((item) => item.trackId === track.id);
    }
    this.state.queueItemId = this.queue[this.queueIndex]?.itemId ?? null;
    this.bump();
    this.persistState();
    this.emitState(origin);
  }

  /** Make a specific queue item current and (re)start it. */
  playItem(itemId: string, origin: PlaybackOrigin, deviceId?: string): TrackInfo | null {
    const index = this.queue.findIndex((item) => item.itemId === itemId);
    if (index < 0) return null;
    this.queueIndex = index;
    const track = this.queueEntryToTrackInfo(this.queue[index]);
    this.play(track, deviceId, itemId, origin);
    this.emitTrackChanged(track, origin);
    this.hooks.onAdvance?.(this.state.deviceId, track);
    return track;
  }

  pause(origin: PlaybackOrigin = SERVER_ORIGIN): void {
    this.state.state = 'paused';
    this.bump();
    this.persistState();
    this.emitState(origin);
  }

  resume(origin: PlaybackOrigin = SERVER_ORIGIN): void {
    this.state.state = 'playing';
    this.bump();
    this.persistState();
    this.emitState(origin);
  }

  /**
   * Stop contract: the current track stops NOW and the session goes idle;
   * the queue is left untouched so "play" can pick it up again. Compare
   * clearQueue(), which removes the upcoming items but lets the current
   * track finish.
   */
  stop(origin: PlaybackOrigin = SERVER_ORIGIN): void {
    this.state.state = 'stopped';
    this.state.position = 0;
    this.bump();
    this.persistState();
    this.emitState(origin);
    this.hooks.onIdle?.(this.state.deviceId);
  }

  setVolume(volume: number, origin: PlaybackOrigin = SERVER_ORIGIN): void {
    this.state.volume = Math.max(0, Math.min(100, volume));
    this.persistState();
    this.emitState(origin);
  }

  setPosition(position: number): void {
    this.state.position = position;
    this.persistState();
  }

  setShuffle(shuffle: boolean, origin: PlaybackOrigin = SERVER_ORIGIN): void {
    if (this.state.shuffle === shuffle) return;
    this.state.shuffle = shuffle;
    this.bump();
    this.persistState();
    this.emitQueue(origin);
  }

  setRepeat(repeat: 'off' | 'all' | 'one', origin: PlaybackOrigin = SERVER_ORIGIN): void {
    if (this.state.repeat === repeat) return;
    this.state.repeat = repeat;
    this.bump();
    this.persistState();
    this.emitQueue(origin);
  }

  private setDevice(deviceId: string, origin: PlaybackOrigin): void {
    if (this.state.deviceId !== deviceId) {
      this.state.deviceId = deviceId;
    }
    if (origin.clientId) this.controllerClientId = origin.clientId;
  }

  // ─── Queue ────────────────────────────────────────────────────

  getQueue(): QueueEntry[] {
    return this.queue.map((item) => ({ ...item }));
  }

  getQueueIndex(): number {
    return this.queueIndex;
  }

  /**
   * Retry safety: a command that carries an id is applied once. A retry with
   * the same id (network hiccup, double tap) gets the snapshot that the first
   * application produced instead of a second copy of the change.
   */
  withCommand(commandId: string | undefined, apply: () => void): PlaybackSnapshot {
    if (commandId) {
      const seen = this.appliedCommands.get(commandId);
      if (seen) return seen;
    }
    apply();
    const snapshot = this.getSnapshot();
    if (commandId) {
      this.appliedCommands.set(commandId, snapshot);
      if (this.appliedCommands.size > COMMAND_MEMORY) {
        const oldest = this.appliedCommands.keys().next().value;
        if (oldest !== undefined) this.appliedCommands.delete(oldest);
      }
    }
    return snapshot;
  }

  /** Refuse a position-sensitive edit made against an outdated queue. */
  assertRevision(expected: number | undefined): void {
    if (expected === undefined) return;
    if (expected !== this.state.revision) {
      throw new StaleRevisionError(expected, this.state.revision, this.getSnapshot());
    }
  }

  setQueue(
    tracks: TrackInfo[],
    startIndex = 0,
    origin: PlaybackOrigin = SERVER_ORIGIN,
    deviceId?: string,
  ): void {
    this.queue = tracks.map((t, i) => this.toEntry(t, i));
    this.queueIndex =
      this.queue.length === 0 ? -1 : Math.max(0, Math.min(startIndex, this.queue.length - 1));
    this.state.queueItemId = this.queue[this.queueIndex]?.itemId ?? null;
    if (deviceId) this.setDevice(deviceId, origin);
    else if (origin.clientId) this.controllerClientId = origin.clientId;
    this.bump();
    this.persistQueue();
    this.persistState();
    this.emitQueue(origin);
  }

  addToQueue(track: TrackInfo, origin: PlaybackOrigin = SERVER_ORIGIN): QueueEntry {
    const entry = this.toEntry(track, this.queue.length);
    this.queue.push(entry);
    if (this.queueIndex < 0 && this.queue.length === 1) {
      // First item of an empty queue becomes "next up" without playing.
      this.queueIndex = -1;
    }
    this.bump();
    this.persistQueue();
    this.persistState();
    this.emitQueue(origin);
    return { ...entry };
  }

  /** Remove one occurrence. Returns false when the item is unknown (already gone). */
  removeItem(itemId: string, origin: PlaybackOrigin = SERVER_ORIGIN): boolean {
    const index = this.queue.findIndex((item) => item.itemId === itemId);
    if (index < 0) return false;
    this.removeAt(index, origin);
    return true;
  }

  removeFromQueue(index: number, origin: PlaybackOrigin = SERVER_ORIGIN): void {
    if (index < 0 || index >= this.queue.length) return;
    this.removeAt(index, origin);
  }

  private removeAt(index: number, origin: PlaybackOrigin): void {
    this.queue.splice(index, 1);
    this.reindex();
    if (index < this.queueIndex) {
      this.queueIndex--;
    } else if (index === this.queueIndex) {
      // The removed item keeps playing until it ends; point just before its
      // former successor so the next advance lands on that successor.
      this.queueIndex--;
      this.state.queueItemId = null;
    }
    if (this.queueIndex >= this.queue.length) this.queueIndex = this.queue.length - 1;
    if (this.state.queueItemId && !this.queue.some((i) => i.itemId === this.state.queueItemId)) {
      this.state.queueItemId = null;
    }
    this.bump();
    this.persistQueue();
    this.persistState();
    this.emitQueue(origin);
  }

  /**
   * Clear contract: drop every queued item. The current track keeps playing
   * to its end (or until stop()); after that the session goes idle because
   * there is nothing left to advance to.
   */
  clearQueue(origin: PlaybackOrigin = SERVER_ORIGIN): void {
    this.queue = [];
    this.queueIndex = -1;
    this.state.queueItemId = null;
    this.bump();
    this.persistQueue();
    this.persistState();
    this.emitQueue(origin);
  }

  moveItem(itemId: string, toIndex: number, origin: PlaybackOrigin = SERVER_ORIGIN): boolean {
    const fromIndex = this.queue.findIndex((item) => item.itemId === itemId);
    if (fromIndex < 0) return false;
    this.moveInQueue(fromIndex, toIndex, origin);
    return true;
  }

  moveInQueue(fromIndex: number, toIndex: number, origin: PlaybackOrigin = SERVER_ORIGIN): void {
    if (fromIndex < 0 || fromIndex >= this.queue.length) return;
    if (toIndex < 0 || toIndex >= this.queue.length) return;
    if (fromIndex === toIndex) return;
    const [item] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, item);
    this.reindex();
    if (this.queueIndex === fromIndex) {
      this.queueIndex = toIndex;
    } else if (fromIndex < this.queueIndex && toIndex >= this.queueIndex) {
      this.queueIndex--;
    } else if (fromIndex > this.queueIndex && toIndex <= this.queueIndex) {
      this.queueIndex++;
    }
    this.bump();
    this.persistQueue();
    this.persistState();
    this.emitQueue(origin);
  }

  // ─── Advance / previous ───────────────────────────────────────

  /** Called when the current track ends (or on "next"). Returns the next track or null. */
  advance(origin: PlaybackOrigin = SERVER_ORIGIN): TrackInfo | null {
    if (this.queue.length === 0) {
      if (this.state.repeat === 'one' && this.currentTrack) {
        this.play(this.currentTrack, undefined, undefined, origin);
        this.emitTrackChanged(this.currentTrack, origin);
        this.hooks.onAdvance?.(this.state.deviceId, this.currentTrack);
        return this.currentTrack;
      }
      this.finishQueue(origin);
      return null;
    }

    if (this.state.repeat === 'one') {
      const current = this.queue[this.queueIndex];
      const track =
        current && current.itemId === this.state.queueItemId
          ? this.queueEntryToTrackInfo(current)
          : this.currentTrack;
      if (track) {
        this.play(track, undefined, current?.itemId, origin);
        this.emitTrackChanged(track, origin);
        this.hooks.onAdvance?.(this.state.deviceId, track);
        return track;
      }
      return null;
    }

    let nextIndex: number;
    if (this.state.shuffle) {
      nextIndex = Math.floor(Math.random() * this.queue.length);
      if (nextIndex === this.queueIndex && this.queue.length > 1) {
        nextIndex = (nextIndex + 1) % this.queue.length;
      }
    } else {
      nextIndex = this.queueIndex + 1;
    }

    if (nextIndex >= this.queue.length) {
      if (this.state.repeat === 'all') {
        nextIndex = 0;
      } else {
        this.finishQueue(origin);
        return null; // End of queue
      }
    }

    return this.startIndex(nextIndex, origin);
  }

  /** "Previous": the item before the current one (no wrap). Null when at the start. */
  previous(origin: PlaybackOrigin = SERVER_ORIGIN): TrackInfo | null {
    const prevIndex = this.queueIndex - 1;
    if (prevIndex < 0 || prevIndex >= this.queue.length) return null;
    return this.startIndex(prevIndex, origin);
  }

  private startIndex(index: number, origin: PlaybackOrigin): TrackInfo | null {
    const entry = this.queue[index];
    if (!entry) return null;
    this.queueIndex = index;
    const track = this.queueEntryToTrackInfo(entry);
    this.play(track, undefined, entry.itemId, origin);
    this.emitTrackChanged(track, origin);
    this.hooks.onAdvance?.(this.state.deviceId, track);
    return track;
  }

  private finishQueue(origin: PlaybackOrigin): void {
    this.state.state = 'stopped';
    this.state.position = this.currentTrack?.duration ?? this.state.position;
    this.bump();
    this.persistState();
    this.emitState(origin);
    this.hooks.onIdle?.(this.state.deviceId);
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private bump(): void {
    this.state.revision += 1;
  }

  private reindex(): void {
    this.queue.forEach((item, i) => {
      item.position = i;
    });
  }

  private toEntry(t: TrackInfo, position: number): QueueEntry {
    // Display fields fall back to '' — queue_items columns are NOT NULL and
    // the /queue/set route only requires a track id.
    return {
      itemId: randomUUID(),
      trackId: t.id,
      trackTitle: t.title ?? 'Unknown',
      artistName: t.artistName ?? '',
      albumTitle: t.albumTitle ?? '',
      albumId: t.albumId,
      duration: t.duration,
      source: t.source,
      metadata: t.metadata,
      position,
    };
  }

  private queueEntryToTrackInfo(entry: QueueEntry): TrackInfo {
    return {
      id: entry.trackId,
      title: entry.trackTitle,
      artistName: entry.artistName,
      albumTitle: entry.albumTitle,
      albumId: entry.albumId,
      duration: entry.duration,
      source: entry.source,
      metadata: entry.metadata,
    };
  }

  private restoreCurrentTrack(): void {
    if (!this.state.trackId) return;

    // Prefer the persisted occurrence; fall back to the first match for
    // databases written before item ids existed.
    let queueIndex = this.state.queueItemId
      ? this.queue.findIndex((item) => item.itemId === this.state.queueItemId)
      : -1;
    if (queueIndex < 0) {
      queueIndex = this.queue.findIndex((item) => item.trackId === this.state.trackId);
    }
    if (queueIndex >= 0) {
      this.queueIndex = queueIndex;
      this.state.queueItemId = this.queue[queueIndex].itemId;
      this.currentTrack = this.queueEntryToTrackInfo(this.queue[queueIndex]);
      return;
    }

    this.currentTrack = this.loadTrackById(this.state.trackId);
  }

  private loadTrackById(trackId: string): TrackInfo | null {
    try {
      const row = getRawDb()
        .prepare(
          `SELECT id, title, album_id, album_title, artist_id, artist_name, duration, source
           FROM tracks
           WHERE id = ?`,
        )
        .get(trackId) as TrackRow | undefined;
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        albumId: row.album_id || undefined,
        albumTitle: row.album_title,
        artistName: row.artist_name,
        duration: row.duration ?? undefined,
        source: row.source || undefined,
      };
    } catch {
      return null;
    }
  }

  private normalizePlaybackState(value: string | null): PersistedState['state'] {
    if (value === 'playing' || value === 'paused' || value === 'stopped') return value;
    return 'stopped';
  }

  private normalizeRepeat(value: string | null): PersistedState['repeat'] {
    if (value === 'all' || value === 'one' || value === 'off') return value;
    return 'off';
  }

  // ─── Persistence ──────────────────────────────────────────────

  private persistState(): void {
    try {
      const db = getRawDb();
      db.prepare(
        `
        INSERT OR REPLACE INTO playback_state (id, device_id, track_id, queue_item_id, revision, state, position, volume, shuffle, repeat, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      ).run(
        this.state.deviceId,
        this.state.trackId,
        this.state.queueItemId,
        this.state.revision,
        this.state.state,
        this.state.position,
        this.state.volume,
        this.state.shuffle ? 1 : 0,
        this.state.repeat,
      );
    } catch (err) {
      logger.warn(`PlaybackService: persist state failed: ${err}`);
    }
  }

  private persistQueue(): void {
    try {
      const db = getRawDb();
      const insert = db.prepare(`
        INSERT INTO queue_items (item_id, track_id, track_title, artist_name, album_title, album_id, duration, source, metadata, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAll = db.transaction(() => {
        db.prepare('DELETE FROM queue_items').run();
        for (const item of this.queue) {
          insert.run(
            item.itemId,
            item.trackId,
            item.trackTitle,
            item.artistName,
            item.albumTitle,
            item.albumId || null,
            item.duration ?? null,
            item.source || 'local',
            item.metadata ? JSON.stringify(item.metadata) : null,
            item.position,
          );
        }
      });
      insertAll();
    } catch (err) {
      logger.warn(`PlaybackService: persist queue failed: ${err}`);
    }
  }

  // ─── Events ───────────────────────────────────────────────────

  private emitState(origin: PlaybackOrigin): void {
    try {
      this.sink?.emit('playback:state', {
        ...this.getState(),
        revision: this.state.revision,
        currentItemId: this.state.queueItemId,
        origin,
      });
    } catch (err) {
      logger.debug(`PlaybackService: emit state failed: ${err}`);
    }
  }

  private emitQueue(origin: PlaybackOrigin): void {
    try {
      this.sink?.emit('playback:queue', {
        revision: this.state.revision,
        queue: this.getQueue(),
        currentItemId: this.state.queueItemId,
        queueIndex: this.queueIndex,
        shuffle: this.state.shuffle,
        repeat: this.state.repeat,
        origin,
      });
    } catch (err) {
      logger.debug(`PlaybackService: emit queue failed: ${err}`);
    }
  }

  private emitTrackChanged(track: TrackInfo, origin: PlaybackOrigin): void {
    const payload: PlaybackTrack = { ...track };
    try {
      this.sink?.emit('playback:track-changed', {
        track: payload,
        itemId: this.state.queueItemId,
        revision: this.state.revision,
        deviceId: this.state.deviceId,
        controllerClientId: this.controllerClientId,
        origin,
      });
    } catch (err) {
      logger.debug(`PlaybackService: emit track-changed failed: ${err}`);
    }
  }
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const playbackService = new PlaybackService();

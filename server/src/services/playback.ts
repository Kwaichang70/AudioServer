import { getRawDb } from '../db/index.js';
import { getIO } from '../socketio.js';
import { logger } from '../logger.js';
import type { NowPlaying, Track } from '@audioserver/shared';

interface TrackInfo {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
}

interface PersistedState {
  deviceId: string;
  trackId: string | null;
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  volume: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
}

interface QueueEntry {
  trackId: string;
  trackTitle: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
  source?: string;
  position: number;
}

interface PlaybackStateRow {
  device_id: string | null;
  track_id: string | null;
  state: string | null;
  position: number | null;
  volume: number | null;
  shuffle: number | boolean | null;
  repeat: string | null;
}

interface QueueItemRow {
  track_id: string;
  track_title: string;
  artist_name: string;
  album_title: string;
  album_id: string | null;
  duration: number | null;
  source: string | null;
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

export class PlaybackService {
  private state: PersistedState;
  private queue: QueueEntry[] = [];
  private queueIndex = -1;
  private currentTrack: TrackInfo | null = null;

  constructor() {
    this.state = this.defaultState();
  }

  private defaultState(): PersistedState {
    return {
      deviceId: 'browser',
      trackId: null,
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

      // Load playback state
      const row = db.prepare('SELECT * FROM playback_state WHERE id = 1').get() as
        | PlaybackStateRow
        | undefined;
      if (row) {
        this.state = {
          deviceId: row.device_id || 'browser',
          trackId: row.track_id,
          state: this.normalizePlaybackState(row.state),
          position: row.position ?? 0,
          volume: row.volume ?? 50,
          shuffle: !!row.shuffle,
          repeat: this.normalizeRepeat(row.repeat),
        };
      }

      // Load queue
      const queueRows = db
        .prepare('SELECT * FROM queue_items ORDER BY position ASC')
        .all() as QueueItemRow[];
      this.queue = queueRows.map((r) => ({
        trackId: r.track_id,
        trackTitle: r.track_title,
        artistName: r.artist_name,
        albumTitle: r.album_title,
        albumId: r.album_id ?? undefined,
        duration: r.duration ?? undefined,
        source: r.source ?? undefined,
        position: r.position,
      }));

      this.restoreCurrentTrack();

      logger.info(
        `PlaybackService: loaded state (track=${this.state.trackId ?? 'none'}, state=${this.state.state}, pos=${this.state.position}, vol=${this.state.volume}, queue=${this.queue.length} items, shuffle=${this.state.shuffle}, repeat=${this.state.repeat})`,
      );
    } catch (err) {
      logger.warn(`PlaybackService: failed to load state: ${err}`);
    }
  }

  // ─── State ────────────────────────────────────────────────────

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

  setState(updates: Partial<PersistedState>): void {
    Object.assign(this.state, updates);
    if (
      updates.state === 'stopped' &&
      this.currentTrack?.duration &&
      this.state.position >= this.currentTrack.duration - 2
    ) {
      this.advance();
      return;
    }
    this.persistState();
    this.emitState();
  }

  play(track: TrackInfo, deviceId?: string): void {
    this.currentTrack = track;
    this.state.trackId = track.id;
    this.state.state = 'playing';
    this.state.position = 0;
    if (deviceId) this.state.deviceId = deviceId;
    this.queueIndex = this.queue.findIndex((item) => item.trackId === track.id);
    this.persistState();
    this.emitState();
  }

  pause(): void {
    this.state.state = 'paused';
    this.persistState();
    this.emitState();
  }

  resume(): void {
    this.state.state = 'playing';
    this.persistState();
    this.emitState();
  }

  stop(): void {
    this.state.state = 'stopped';
    this.state.position = 0;
    this.persistState();
    this.emitState();
  }

  setVolume(volume: number): void {
    this.state.volume = Math.max(0, Math.min(100, volume));
    this.persistState();
    this.emitState();
  }

  setPosition(position: number): void {
    this.state.position = position;
    this.persistState();
  }

  setShuffle(shuffle: boolean): void {
    this.state.shuffle = shuffle;
    this.persistState();
    this.emitState();
  }

  setRepeat(repeat: 'off' | 'all' | 'one'): void {
    this.state.repeat = repeat;
    this.persistState();
    this.emitState();
  }

  // ─── Queue ────────────────────────────────────────────────────

  getQueue(): QueueEntry[] {
    return [...this.queue];
  }

  getQueueIndex(): number {
    return this.queueIndex;
  }

  setQueue(tracks: TrackInfo[]): void {
    this.queue = tracks.map((t, i) => ({
      trackId: t.id,
      trackTitle: t.title,
      artistName: t.artistName,
      albumTitle: t.albumTitle,
      albumId: t.albumId,
      duration: t.duration,
      source: t.source,
      position: i,
    }));
    this.queueIndex = 0;
    this.persistQueue();
    this.emitQueue();
  }

  addToQueue(track: TrackInfo): void {
    const position = this.queue.length;
    this.queue.push({
      trackId: track.id,
      trackTitle: track.title,
      artistName: track.artistName,
      albumTitle: track.albumTitle,
      albumId: track.albumId,
      duration: track.duration,
      source: track.source,
      position,
    });
    this.persistQueue();
    this.emitQueue();
  }

  removeFromQueue(index: number): void {
    if (index < 0 || index >= this.queue.length) return;
    this.queue.splice(index, 1);
    // Reindex positions
    this.queue.forEach((item, i) => {
      item.position = i;
    });
    if (index < this.queueIndex) {
      this.queueIndex--;
    } else if (this.queueIndex >= this.queue.length) {
      this.queueIndex = Math.max(0, this.queue.length - 1);
    }
    this.persistQueue();
    this.emitQueue();
  }

  clearQueue(): void {
    this.queue = [];
    this.queueIndex = -1;
    this.persistQueue();
    this.emitQueue();
  }

  moveInQueue(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.queue.length) return;
    if (toIndex < 0 || toIndex >= this.queue.length) return;
    const [item] = this.queue.splice(fromIndex, 1);
    this.queue.splice(toIndex, 0, item);
    this.queue.forEach((item, i) => {
      item.position = i;
    });
    if (this.queueIndex === fromIndex) {
      this.queueIndex = toIndex;
    } else if (fromIndex < this.queueIndex && toIndex >= this.queueIndex) {
      this.queueIndex--;
    } else if (fromIndex > this.queueIndex && toIndex <= this.queueIndex) {
      this.queueIndex++;
    }
    this.persistQueue();
    this.emitQueue();
  }

  // ─── Auto-advance ─────────────────────────────────────────────

  /** Called when current track ends. Returns the next track or null. */
  advance(): TrackInfo | null {
    if (this.queue.length === 0) {
      if (this.state.repeat === 'one' && this.currentTrack) {
        this.play(this.currentTrack);
        this.emitTrackChanged(this.currentTrack);
        return this.currentTrack;
      }
      this.finishQueue();
      return null;
    }

    if (this.state.repeat === 'one') {
      const current = this.queue[this.queueIndex];
      const track = current ? this.queueEntryToTrackInfo(current) : this.currentTrack;
      if (track) {
        this.play(track);
        this.emitTrackChanged(track);
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
        this.finishQueue();
        return null; // End of queue
      }
    }

    this.queueIndex = nextIndex;
    const entry = this.queue[nextIndex];
    if (!entry) return null;

    const track = this.queueEntryToTrackInfo(entry);
    this.play(track);
    this.emitTrackChanged(track);
    return track;
  }

  private finishQueue(): void {
    this.state.state = 'stopped';
    this.state.position = this.currentTrack?.duration ?? this.state.position;
    this.persistState();
    this.emitState();
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
    };
  }

  private restoreCurrentTrack(): void {
    if (!this.state.trackId) return;

    const queueIndex = this.queue.findIndex((item) => item.trackId === this.state.trackId);
    if (queueIndex >= 0) {
      this.queueIndex = queueIndex;
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
        INSERT OR REPLACE INTO playback_state (id, device_id, track_id, state, position, volume, shuffle, repeat, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      ).run(
        this.state.deviceId,
        this.state.trackId,
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
      db.prepare('DELETE FROM queue_items').run();
      const insert = db.prepare(`
        INSERT INTO queue_items (track_id, track_title, artist_name, album_title, album_id, duration, source, position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAll = db.transaction(() => {
        for (const item of this.queue) {
          insert.run(
            item.trackId,
            item.trackTitle,
            item.artistName,
            item.albumTitle,
            item.albumId || null,
            item.duration ?? null,
            item.source || 'local',
            item.position,
          );
        }
      });
      insertAll();
    } catch (err) {
      logger.warn(`PlaybackService: persist queue failed: ${err}`);
    }
  }

  // ─── Socket.IO Events ─────────────────────────────────────────

  private emitState(): void {
    try {
      getIO().emit('playback:state', this.getState());
    } catch {}
  }

  private emitQueue(): void {
    try {
      getIO().emit('playback:queue', this.queue);
    } catch {}
  }

  private emitTrackChanged(track: TrackInfo): void {
    try {
      getIO().emit('playback:track-changed', track);
    } catch {}
  }
}

export const playbackService = new PlaybackService();

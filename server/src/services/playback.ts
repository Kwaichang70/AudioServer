import { getRawDb } from '../db/index.js';
import { getIO } from '../socketio.js';
import { logger } from '../logger.js';
import type { NowPlaying, QueueItem, PlaybackState } from '@audioserver/shared';

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

class PlaybackService {
  private state: PersistedState;
  private queue: QueueEntry[] = [];
  private queueIndex = -1;
  private currentTrack: TrackInfo | null = null;

  constructor() {
    this.state = {
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

      // Load playback state
      const row = db.prepare('SELECT * FROM playback_state WHERE id = 1').get() as any;
      if (row) {
        this.state = {
          deviceId: row.device_id || 'browser',
          trackId: row.track_id,
          state: 'stopped', // Always start stopped (can't resume mid-track)
          position: 0,
          volume: row.volume ?? 50,
          shuffle: !!row.shuffle,
          repeat: row.repeat || 'off',
        };
      }

      // Load queue
      const queueRows = db.prepare('SELECT * FROM queue_items ORDER BY position ASC').all() as any[];
      this.queue = queueRows.map((r) => ({
        trackId: r.track_id,
        trackTitle: r.track_title,
        artistName: r.artist_name,
        albumTitle: r.album_title,
        albumId: r.album_id,
        duration: r.duration,
        source: r.source,
        position: r.position,
      }));

      logger.info(`PlaybackService: loaded state (vol=${this.state.volume}, queue=${this.queue.length} items, shuffle=${this.state.shuffle}, repeat=${this.state.repeat})`);
    } catch (err) {
      logger.warn(`PlaybackService: failed to load state: ${err}`);
    }
  }

  // ─── State ────────────────────────────────────────────────────

  getState(): NowPlaying {
    return {
      track: this.currentTrack as any,
      state: this.state.state as any,
      position: this.state.position,
      duration: this.currentTrack?.duration || 0,
      volume: this.state.volume,
      deviceId: this.state.deviceId,
    };
  }

  setState(updates: Partial<PersistedState>): void {
    Object.assign(this.state, updates);
    this.persistState();
    this.emitState();
  }

  play(track: TrackInfo, deviceId?: string): void {
    this.currentTrack = track;
    this.state.trackId = track.id;
    this.state.state = 'playing';
    this.state.position = 0;
    if (deviceId) this.state.deviceId = deviceId;
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
      source: (t as any).source,
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
      source: (track as any).source,
      position,
    });
    this.persistQueue();
    this.emitQueue();
  }

  removeFromQueue(index: number): void {
    if (index < 0 || index >= this.queue.length) return;
    this.queue.splice(index, 1);
    // Reindex positions
    this.queue.forEach((item, i) => { item.position = i; });
    if (this.queueIndex >= this.queue.length) {
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
    this.queue.forEach((item, i) => { item.position = i; });
    this.persistQueue();
    this.emitQueue();
  }

  // ─── Auto-advance ─────────────────────────────────────────────

  /** Called when current track ends. Returns the next track or null. */
  advance(): TrackInfo | null {
    if (this.queue.length === 0) return null;

    if (this.state.repeat === 'one') {
      const current = this.queue[this.queueIndex];
      if (current) return this.queueEntryToTrackInfo(current);
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

  // ─── Persistence ──────────────────────────────────────────────

  private persistState(): void {
    try {
      const db = getRawDb();
      db.prepare(`
        INSERT OR REPLACE INTO playback_state (id, device_id, track_id, state, position, volume, shuffle, repeat, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).run(
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
          insert.run(item.trackId, item.trackTitle, item.artistName, item.albumTitle, item.albumId || null, item.duration || null, item.source || 'local', item.position);
        }
      });
      insertAll();
    } catch (err) {
      logger.warn(`PlaybackService: persist queue failed: ${err}`);
    }
  }

  // ─── Socket.IO Events ─────────────────────────────────────────

  private emitState(): void {
    try { getIO().emit('playback:state', this.getState()); } catch {}
  }

  private emitQueue(): void {
    try { getIO().emit('playback:queue', this.queue); } catch {}
  }

  private emitTrackChanged(track: TrackInfo): void {
    try { getIO().emit('playback:track-changed', track); } catch {}
  }
}

export const playbackService = new PlaybackService();

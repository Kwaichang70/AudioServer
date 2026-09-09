import { DEFAULT_ZONE_ID, getRawDb, slugForZone } from '../db/index.js';
import { logger } from '../logger.js';
import {
  PlaybackService,
  playbackService,
  type ListeningObserver,
  type PlaybackEventSink,
  type PlaybackHooks,
} from './playback.js';

/**
 * Zones (V10): one room, one queue.
 *
 * Until V09 the household had a single playback session. A zone is a room —
 * the kitchen speaker, the living room, the browser — with its own queue,
 * transport and volume. A zone owns exactly one output device and a device
 * belongs to at most one zone, so a speaker can never be claimed by two
 * rooms at once (`zones.device_id` is UNIQUE) and pause in one room cannot
 * touch another.
 *
 * The registry holds one `PlaybackService` per zone. The hooks, event sink
 * and listening observer are set once here and handed to every zone,
 * including zones created later.
 */

export interface Zone {
  id: string;
  name: string;
  deviceId: string;
  isDefault: boolean;
}

interface ZoneRow {
  id: string;
  name: string;
  device_id: string;
  is_default: number | boolean | null;
}

export class ZoneTakenError extends Error {
  constructor(
    readonly deviceId: string,
    readonly zone: Zone,
  ) {
    super(`${deviceId} already plays in "${zone.name}"`);
    this.name = 'ZoneTakenError';
  }
}

class ZoneRegistry {
  private sessions = new Map<string, PlaybackService>();
  private hooks: PlaybackHooks = {};
  private sink: PlaybackEventSink | null = null;
  private observer: ListeningObserver | null = null;

  /** Load every zone and its session from disk. Call once at startup. */
  initialize(): void {
    this.sessions.clear();
    for (const zone of this.list()) {
      this.sessionFor(zone.id).initialize();
    }
    logger.info(
      `Zones: ${this.sessions.size} zone(s) ready (${this.list()
        .map((z) => `${z.name}→${z.deviceId}`)
        .join(', ')})`,
    );
  }

  list(): Zone[] {
    try {
      const rows = getRawDb()
        .prepare('SELECT id, name, device_id, is_default FROM zones ORDER BY is_default DESC, name')
        .all() as ZoneRow[];
      return rows.map(toZone);
    } catch (err) {
      logger.warn(`Zones: list failed: ${err}`);
      return [];
    }
  }

  get(zoneId: string): Zone | null {
    try {
      const row = getRawDb()
        .prepare('SELECT id, name, device_id, is_default FROM zones WHERE id = ?')
        .get(zoneId) as ZoneRow | undefined;
      return row ? toZone(row) : null;
    } catch {
      return null;
    }
  }

  forDevice(deviceId: string): Zone | null {
    try {
      const row = getRawDb()
        .prepare('SELECT id, name, device_id, is_default FROM zones WHERE device_id = ?')
        .get(deviceId) as ZoneRow | undefined;
      return row ? toZone(row) : null;
    } catch {
      return null;
    }
  }

  /**
   * The zone a request means. An explicit id wins; otherwise the zone bound
   * to the named device, and finally the default zone. An unknown zone id
   * gives null so a caller can answer 404 instead of silently steering the
   * wrong room.
   */
  resolve(hint: { zoneId?: string | null; deviceId?: string | null }): Zone | null {
    if (hint.zoneId) return this.get(hint.zoneId);
    if (hint.deviceId) {
      const byDevice = this.forDevice(hint.deviceId);
      if (byDevice) return byDevice;
    }
    return this.get(DEFAULT_ZONE_ID) ?? this.list()[0] ?? FALLBACK_ZONE;
  }

  /** The live session of a zone, created and loaded from disk on first use. */
  sessionFor(zoneId: string): PlaybackService {
    const existing = this.sessions.get(zoneId);
    if (existing) return existing;
    // The default zone keeps the module-level instance every other module
    // already imports, so there is exactly one session object per zone. Its
    // state is loaded by whoever owns startup (initialize() below); a zone
    // that appears at runtime loads its own.
    const isDefault = zoneId === DEFAULT_ZONE_ID;
    const service = isDefault ? playbackService : new PlaybackService(zoneId);
    // Only hand over what the registry actually has. The default zone's
    // session may already be wired by whoever owns startup, and adopting it
    // here must never silence it.
    if (Object.keys(this.hooks).length > 0) service.setHooks(this.hooks);
    if (this.sink) service.setEventSink(this.sink);
    if (this.observer) service.setListeningObserver(this.observer);
    if (!isDefault) service.initialize();
    this.sessions.set(zoneId, service);
    return service;
  }

  /** The session playing on a device, or null when no zone owns it. */
  sessionForDevice(deviceId: string): PlaybackService | null {
    const zone = this.forDevice(deviceId);
    return zone ? this.sessionFor(zone.id) : null;
  }

  /** Every loaded session; used to broadcast snapshots and to shut down. */
  loadedSessions(): PlaybackService[] {
    return [...this.sessions.values()];
  }

  create(input: { name: string; deviceId: string }): Zone {
    const taken = this.forDevice(input.deviceId);
    if (taken) throw new ZoneTakenError(input.deviceId, taken);
    const id = `zone-${slugForZone(input.deviceId)}`;
    getRawDb()
      .prepare('INSERT INTO zones (id, name, device_id, is_default) VALUES (?, ?, ?, 0)')
      .run(id, input.name.trim() || input.deviceId, input.deviceId);
    const zone = this.get(id);
    if (!zone) throw new Error(`Zone ${id} vanished right after creation`);
    logger.info(`Zones: created "${zone.name}" on ${zone.deviceId}`);
    this.sessionFor(zone.id);
    return zone;
  }

  rename(zoneId: string, name: string): Zone | null {
    const zone = this.get(zoneId);
    if (!zone) return null;
    getRawDb()
      .prepare('UPDATE zones SET name = ? WHERE id = ?')
      .run(name.trim() || zone.name, zoneId);
    return this.get(zoneId);
  }

  /**
   * Remove a zone and everything it was playing. The default zone stays: it
   * is where a client without a zone lands.
   */
  remove(zoneId: string): boolean {
    const zone = this.get(zoneId);
    if (!zone || zone.isDefault) return false;
    const db = getRawDb();
    db.transaction(() => {
      db.prepare('DELETE FROM queue_items WHERE zone_id = ?').run(zoneId);
      db.prepare('DELETE FROM playback_state WHERE zone_id = ?').run(zoneId);
      db.prepare('DELETE FROM zones WHERE id = ?').run(zoneId);
    })();
    this.sessions.delete(zoneId);
    logger.info(`Zones: removed "${zone.name}"`);
    return true;
  }

  setHooks(hooks: PlaybackHooks): void {
    this.hooks = hooks;
    for (const session of this.sessions.values()) session.setHooks(hooks);
  }

  setEventSink(sink: PlaybackEventSink | null): void {
    this.sink = sink;
    for (const session of this.sessions.values()) session.setEventSink(sink);
  }

  setListeningObserver(observer: ListeningObserver | null): void {
    this.observer = observer;
    for (const session of this.sessions.values()) session.setListeningObserver(observer);
  }

  /** Test helper: forget the loaded sessions without touching the database. */
  resetForTests(): void {
    this.sessions.clear();
  }
}

/**
 * The zone every request can always fall back to. Without it a database that
 * is not open yet (or a zones table that cannot be read) would answer 404 for
 * playback, which is a worse failure than simply playing in the browser.
 */
const FALLBACK_ZONE: Zone = {
  id: DEFAULT_ZONE_ID,
  name: 'Browser',
  deviceId: 'browser',
  isDefault: true,
};

function toZone(row: ZoneRow): Zone {
  return {
    id: row.id,
    name: row.name,
    deviceId: row.device_id,
    isDefault: !!row.is_default,
  };
}

export const zones = new ZoneRegistry();

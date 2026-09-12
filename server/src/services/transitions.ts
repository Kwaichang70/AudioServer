import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Track transitions (V11.4).
 *
 * Two kinds of number live here and they are never mixed. What the SERVER
 * OBSERVES comes from polling a renderer every two seconds: it can say "the
 * next track started", never "the boundary was 40 ms". What is MEASURED comes
 * from a recording of the actual output and is the only thing that can support
 * the words "gapless verified". The log keeps both, labelled, so a claim can
 * always be traced back to how it was established.
 */

export type Handover = 'next-uri' | 'dispatch' | 'client';

export interface TransitionRecord {
  id: number;
  zoneId: string | null;
  deviceId: string;
  fromTrackId: string | null;
  toTrackId: string | null;
  handover: Handover;
  armedAt: number | null;
  /** Poll resolution (±2 s). Useful to spot a long pause, useless for gapless. */
  observedGapMs: number | null;
  /** A real measurement, in milliseconds. */
  measuredGapMs: number | null;
  method: string | null;
  note: string | null;
  createdAt: number | null;
}

interface Row {
  id: number;
  zone_id: string | null;
  device_id: string;
  from_track_id: string | null;
  to_track_id: string | null;
  handover: string;
  armed_at: number | null;
  observed_gap_ms: number | null;
  measured_gap_ms: number | null;
  method: string | null;
  note: string | null;
  created_at: number | null;
}

const toRecord = (row: Row): TransitionRecord => ({
  id: row.id,
  zoneId: row.zone_id,
  deviceId: row.device_id,
  fromTrackId: row.from_track_id,
  toTrackId: row.to_track_id,
  handover: row.handover as Handover,
  armedAt: row.armed_at,
  observedGapMs: row.observed_gap_ms,
  measuredGapMs: row.measured_gap_ms,
  method: row.method,
  note: row.note,
  createdAt: row.created_at,
});

/** How many transitions to keep per device; a long night should not grow forever. */
const KEEP_PER_DEVICE = 200;

export function recordTransition(input: {
  zoneId: string | null;
  deviceId: string;
  fromTrackId: string | null;
  toTrackId: string | null;
  handover: Handover;
  armedAt?: number | null;
  observedGapMs?: number | null;
}): number | null {
  try {
    const db = getRawDb();
    const result = db
      .prepare(
        `INSERT INTO transition_log
           (zone_id, device_id, from_track_id, to_track_id, handover, armed_at, observed_gap_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.zoneId,
        input.deviceId,
        input.fromTrackId,
        input.toTrackId,
        input.handover,
        input.armedAt ?? null,
        input.observedGapMs ?? null,
      );
    db.prepare(
      `DELETE FROM transition_log
        WHERE device_id = ?
          AND id <= (SELECT MAX(id) - ? FROM transition_log WHERE device_id = ?)
          AND measured_gap_ms IS NULL`,
    ).run(input.deviceId, KEEP_PER_DEVICE, input.deviceId);
    return Number(result.lastInsertRowid);
  } catch (err) {
    logger.debug(`Transitions: could not record: ${err}`);
    return null;
  }
}

export function listTransitions(options: { deviceId?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  try {
    const db = getRawDb();
    const rows = options.deviceId
      ? (db
          .prepare('SELECT * FROM transition_log WHERE device_id = ? ORDER BY id DESC LIMIT ?')
          .all(options.deviceId, limit) as Row[])
      : (db.prepare('SELECT * FROM transition_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]);
    return rows.map(toRecord);
  } catch (err) {
    logger.debug(`Transitions: could not list: ${err}`);
    return [];
  }
}

/**
 * Attach a real measurement to a transition. This is what turns a boundary
 * into evidence, so it carries how it was measured in the measurer's words.
 */
export function addMeasurement(
  id: number,
  measurement: { gapMs: number; method: string; note?: string },
): TransitionRecord | null {
  try {
    const db = getRawDb();
    const changes = db
      .prepare('UPDATE transition_log SET measured_gap_ms = ?, method = ?, note = ? WHERE id = ?')
      .run(Math.round(measurement.gapMs), measurement.method, measurement.note ?? null, id).changes;
    if (changes === 0) return null;
    const row = db.prepare('SELECT * FROM transition_log WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    logger.info(
      `Transitions: measured ${Math.round(measurement.gapMs)} ms on ${row.device_id} (${measurement.method})`,
    );
    return toRecord(row);
  } catch (err) {
    logger.warn(`Transitions: could not store measurement: ${err}`);
    return null;
  }
}

/**
 * The worst measured gap on an output. The worst, not the average: one audible
 * pause in twenty transitions means the output is not gapless, however good
 * the other nineteen were.
 */
export function worstMeasuredGap(deviceId: string): number | undefined {
  try {
    const row = getRawDb()
      .prepare(
        'SELECT MAX(measured_gap_ms) as worst FROM transition_log WHERE device_id = ? AND measured_gap_ms IS NOT NULL',
      )
      .get(deviceId) as { worst: number | null } | undefined;
    return row?.worst ?? undefined;
  } catch {
    return undefined;
  }
}

/** How many transitions on this output carry a measurement. */
export function measuredCount(deviceId: string): number {
  try {
    const row = getRawDb()
      .prepare(
        'SELECT COUNT(*) as n FROM transition_log WHERE device_id = ? AND measured_gap_ms IS NOT NULL',
      )
      .get(deviceId) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

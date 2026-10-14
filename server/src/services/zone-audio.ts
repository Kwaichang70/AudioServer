import { getRawDb } from '../db/index.js';

/**
 * Volume leveling per room on the speaker path (R10.2).
 *
 * - `auto`  (default) level only what the NAS converts anyway (R10.1): the
 *           file is no longer the original there, so leveling costs nothing
 *           extra in honesty or CPU.
 * - `off`   never touch the level.
 * - `track` / `album`  always level, with that ReplayGain. This converts
 *           even files the speaker takes as they are: a FLAC stays FLAC but
 *           is no longer bit-perfect, and the audio path says so.
 *
 * No EQ, by design.
 */

export type Leveling = 'auto' | 'off' | 'track' | 'album';

export const LEVELING_MODES: Leveling[] = ['auto', 'off', 'track', 'album'];

export function getLeveling(zoneId: string): Leveling {
  try {
    const row = getRawDb()
      .prepare('SELECT leveling FROM zone_audio WHERE zone_id = ?')
      .get(zoneId) as { leveling: string } | undefined;
    return LEVELING_MODES.includes(row?.leveling as Leveling)
      ? (row!.leveling as Leveling)
      : 'auto';
  } catch {
    return 'auto';
  }
}

export function setLeveling(zoneId: string, leveling: Leveling): void {
  getRawDb()
    .prepare(
      `INSERT INTO zone_audio (zone_id, leveling, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(zone_id) DO UPDATE SET leveling = excluded.leveling, updated_at = excluded.updated_at`,
    )
    .run(zoneId, leveling, Math.floor(Date.now() / 1000));
}

export interface LevelGain {
  /** dB to apply; already limited so the peak does not clip. */
  gainDb: number;
  /** Which ReplayGain value it came from. */
  basis: 'track' | 'album';
  /** True when the peak forced a smaller gain than ReplayGain asked for. */
  limitedByPeak: boolean;
}

/**
 * The gain for one track in this mode. Album gain falls back to track gain
 * (a single has no album value); no ReplayGain at all gives null — then
 * nothing is leveled, rather than guessing.
 */
export function replayGainFor(trackId: string, mode: 'track' | 'album'): LevelGain | null {
  let row:
    | {
        track_gain: number | null;
        track_peak: number | null;
        album_gain: number | null;
        album_peak: number | null;
      }
    | undefined;
  try {
    row = getRawDb()
      .prepare(
        `SELECT t.replay_gain_track AS track_gain, t.replay_gain_track_peak AS track_peak,
                a.replay_gain_album AS album_gain, a.replay_gain_album_peak AS album_peak
           FROM tracks t LEFT JOIN albums a ON a.id = t.album_id WHERE t.id = ?`,
      )
      .get(trackId) as typeof row;
  } catch {
    return null;
  }
  if (!row) return null;
  const useAlbum = mode === 'album' && row.album_gain !== null;
  const gain = useAlbum ? row.album_gain : row.track_gain;
  if (gain === null || !Number.isFinite(gain)) return null;
  const peak = useAlbum ? row.album_peak : row.track_peak;
  // The loudest sample after the gain must stay below full scale.
  const ceiling = peak && peak > 0 ? -20 * Math.log10(peak) : Infinity;
  const gainDb = Math.round(Math.min(gain, ceiling) * 100) / 100;
  return { gainDb, basis: useAlbum ? 'album' : 'track', limitedByPeak: gain > ceiling };
}

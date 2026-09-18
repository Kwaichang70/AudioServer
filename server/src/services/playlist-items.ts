import { randomUUID } from 'crypto';
import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';
import { getCapabilities, sourceOf, type PlaybackSource } from './playback-resolver.js';

/**
 * Playlist items (V12.1).
 *
 * A playlist used to be a list of pointers into the local library, so it
 * could hold nothing but local files and an item whose file left the library
 * silently vanished from the list. An item now carries two things instead:
 *
 * 1. a stable SOURCE REFERENCE — the track id plus the source it came from —
 *    which is what a restart, a rescan or a reconnect is measured against;
 * 2. a METADATA SNAPSHOT — title, artist, album, duration — taken when the
 *    item was added, so an item that cannot be played right now still says
 *    what it is instead of disappearing.
 *
 * What is deliberately NOT stored is a stream URL. Qobuz signs a URL that
 * expires within the hour and a local stream carries a signed token; both are
 * resolved at playback, never saved. A playlist therefore survives a restart
 * unchanged and asks for a URL only when a track is actually started.
 *
 * Availability is worked out per read, never written down: the library is
 * scanned and a provider logs in and out, so yesterday's answer is not
 * evidence about today.
 */

export type ItemAvailability = 'available' | 'missing' | 'unavailable';

export interface PlaylistItem {
  /** Stable identity of this playlist position (duplicates are separate items). */
  playlistItemId: string;
  playlistPosition: number;
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string | null;
  duration?: number | null;
  source: PlaybackSource;
  format?: string | null;
  coverUrl?: string | null;
  filePath?: string | null;
  replayGainTrack?: number | null;
  replayGainTrackPeak?: number | null;
  /**
   * 'available'    — playable right now
   * 'missing'      — a local file the scanner cannot find
   * 'unavailable'  — the source cannot play it right now (not connected, or
   *                  the track is no longer in the library)
   */
  availability: ItemAvailability;
  /** Why it cannot be played, in one sentence; absent when it can. */
  unavailableReason?: string;
  /** True when the row below is the snapshot rather than a live library row. */
  fromSnapshot: boolean;
}

interface ItemRow {
  id: number;
  item_id: string | null;
  track_id: string;
  source: string | null;
  track_title: string | null;
  artist_name: string | null;
  album_title: string | null;
  album_id: string | null;
  duration: number | null;
  metadata: string | null;
  position: number;
}

interface LocalRow {
  id: string;
  title: string;
  artist_name: string;
  album_title: string;
  album_id: string | null;
  duration: number | null;
  format: string | null;
  cover_url: string | null;
  file_path: string | null;
  replay_gain_track: number | null;
  replay_gain_track_peak: number | null;
  availability: string | null;
}

/** What a caller hands us when adding an item. */
export interface ItemInput {
  trackId: string;
  title?: string;
  artistName?: string;
  albumTitle?: string;
  albumId?: string | null;
  duration?: number | null;
  coverUrl?: string | null;
  format?: string | null;
}

export class UnknownTrackError extends Error {
  constructor(readonly trackId: string) {
    super(`Track ${trackId} is not in the library`);
    this.name = 'UnknownTrackError';
  }
}

export class MissingSnapshotError extends Error {
  constructor(readonly trackId: string) {
    super(
      `A ${sourceOf(trackId)} track needs at least a title and an artist: the server cannot look it up later, ` +
        'and an item without them would be an id nobody can read.',
    );
    this.name = 'MissingSnapshotError';
  }
}

function localTrack(trackId: string): LocalRow | undefined {
  try {
    return getRawDb()
      .prepare(
        `SELECT id, title, artist_name, album_title, album_id, duration, format, cover_url,
                file_path, replay_gain_track, replay_gain_track_peak, availability
           FROM tracks WHERE id = ?`,
      )
      .get(trackId) as LocalRow | undefined;
  } catch {
    return undefined;
  }
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Build the row to store. A local track is snapshotted from the library so
 * the caller cannot put a wrong name on a file we can read ourselves; an
 * external track is snapshotted from what the caller sends, because the
 * server has nowhere else to get it and cannot promise the provider will
 * still answer tomorrow.
 */
export function snapshotOf(input: ItemInput): {
  trackId: string;
  source: PlaybackSource;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId: string | null;
  duration: number | null;
  metadata: string | null;
} {
  const source = sourceOf(input.trackId);
  if (source === 'local') {
    const row = localTrack(input.trackId);
    if (!row) throw new UnknownTrackError(input.trackId);
    return {
      trackId: row.id,
      source,
      title: row.title,
      artistName: row.artist_name,
      albumTitle: row.album_title,
      albumId: row.album_id,
      duration: row.duration,
      metadata: row.format ? JSON.stringify({ format: row.format }) : null,
    };
  }

  const title = input.title?.trim();
  const artistName = input.artistName?.trim();
  if (!title || !artistName) throw new MissingSnapshotError(input.trackId);
  const extra: Record<string, unknown> = {};
  if (input.coverUrl) extra.coverUrl = input.coverUrl;
  if (input.format) extra.format = input.format;
  return {
    trackId: input.trackId,
    source,
    title,
    artistName,
    albumTitle: input.albumTitle?.trim() || '',
    albumId: input.albumId ?? null,
    duration: typeof input.duration === 'number' ? input.duration : null,
    metadata: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  };
}

/** Add one item at the end of a playlist. Returns the new item id. */
export function addItem(playlistId: string, input: ItemInput): string {
  const snapshot = snapshotOf(input);
  const db = getRawDb();
  const next =
    (
      db
        .prepare('SELECT MAX(position) as maxPos FROM playlist_tracks WHERE playlist_id = ?')
        .get(playlistId) as { maxPos: number | null } | undefined
    )?.maxPos ?? null;
  const position = next === null ? 0 : next + 1;
  const itemId = `pli-${randomUUID()}`;
  db.prepare(
    `INSERT INTO playlist_tracks
       (playlist_id, item_id, track_id, source, track_title, artist_name, album_title,
        album_id, duration, metadata, position, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
  ).run(
    playlistId,
    itemId,
    snapshot.trackId,
    snapshot.source,
    snapshot.title,
    snapshot.artistName,
    snapshot.albumTitle,
    snapshot.albumId,
    snapshot.duration,
    snapshot.metadata,
    position,
  );
  return itemId;
}

export function rawItems(playlistId: string): ItemRow[] {
  try {
    return getRawDb()
      .prepare(
        `SELECT id, item_id, track_id, source, track_title, artist_name, album_title,
                album_id, duration, metadata, position
           FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, id ASC`,
      )
      .all(playlistId) as ItemRow[];
  } catch (err) {
    logger.warn(`Playlists: could not read items of ${playlistId}: ${err}`);
    return [];
  }
}

/**
 * Why a source cannot play right now. The wording is about the source, not
 * about the track: a Qobuz item is not "gone" when nobody is logged in, it is
 * unavailable until the account is connected again.
 */
function sourceReason(source: PlaybackSource): string | undefined {
  const caps = getCapabilities(source);
  if (caps.serverDispatch || caps.browser) return undefined;
  if (caps.externalPlayer) {
    return caps.reason ?? `${source} plays through ${caps.externalPlayer}, not a stream URL`;
  }
  return caps.reason ?? `${source} cannot be played from here right now`;
}

/**
 * One playlist as its items. Nothing is ever dropped: an item the server
 * cannot play keeps its snapshot and says why, which is the whole point of
 * storing the snapshot in the first place.
 */
export function listItems(playlistId: string): PlaylistItem[] {
  return rawItems(playlistId).map((row) => toItem(row));
}

function toItem(row: ItemRow): PlaylistItem {
  const source = (row.source as PlaybackSource) || sourceOf(row.track_id);
  const extra = parseMetadata(row.metadata);
  const base: PlaylistItem = {
    playlistItemId: row.item_id ?? `pli-row-${row.id}`,
    playlistPosition: row.position,
    id: row.track_id,
    title: row.track_title ?? row.track_id,
    artistName: row.artist_name ?? '',
    albumTitle: row.album_title ?? '',
    albumId: row.album_id,
    duration: row.duration,
    source,
    format: typeof extra.format === 'string' ? extra.format : null,
    coverUrl: typeof extra.coverUrl === 'string' ? extra.coverUrl : null,
    availability: 'available',
    fromSnapshot: true,
  };

  if (source !== 'local') {
    const reason = sourceReason(source);
    if (reason) {
      base.availability = 'unavailable';
      base.unavailableReason = reason;
    }
    return base;
  }

  const live = localTrack(row.track_id);
  if (!live) {
    return {
      ...base,
      availability: 'unavailable',
      unavailableReason:
        'This track is no longer in the library. The name above is what it was when it was added.',
    };
  }

  // A live row wins over the snapshot: the library is the truth about a file
  // that is still there, including a title corrected by a later scan.
  return {
    ...base,
    title: live.title,
    artistName: live.artist_name,
    albumTitle: live.album_title,
    albumId: live.album_id,
    duration: live.duration,
    format: live.format,
    coverUrl: live.cover_url,
    filePath: live.file_path,
    replayGainTrack: live.replay_gain_track,
    replayGainTrackPeak: live.replay_gain_track_peak,
    fromSnapshot: false,
    availability: live.availability === 'missing' ? 'missing' : 'available',
    unavailableReason:
      live.availability === 'missing'
        ? 'The file is not where the library expects it; a scan or a relink brings it back.'
        : undefined,
  };
}

/** Remove one item by its own id; falls back to the first item of a track id. */
export function removeItem(playlistId: string, itemOrTrackId: string): boolean {
  const items = rawItems(playlistId);
  const target =
    items.find((i) => i.item_id === itemOrTrackId) ??
    items.find((i) => i.track_id === itemOrTrackId);
  if (!target) return false;
  getRawDb().prepare('DELETE FROM playlist_tracks WHERE id = ?').run(target.id);
  return true;
}

/**
 * Put the items in the given order. Ids may be item ids (exact) or track ids
 * (the old client); anything the caller leaves out keeps its relative order
 * at the end, so a stale list can never silently drop an item.
 */
export function reorderItems(playlistId: string, ids: string[]): void {
  const items = rawItems(playlistId);
  const remaining = [...items];
  const ordered: ItemRow[] = [];
  for (const id of ids) {
    const byItem = remaining.findIndex((i) => i.item_id === id);
    const index = byItem !== -1 ? byItem : remaining.findIndex((i) => i.track_id === id);
    if (index === -1) continue;
    ordered.push(remaining[index]);
    remaining.splice(index, 1);
  }
  const finalOrder = [...ordered, ...remaining];
  const db = getRawDb();
  const update = db.prepare('UPDATE playlist_tracks SET position = ? WHERE id = ?');
  db.transaction(() => {
    finalOrder.forEach((item, index) => update.run(index, item.id));
  })();
}

export function itemCount(playlistId: string): number {
  try {
    return (
      (
        getRawDb()
          .prepare('SELECT COUNT(*) as n FROM playlist_tracks WHERE playlist_id = ?')
          .get(playlistId) as { n: number } | undefined
      )?.n ?? 0
    );
  } catch {
    return 0;
  }
}

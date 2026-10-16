import { getRawDb } from '../db/index.js';
import { zones, type Zone } from './zones.js';
import type { TrackInfo } from './playback.js';
import type { PlaybackOrigin } from '../types/socket-events.js';
import { isServerManagedDevice, startServerPlayback, stopRoom } from './server-player.js';
import { listItems } from './playlist-items.js';
import { definitionOf, evaluateDefinition } from './smart-playlists.js';
import { leaderOf } from './sonos-groups.js';
import { searchText } from '../utils/search-text.js';
import { deviceManager } from '../devices/manager.js';
import { logger } from '../logger.js';

/**
 * Simple commands by name, for automations and assistants (Homey, Grok,
 * Jarvis): "play the playlist Sunday in the living room", "pause the
 * kitchen", "volume 30 in the bedroom".
 *
 * Names are matched without case or accents: exact first, then the start,
 * then anywhere in the name. An unknown or ambiguous name is refused with the
 * names that do exist, so whoever wrote the flow can correct it.
 *
 * Each command drives the room's session AND its speaker: the session alone
 * does not reach the device (the app's tab sends pause/volume to it itself,
 * an automation has no tab).
 */

export class ControlError extends Error {
  constructor(
    public code:
      | 'unknown_room'
      | 'room_required'
      | 'not_found'
      | 'ambiguous'
      | 'not_playable'
      | 'empty',
    message: string,
    public options: string[] = [],
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

export interface NamedItem {
  id: string;
  name: string;
}

/** Find one item by name: exact, then prefix, then substring; refuse what is unclear. */
export function matchByName<T extends NamedItem>(items: T[], wanted: string, what: string): T {
  const want = searchText(wanted);
  const byId = items.find((i) => i.id === wanted);
  if (byId) return byId;
  const norm = (i: T) => searchText(i.name);
  for (const test of [
    (n: string) => n === want,
    (n: string) => n.startsWith(want),
    (n: string) => n.includes(want),
  ]) {
    const found = items.filter((i) => want.length > 0 && test(norm(i)));
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new ControlError(
        'ambiguous',
        `More than one ${what} matches "${wanted}": ${found
          .slice(0, 5)
          .map((i) => i.name)
          .join(', ')}.`,
        found.slice(0, 10).map((i) => i.name),
      );
    }
  }
  const all = items.map((i) => i.name);
  throw new ControlError(
    'not_found',
    `No ${what} called "${wanted}"${all.length ? `; there are: ${all.slice(0, 10).join(', ')}` : ''}.`,
    all.slice(0, 20),
  );
}

// ─── Rooms ───────────────────────────────────────────────────────

/** Rooms a command can play in by itself: speakers, not a browser tab. */
function speakerRooms(): Zone[] {
  return zones.list().filter((z) => isServerManagedDevice(z.deviceId));
}

/**
 * The room a command means. A name or id; without one, the only speaker room
 * there is (a household with one speaker should not have to name it).
 */
export function resolveRoom(room: string | undefined): Zone {
  const rooms = speakerRooms();
  if (!room) {
    if (rooms.length === 1) return rooms[0];
    throw new ControlError(
      'room_required',
      `Say which room: ${rooms.map((r) => r.name).join(', ') || 'no speaker rooms yet'}.`,
      rooms.map((r) => r.name),
    );
  }
  const all = zones.list();
  const zone = matchByName(
    all.map((z) => ({ ...z, name: z.name })),
    room,
    'room',
  );
  if (!isServerManagedDevice(zone.deviceId)) {
    throw new ControlError(
      'not_playable',
      `"${zone.name}" plays in a browser tab; a command can only start music on a speaker.`,
      rooms.map((r) => r.name),
    );
  }
  const leader = leaderOf(zone.id);
  if (leader) {
    throw new ControlError(
      'not_playable',
      `"${zone.name}" plays along with "${leader.name}"; use "${leader.name}".`,
      [leader.name],
    );
  }
  return zone;
}

export function listRooms() {
  return zones.list().map((zone) => {
    const state = zones.sessionFor(zone.id).getState();
    return {
      id: zone.id,
      name: zone.name,
      speaker: isServerManagedDevice(zone.deviceId),
      state: state.state,
      track: state.track
        ? {
            title: state.track.title,
            artist: state.track.artistName,
            album: state.track.albumTitle,
          }
        : null,
      volume: state.volume,
    };
  });
}

// ─── What to play ────────────────────────────────────────────────

const playable = "COALESCE(t.availability, 'available') NOT IN ('missing', 'unavailable')";

interface TrackRow {
  id: string;
  title: string;
  artist_name: string;
  album_title: string;
  album_id: string | null;
  duration: number | null;
  source: string | null;
  format: string | null;
}

const toTrack = (r: TrackRow): TrackInfo => ({
  id: r.id,
  title: r.title,
  artistName: r.artist_name,
  albumTitle: r.album_title,
  albumId: r.album_id ?? undefined,
  duration: r.duration ?? undefined,
  source: r.source ?? 'local',
  metadata: r.format ? { format: r.format } : undefined,
});

const trackColumns =
  't.id, t.title, t.artist_name, t.album_title, t.album_id, t.duration, t.source, t.format';

export function listPlaylists(userId: string) {
  const db = getRawDb();
  const own = db
    .prepare(
      `SELECT id, name, track_count AS trackCount FROM playlists
        WHERE user_id = ? OR shared = 1 ORDER BY name`,
    )
    .all(userId) as Array<{ id: string; name: string; trackCount: number | null }>;
  const smart = db
    .prepare(
      `SELECT id, name, track_count AS trackCount FROM smart_playlists
        WHERE user_id = ? OR shared = 1 OR user_id IS NULL ORDER BY name`,
    )
    .all(userId) as Array<{ id: string; name: string; trackCount: number | null }>;
  return [
    ...own.map((p) => ({ ...p, kind: 'playlist' as const })),
    ...smart.map((p) => ({ ...p, kind: 'smart' as const })),
  ];
}

function playlistTracks(userId: string, wanted: string): { name: string; tracks: TrackInfo[] } {
  const all = listPlaylists(userId);
  const found = matchByName(all, wanted, 'playlist');
  if (found.kind === 'playlist') {
    const tracks = listItems(found.id)
      .filter((i) => i.availability === 'available')
      .map(
        (i): TrackInfo => ({
          id: i.id,
          title: i.title,
          artistName: i.artistName,
          albumTitle: i.albumTitle,
          albumId: i.albumId ?? undefined,
          duration: i.duration ?? undefined,
          source: i.source,
          metadata: i.format ? { format: i.format } : undefined,
        }),
      );
    return { name: found.name, tracks };
  }
  const row = getRawDb()
    .prepare('SELECT * FROM smart_playlists WHERE id = ?')
    .get(found.id) as Parameters<typeof definitionOf>[0] & { user_id: string | null };
  const definition = definitionOf(row);
  if (!definition) {
    throw new ControlError('empty', `The smart playlist "${found.name}" cannot be read.`);
  }
  const { rows } = evaluateDefinition(definition, row.user_id ?? userId);
  const tracks = rows.map(
    (r): TrackInfo => ({
      id: String(r.id),
      title: String(r.title ?? ''),
      artistName: String(r.artistName ?? ''),
      albumTitle: String(r.albumTitle ?? ''),
      albumId: (r.albumId as string | undefined) ?? undefined,
      duration: (r.duration as number | undefined) ?? undefined,
      source: (r.source as string | undefined) ?? 'local',
    }),
  );
  return { name: found.name, tracks };
}

function albumTracks(wanted: string, artist?: string): { name: string; tracks: TrackInfo[] } {
  const db = getRawDb();
  let albums = db
    .prepare('SELECT id, title AS name, artist_name AS artist FROM albums ORDER BY title')
    .all() as Array<{ id: string; name: string; artist: string }>;
  if (artist) {
    const a = searchText(artist);
    albums = albums.filter((x) => searchText(x.artist).includes(a));
  }
  const album = matchByName(albums, wanted, 'album');
  const tracks = (
    db
      .prepare(
        `SELECT ${trackColumns} FROM tracks t WHERE t.album_id = ? AND ${playable}
          ORDER BY t.disc_number, t.track_number, t.title`,
      )
      .all(album.id) as TrackRow[]
  ).map(toTrack);
  return { name: `${album.name} (${album.artist})`, tracks };
}

function artistTracks(wanted: string): { name: string; tracks: TrackInfo[] } {
  const db = getRawDb();
  const artists = db.prepare('SELECT id, name FROM artists ORDER BY name').all() as NamedItem[];
  const artist = matchByName(artists, wanted, 'artist');
  const tracks = (
    db
      .prepare(
        `SELECT ${trackColumns} FROM tracks t LEFT JOIN albums a ON a.id = t.album_id
          WHERE t.artist_id = ? AND ${playable}
          ORDER BY COALESCE(a.year, 9999), t.album_title, t.disc_number, t.track_number`,
      )
      .all(artist.id) as TrackRow[]
  ).map(toTrack);
  return { name: artist.name, tracks };
}

// ─── Commands ────────────────────────────────────────────────────

export interface PlayRequest {
  room?: string;
  playlist?: string;
  album?: string;
  artist?: string;
  shuffle?: boolean;
}

/** Play a playlist, an album or an artist in a room. */
export function playInRoom(userId: string, request: PlayRequest, origin: PlaybackOrigin) {
  const zone = resolveRoom(request.room);
  const chosen = request.playlist
    ? playlistTracks(userId, request.playlist)
    : request.album
      ? albumTracks(request.album, request.artist)
      : request.artist
        ? artistTracks(request.artist)
        : null;
  if (!chosen) {
    throw new ControlError('not_found', 'Say what to play: a playlist, an album or an artist.');
  }
  if (chosen.tracks.length === 0) {
    throw new ControlError('empty', `"${chosen.name}" has nothing that can play right now.`);
  }
  const session = zones.sessionFor(zone.id);
  session.setQueue(chosen.tracks, 0, origin, zone.deviceId);
  session.setShuffle(request.shuffle === true, origin);
  startServerPlayback(userId, zone.deviceId, zone.id);
  const current = session.getCurrentItemId();
  if (current) session.playItem(current, origin, zone.deviceId);
  logger.info(
    `Control: "${chosen.name}" (${chosen.tracks.length} tracks) in "${zone.name}"${request.shuffle ? ', shuffled' : ''}`,
  );
  return {
    room: zone.name,
    playing: chosen.name,
    tracks: chosen.tracks.length,
    first: session.getCurrentTrack()?.title ?? null,
  };
}

async function onDevice(zone: Zone, what: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    logger.warn(`Control: ${what} on ${zone.deviceId} failed: ${err}`);
  }
}

export async function pauseRoom(room: string | undefined, origin: PlaybackOrigin) {
  const zone = resolveRoom(room);
  zones.sessionFor(zone.id).pause(origin);
  await onDevice(zone, 'pause', () => deviceManager.pause(zone.deviceId));
  return { room: zone.name, state: 'paused' };
}

export async function resumeRoom(room: string | undefined, userId: string, origin: PlaybackOrigin) {
  const zone = resolveRoom(room);
  const session = zones.sessionFor(zone.id);
  const state = session.getState().state;
  const current = session.getCurrentItemId();
  if (!current) throw new ControlError('empty', `Nothing is queued in "${zone.name}".`);
  if (state === 'stopped') {
    // A stopped speaker has nothing loaded: start the current item again.
    startServerPlayback(userId, zone.deviceId, zone.id);
    session.playItem(current, origin, zone.deviceId);
  } else {
    session.resume(origin);
    await onDevice(zone, 'resume', () => deviceManager.resume(zone.deviceId));
  }
  return { room: zone.name, state: 'playing', track: session.getCurrentTrack()?.title ?? null };
}

export async function stopInRoom(room: string | undefined) {
  const zone = resolveRoom(room);
  await stopRoom(zone.id);
  return { room: zone.name, state: 'stopped' };
}

export function skipInRoom(
  room: string | undefined,
  direction: 'next' | 'previous',
  origin: PlaybackOrigin,
) {
  const zone = resolveRoom(room);
  const session = zones.sessionFor(zone.id);
  if (direction === 'next') session.advance(origin);
  else session.previous(origin);
  return { room: zone.name, track: session.getCurrentTrack()?.title ?? null };
}

export async function setRoomVolume(
  room: string | undefined,
  volume: number,
  origin: PlaybackOrigin,
) {
  const zone = resolveRoom(room);
  const level = Math.max(0, Math.min(100, Math.round(volume)));
  zones.sessionFor(zone.id).setVolume(level, origin);
  await onDevice(zone, 'volume', () => deviceManager.setVolume(zone.deviceId, level));
  return { room: zone.name, volume: level };
}

export function nowPlaying(room: string | undefined) {
  const zone = resolveRoom(room);
  const state = zones.sessionFor(zone.id).getState();
  return {
    room: zone.name,
    state: state.state,
    track: state.track
      ? {
          title: state.track.title,
          artist: state.track.artistName,
          album: state.track.albumTitle,
        }
      : null,
    position: Math.round(state.position ?? 0),
    volume: state.volume,
  };
}

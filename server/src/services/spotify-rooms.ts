import { providers } from '../providers/registry.js';
import type { SpotifyConnectDevice } from '../providers/spotify.js';
import { deviceManager } from '../devices/manager.js';
import { zones, type Zone } from './zones.js';
import { stopRoom } from './server-player.js';
import { ControlError, matchByName, resolveRoom } from './remote-control.js';
import { searchText } from '../utils/search-text.js';
import { logger } from '../logger.js';

/**
 * Spotify in a room, started by the server (Homey, Grok, Jarvis): the room's
 * speaker is told to play through Spotify Connect, and fetches the music from
 * Spotify itself. Sonos and CocktailAudio are Connect devices of their own, so
 * no audio passes through the NAS and the quality is Spotify's.
 *
 * Which Connect device is the room's speaker is found by name: the room's
 * name or the speaker's, against the names Spotify lists. When that does not
 * match, the fix is to give the room the speaker's Spotify name.
 *
 * While Spotify plays in a room, the room's pause, resume, skip and stop go to
 * Spotify; the room is remembered here, and Spotify's own player state is
 * checked before each of those, so a room the app has since taken back is not
 * steered as Spotify by mistake.
 */

interface SpotifyRoom {
  deviceId: string;
  deviceName: string;
  playing: string;
}

const spotifyRooms = new Map<string, SpotifyRoom>();

const spotify = () => providers.spotify;

function requireSpotify(): void {
  if (!spotify().auth.isAuthenticated) {
    throw new ControlError(
      'not_playable',
      'Spotify is not connected: Settings → Streaming Providers → Connect Spotify.',
    );
  }
}

const words = (s: string) =>
  searchText(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

/**
 * The Connect device that is this room's speaker. Exact name first (the room's
 * or the speaker's), then one containing the other, then shared words; more
 * than one candidate at a level is refused rather than guessed.
 */
export function pickConnectDevice(
  names: string[],
  devices: SpotifyConnectDevice[],
): SpotifyConnectDevice | 'ambiguous' | null {
  const wanted = names.map(searchText).filter(Boolean);
  const levels: Array<(d: string) => boolean> = [
    (d) => wanted.includes(d),
    (d) => wanted.some((w) => d.includes(w) || w.includes(d)),
    (d) => {
      const dw = words(d);
      return wanted.some((w) => words(w).some((x) => dw.includes(x)));
    },
  ];
  for (const level of levels) {
    const found = devices.filter((d) => !d.is_restricted && level(searchText(d.name)));
    if (found.length === 1) return found[0];
    if (found.length > 1) return 'ambiguous';
  }
  return null;
}

async function connectDeviceFor(zone: Zone): Promise<SpotifyConnectDevice> {
  const devices = await spotify().getConnectDevices();
  const speaker = (await deviceManager.getDevices()).find((d) => d.id === zone.deviceId);
  const names = [zone.name, speaker?.name ?? ''];
  const picked = pickConnectDevice(names, devices);
  const listed = devices.map((d) => d.name);
  if (picked === 'ambiguous') {
    throw new ControlError(
      'ambiguous',
      `More than one Spotify device could be "${zone.name}"; give the room the speaker's exact Spotify name.`,
      listed,
    );
  }
  if (!picked) {
    throw new ControlError(
      'not_found',
      `Spotify does not see the speaker of "${zone.name}"${listed.length ? `; it sees: ${listed.join(', ')}` : ''}. ` +
        "Is the speaker on? Otherwise give the room the speaker's name as Spotify shows it.",
      listed,
    );
  }
  return picked;
}

export interface SpotifyPlayRequest {
  room?: string;
  playlist?: string;
  album?: string;
  artist?: string;
  shuffle?: boolean;
}

interface Chosen {
  name: string;
  contextUri: string;
  trackCount?: number;
}

const rawId = (id: string) => id.replace(/^spotify:/, '');

async function chooseOnSpotify(request: SpotifyPlayRequest): Promise<Chosen> {
  if (request.playlist) {
    const lists = await spotify().getPlaylists();
    const found = matchByName(lists, request.playlist, 'Spotify playlist');
    return {
      name: found.name,
      contextUri: `spotify:playlist:${rawId(found.id)}`,
      trackCount: found.trackCount,
    };
  }
  if (request.album) {
    const query = [request.album, request.artist].filter(Boolean).join(' ');
    const { albums } = await spotify().search(query, 10);
    const exact = albums.filter(
      (a) =>
        searchText(a.title) === searchText(request.album!) &&
        (!request.artist || searchText(a.artistName).includes(searchText(request.artist))),
    );
    const album = exact[0] ?? albums[0];
    if (!album) throw new ControlError('not_found', `Spotify has no album "${query}".`);
    return {
      name: `${album.title} (${album.artistName})`,
      contextUri: `spotify:album:${rawId(album.id)}`,
      trackCount: album.trackCount,
    };
  }
  if (request.artist) {
    const { artists } = await spotify().search(request.artist, 10);
    const artist =
      artists.find((a) => searchText(a.name) === searchText(request.artist!)) ?? artists[0];
    if (!artist) throw new ControlError('not_found', `Spotify has no artist "${request.artist}".`);
    return { name: artist.name, contextUri: `spotify:artist:${rawId(artist.id)}` };
  }
  throw new ControlError('not_found', 'Say what to play: a playlist, an album or an artist.');
}

/** Spotify playlists by name, for whoever builds a flow or asks an assistant. */
export async function listSpotifyPlaylists() {
  if (!spotify().auth.isAuthenticated) return [];
  return (await spotify().getPlaylists()).map((p) => ({
    name: p.name,
    trackCount: p.trackCount,
    kind: 'spotify' as const,
  }));
}

/** Play a Spotify playlist, album or artist on the room's speaker. */
export async function playSpotifyInRoom(request: SpotifyPlayRequest) {
  requireSpotify();
  const zone = resolveRoom(request.room);
  const [device, chosen] = await Promise.all([connectDeviceFor(zone), chooseOnSpotify(request)]);

  // AudioServer must let go of the speaker first, or it would take it back
  // when it sees its own track gone.
  const state = zones.sessionFor(zone.id).getState().state;
  if (state !== 'stopped') await stopRoom(zone.id);

  const offset =
    request.shuffle && chosen.trackCount && chosen.trackCount > 1
      ? Math.floor(Math.random() * chosen.trackCount)
      : undefined;
  await spotify().connectPlayContext(chosen.contextUri, device.id, offset);
  try {
    await spotify().connectSetShuffle(request.shuffle === true, device.id);
  } catch (err) {
    logger.debug(`Spotify shuffle on ${device.name}: ${err}`);
  }
  spotifyRooms.set(zone.id, { deviceId: device.id, deviceName: device.name, playing: chosen.name });
  logger.info(`Control: Spotify "${chosen.name}" in "${zone.name}" on ${device.name}`);
  return {
    room: zone.name,
    playing: chosen.name,
    source: 'spotify',
    speaker: device.name,
    shuffle: request.shuffle === true,
  };
}

/** The room no longer plays Spotify (AudioServer took it back). */
export function forgetSpotifyRoom(zoneId: string): void {
  spotifyRooms.delete(zoneId);
}

/**
 * The Spotify device a room is playing on right now, or null. Asks Spotify, so
 * a room the app or the Spotify app has since moved elsewhere is let go.
 */
export async function activeSpotifyDevice(zoneId: string): Promise<SpotifyRoom | null> {
  const room = spotifyRooms.get(zoneId);
  if (!room || !spotify().auth.isAuthenticated) return null;
  const state = await spotify().getPlaybackState();
  if (state?.device?.id !== room.deviceId) {
    if (state) spotifyRooms.delete(zoneId);
    return state ? null : room;
  }
  return room;
}

export async function spotifyNowPlaying(zoneId: string) {
  const room = spotifyRooms.get(zoneId);
  if (!room) return null;
  const state = await spotify().getPlaybackState();
  if (!state || state.device?.id !== room.deviceId) return null;
  return {
    state: state.is_playing ? 'playing' : 'paused',
    track: state.item
      ? {
          title: state.item.name,
          artist: state.item.artists?.[0]?.name ?? '',
          album: state.item.album?.name ?? '',
        }
      : null,
    position: Math.round((state.progress_ms ?? 0) / 1000),
    volume: state.device?.volume_percent ?? null,
    source: 'spotify' as const,
    speaker: room.deviceName,
    playlist: room.playing,
  };
}

export const spotifyControl = {
  pause: (room: SpotifyRoom) => spotify().connectPause(room.deviceId),
  resume: (room: SpotifyRoom) => spotify().connectResume(room.deviceId),
  next: (room: SpotifyRoom) => spotify().connectNext(room.deviceId),
  previous: (room: SpotifyRoom) => spotify().connectPrevious(room.deviceId),
  volume: (room: SpotifyRoom, level: number) => spotify().connectSetVolume(level, room.deviceId),
};

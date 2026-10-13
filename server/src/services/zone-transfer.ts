import { zones, type Zone } from './zones.js';
import type { TrackInfo } from './playback.js';
import type { PlaybackOrigin } from '../types/socket-events.js';
import { isServerManagedDevice, startServerPlayback, stopServerPlayback } from './server-player.js';
import { getRadioState, setRadio } from './library-radio.js';
import { deviceManager } from '../devices/manager.js';
import { supportsSeek } from './output-capabilities.js';
import { logger } from '../logger.js';
import { leaderOf } from './sonos-groups.js';

/**
 * Move the music to another room (R09.2): the queue, the item playing and
 * how far into it, shuffle, repeat and radio go along; the old room stops.
 *
 * This is not synchronisation — it is one room handing over to the next, so
 * it works across protocols: from the kitchen Sonos to the living-room DLNA
 * amplifier, or from the browser to a speaker.
 *
 * The target has to be a room the server can play on by itself (a speaker).
 * A browser room plays only while a tab is open in it, and the server cannot
 * start a tab — that is said, not attempted.
 */

export class TransferError extends Error {
  constructor(
    public code:
      | 'same_zone'
      | 'unknown_zone'
      | 'nothing_playing'
      | 'target_not_server_playable'
      | 'target_grouped',
    message: string,
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

export interface TransferResult {
  from: Zone;
  to: Zone;
  trackId: string;
  position: number;
  /** Did the target jump to the position? False when it cannot seek or never started. */
  resumedAtPosition: boolean;
  note?: string;
}

interface TransferDeps {
  /** Wait until the target zone reports the item playing; false on timeout. */
  waitUntilPlaying: (zoneId: string, itemId: string, timeoutMs: number) => Promise<boolean>;
  canSeek: (deviceId: string) => Promise<boolean>;
  seek: (deviceId: string, position: number) => Promise<boolean>;
  /** Silence the old room's speaker; stopping the session alone does not. */
  stopDevice: (deviceId: string) => Promise<void>;
  timeoutMs: number;
}

const defaults = (): TransferDeps => ({
  waitUntilPlaying: (zoneId, itemId, timeoutMs) =>
    new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        const dispatch = zones.sessionFor(zoneId).getDispatch();
        if (dispatch.state === 'playing' && dispatch.itemId === itemId) return resolve(true);
        if (
          dispatch.state === 'error' ||
          dispatch.state === 'skipped' ||
          Date.now() - started > timeoutMs
        ) {
          return resolve(false);
        }
        setTimeout(check, 250);
      };
      check();
    }),
  canSeek: (deviceId) => supportsSeek(deviceId),
  seek: (deviceId, position) => deviceManager.seek(deviceId, position),
  stopDevice: (deviceId) => deviceManager.stop(deviceId),
  timeoutMs: 10_000,
});

let deps = defaults();

export function configureZoneTransfer(overrides: Partial<TransferDeps>): void {
  deps = { ...defaults(), ...overrides };
}

export function resetZoneTransfer(): void {
  deps = defaults();
}

function addNote(result: TransferResult, note: string): void {
  result.note = result.note ? `${result.note} ${note}` : note;
}

/** Below this many seconds in, starting the track over is as good as resuming. */
const RESUME_MIN_SECONDS = 3;

export async function transferZone(
  fromZoneId: string,
  toZoneId: string,
  userId: string,
  origin: PlaybackOrigin,
): Promise<TransferResult> {
  if (fromZoneId === toZoneId) {
    throw new TransferError('same_zone', 'The music is already in that room.');
  }
  const from = zones.list().find((z) => z.id === fromZoneId);
  const to = zones.list().find((z) => z.id === toZoneId);
  if (!from || !to) throw new TransferError('unknown_zone', 'That room does not exist.');
  if (!isServerManagedDevice(to.deviceId)) {
    throw new TransferError(
      'target_not_server_playable',
      `“${to.name}” plays in a browser tab; open the app there and play from that tab instead.`,
    );
  }

  const leader = leaderOf(to.id);
  if (leader) {
    throw new TransferError(
      'target_grouped',
      `“${to.name}” plays along with “${leader.name}”; take it out of the group first.`,
    );
  }

  const source = zones.sessionFor(from.id);
  const snapshot = source.getSnapshot();
  const queue = source.getQueue();
  const currentIndex = queue.findIndex((e) => e.itemId === snapshot.currentItemId);
  if (queue.length === 0 || currentIndex < 0) {
    throw new TransferError('nothing_playing', `Nothing is queued in “${from.name}” to move.`);
  }
  const position = Math.max(0, Math.floor(snapshot.state.position ?? 0));
  const tracks: TrackInfo[] = queue.map((entry) => ({
    id: entry.trackId,
    title: entry.trackTitle,
    artistName: entry.artistName,
    albumTitle: entry.albumTitle,
    albumId: entry.albumId,
    duration: entry.duration,
    source: entry.source,
    metadata: entry.metadata,
  }));

  // The new room takes over first, so the music is never nowhere.
  const target = zones.sessionFor(to.id);
  target.setQueue(tracks, currentIndex, origin, to.deviceId);
  target.setShuffle(snapshot.shuffle, origin);
  target.setRepeat(snapshot.repeat, origin);
  const radio = getRadioState(from.id);
  if (radio.enabled) setRadio(to.id, true, radio.seed, userId);
  startServerPlayback(userId, to.deviceId, to.id);
  const itemId = target.getCurrentItemId();
  if (itemId) target.playItem(itemId, origin, to.deviceId);

  // Then the old room stops and lets go of its speaker. The session going
  // idle does not reach the device, so the speaker is told to stop too; a
  // browser room is silenced by its own tab.
  source.stop(origin);
  stopServerPlayback(from.id);
  if (radio.enabled) setRadio(from.id, false, null, userId);
  let stopFailed = false;
  if (isServerManagedDevice(from.deviceId)) {
    try {
      await deps.stopDevice(from.deviceId);
    } catch (err) {
      stopFailed = true;
      logger.warn(`Transfer: stopping ${from.deviceId} failed: ${err}`);
    }
  }

  const result: TransferResult = {
    from,
    to,
    trackId: tracks[currentIndex].id,
    position,
    resumedAtPosition: false,
  };
  if (stopFailed) {
    result.note = `“${from.name}” did not respond to stop; it may still be playing.`;
  }
  if (position < RESUME_MIN_SECONDS || !itemId) return result;

  // Resume where it was: once the speaker plays the item, jump into it.
  if (!(await deps.waitUntilPlaying(to.id, itemId, deps.timeoutMs))) {
    addNote(
      result,
      `“${to.name}” did not start in time; it plays from the beginning of the track.`,
    );
    return result;
  }
  if (!(await deps.canSeek(to.deviceId))) {
    addNote(
      result,
      `“${to.name}” cannot jump inside a track; it plays from the beginning of the track.`,
    );
    return result;
  }
  try {
    if (await deps.seek(to.deviceId, position)) {
      target.seekTo(position, origin);
      result.resumedAtPosition = true;
    } else {
      addNote(result, `“${to.name}” refused the jump; it plays from the beginning of the track.`);
    }
  } catch (err) {
    logger.warn(`Transfer: seek on ${to.deviceId} failed: ${err}`);
    addNote(result, `“${to.name}” refused the jump; it plays from the beginning of the track.`);
  }
  return result;
}

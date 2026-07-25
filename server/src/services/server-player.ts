import { playbackService } from './playback.js';
import { deviceMonitor } from './device-monitor.js';
import { deviceManager } from '../devices/manager.js';
import { signStreamToken } from '../middleware/auth.js';
import { scrobbler } from './scrobbler.js';
import { getRawDb } from '../db/index.js';
import { getLanAddress } from '../utils/network.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Server-driven playback ("NAS conducts the music").
 *
 * Historically the CLIENT advanced external-device playback: it watched
 * device status, detected track end, and pushed the next stream URL to the
 * device. That chain breaks the moment the tablet sleeps — playback stops
 * after the current track.
 *
 * This module closes the loop on the server instead:
 *   device-monitor detects track end  →  playbackService.advance() picks the
 *   next queue entry  →  our onAdvance hook streams it to the device.
 * The client's only job is to hand the queue to the server (POST
 * /playback/queue/set) and mirror the UI from Socket.IO events.
 */

interface AdvanceTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId?: string;
  duration?: number;
}

// The user whose stream token authorizes device fetches, captured when the
// queue is handed over. Tokens are short-lived, so a fresh one is minted for
// every dispatched track rather than stored.
let ownerUserId: string | null = null;
let activeDeviceId: string | null = null;

/** External renderers we can stream local files to (DLNA/Sonos/Volumio). */
export function isServerManagedDevice(deviceId: string | null | undefined): boolean {
  return !!deviceId && deviceId !== 'browser' && !deviceId.startsWith('spotify-connect:');
}

/** Only local library tracks live on our disk; provider ids can't be served. */
function isLocalTrack(trackId: string): boolean {
  return !trackId.includes(':');
}

/**
 * Take ownership: called when a client hands its queue to the server for an
 * external device. Pins the device so the monitor keeps polling (and thus
 * advancing) after every client disconnects.
 */
export function startServerPlayback(userId: string, deviceId: string): void {
  if (activeDeviceId && activeDeviceId !== deviceId) {
    deviceMonitor.unpin(activeDeviceId);
  }
  ownerUserId = userId;
  activeDeviceId = deviceId;
  deviceMonitor.pin(deviceId);
  logger.info(`ServerPlayer: driving playback on ${deviceId}`);
}

export function stopServerPlayback(): void {
  if (activeDeviceId) {
    deviceMonitor.unpin(activeDeviceId);
    logger.info(`ServerPlayer: released ${activeDeviceId}`);
  }
  activeDeviceId = null;
}

async function sendTrackToDevice(deviceId: string, track: AdvanceTrack): Promise<void> {
  if (!ownerUserId) throw new Error('no owner user for server playback');
  const lanAddress = getLanAddress();
  if (!lanAddress) throw new Error('no LAN address available');

  const token = signStreamToken(ownerUserId);
  const streamUrl = `http://${lanAddress}:${config.port}/api/library/tracks/${track.id}/stream?t=${encodeURIComponent(token)}`;

  await deviceManager.play(deviceId, streamUrl, {
    title: track.title,
    artist: track.artistName,
    album: track.albumTitle,
    duration: track.duration,
  });
  logger.info(`ServerPlayer: sent "${track.title}" to ${deviceId}`);

  // Mirror what the client's recordPlay does so overnight listening still
  // shows up in history and gets scrobbled.
  try {
    const db = getRawDb();
    const row = db.prepare('SELECT album_id, artist_id FROM tracks WHERE id = ?').get(track.id) as
      | { album_id: string | null; artist_id: string | null }
      | undefined;
    db.prepare(
      'INSERT INTO play_history (track_id, album_id, artist_id, played_at) VALUES (?, ?, ?, unixepoch())',
    ).run(track.id, row?.album_id ?? track.albumId ?? '', row?.artist_id ?? '');
    scrobbler.scrobble({
      title: track.title,
      artist: track.artistName,
      album: track.albumTitle,
      duration: track.duration ? Math.round(track.duration) : undefined,
    });
    scrobbler.nowPlaying({
      title: track.title,
      artist: track.artistName,
      album: track.albumTitle,
      duration: track.duration ? Math.round(track.duration) : undefined,
    });
  } catch (err) {
    logger.debug(`ServerPlayer: history/scrobble record failed: ${err}`);
  }
}

/** Wire the playback hooks. Call once at startup. */
export function initServerPlayer(): void {
  playbackService.setHooks({
    onAdvance: (deviceId, track) => {
      if (!isServerManagedDevice(deviceId) || deviceId !== activeDeviceId) return;
      if (!isLocalTrack(track.id)) {
        // Provider tracks (spotify:/qobuz:) can't be streamed from disk. A
        // connected client will route them via its own provider path; if the
        // tablet is asleep the queue simply pauses here.
        logger.info(`ServerPlayer: skipping non-local track ${track.id} (client must play it)`);
        return;
      }
      sendTrackToDevice(deviceId, track).catch((err) => {
        logger.error(`ServerPlayer: failed to send next track to ${deviceId}: ${err}`);
      });
    },
    onIdle: (deviceId) => {
      if (deviceId === activeDeviceId) stopServerPlayback();
    },
  });
  logger.info('ServerPlayer: hooks registered');
}

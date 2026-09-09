import { playbackService, SERVER_ORIGIN, type TrackInfo } from './playback.js';
import { deviceMonitor } from './device-monitor.js';
import { deviceManager } from '../devices/manager.js';
import {
  PlaybackResolveError,
  resolveForDevice,
  sourceOf,
  type ResolvedStream,
} from './playback-resolver.js';
import { isClientConnected } from '../socketio.js';
import { scrobbler } from './scrobbler.js';
import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';

/**
 * Server-driven playback ("NAS conducts the music"), V04.
 *
 *   device-monitor detects track end → playbackService.advance() picks the
 *   next item → onAdvance → dispatch(): resolve a FRESH url (local token or
 *   signed Qobuz url), hand it to the renderer with a timeout, retry once
 *   (re-resolving, so an expired url is replaced), and record the outcome as
 *   the session's dispatch status. A failed dispatch never leaves the
 *   session in a fictitious "playing": the unplayable policy either skips to
 *   the next item (bounded) or stops with a visible error.
 *
 * Spotify is not a stream url. On a server-managed device it is left to the
 * controlling browser tab when one is connected; otherwise it is skipped.
 */

export type UnplayablePolicy = 'skip' | 'stop';

export interface ServerPlayerDeps {
  play: (deviceId: string, url: string, metadata: ResolvedStream['metadata']) => Promise<void>;
  resolve: (track: TrackInfo) => Promise<ResolvedStream>;
  isClientConnected: (clientId: string | null) => boolean;
  getDeviceState: (deviceId: string) => Promise<{ state: string }>;
  discover: () => Promise<unknown>;
  timeoutMs: number;
  maxAttempts: number;
  maxConsecutiveSkips: number;
  policy: UnplayablePolicy;
  resumeOnRestart: boolean;
}

const envPolicy = process.env.PLAYBACK_UNPLAYABLE_POLICY === 'stop' ? 'stop' : 'skip';

let deps: ServerPlayerDeps = {
  play: (deviceId, url, metadata) => deviceManager.play(deviceId, url, metadata),
  resolve: resolveForDevice,
  isClientConnected,
  getDeviceState: (deviceId) => deviceManager.getPlaybackState(deviceId),
  discover: () => deviceManager.getDevices(true),
  timeoutMs: 20_000,
  maxAttempts: 2,
  maxConsecutiveSkips: 3,
  policy: envPolicy,
  resumeOnRestart: process.env.PLAYBACK_RESUME_ON_RESTART === 'true',
};

/** Tests inject fakes; production keeps the defaults. */
export function configureServerPlayer(overrides: Partial<ServerPlayerDeps>): void {
  deps = { ...deps, ...overrides };
}

let activeDeviceId: string | null = null;
let dispatchSeq = 0;
let consecutiveSkips = 0;

/** External renderers we can stream to (DLNA/Sonos/Volumio). */
export function isServerManagedDevice(deviceId: string | null | undefined): boolean {
  return !!deviceId && deviceId !== 'browser' && !deviceId.startsWith('spotify-connect:');
}

export function getActiveServerDevice(): string | null {
  return activeDeviceId;
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
  activeDeviceId = deviceId;
  consecutiveSkips = 0;
  deviceMonitor.pin(deviceId);
  playbackService.setServerManaged(true, userId);
  logger.info(`ServerPlayer: driving playback on ${deviceId}`);
}

export function stopServerPlayback(): void {
  if (activeDeviceId) {
    deviceMonitor.unpin(activeDeviceId);
    logger.info(`ServerPlayer: released ${activeDeviceId}`);
  }
  activeDeviceId = null;
  dispatchSeq++; // any in-flight dispatch becomes stale
  playbackService.setServerManaged(false);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Hand one queue item to the active device. Resolves the url freshly on
 * every attempt so an expired Qobuz url is replaced instead of retried.
 */
export async function dispatch(
  deviceId: string,
  track: TrackInfo,
  itemId: string | null,
): Promise<void> {
  const seq = ++dispatchSeq;
  const stale = () => seq !== dispatchSeq || activeDeviceId !== deviceId;
  playbackService.setDispatch({
    state: 'loading',
    deviceId,
    itemId,
    trackId: track.id,
    attempts: 0,
  });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    try {
      const resolved = await deps.resolve(track);
      if (stale()) return;
      await withTimeout(
        deps.play(deviceId, resolved.url, resolved.metadata),
        deps.timeoutMs,
        `dispatch to ${deviceId}`,
      );
      if (stale()) return;
      consecutiveSkips = 0;
      playbackService.setDispatch({
        state: 'playing',
        deviceId,
        itemId,
        trackId: track.id,
        attempts: attempt,
      });
      logger.info(`ServerPlayer: sent "${track.title}" (${resolved.source}) to ${deviceId}`);
      recordPlay(track);
      return;
    } catch (err) {
      lastError = err;
      if (stale()) return;
      if (err instanceof PlaybackResolveError && !err.retryable) break;
      logger.warn(
        `ServerPlayer: dispatch attempt ${attempt}/${deps.maxAttempts} for "${track.title}" failed: ${err}`,
      );
    }
  }
  if (stale()) return;
  handleUnplayable(deviceId, track, itemId, lastError);
}

function handleUnplayable(
  deviceId: string,
  track: TrackInfo,
  itemId: string | null,
  err: unknown,
): void {
  const code = err instanceof PlaybackResolveError ? err.code : 'dispatch_failed';
  const message = err instanceof Error ? err.message : String(err);

  // Spotify: not a stream url. A connected controlling tab plays it through
  // the SDK/Connect and reports back; with nobody awake there is nothing to
  // wait for, so the policy applies.
  if (code === 'external_player_only') {
    const controller = playbackService.getSnapshot().controller.clientId;
    if (deps.isClientConnected(controller)) {
      playbackService.setDispatch({
        state: 'client',
        deviceId,
        itemId,
        trackId: track.id,
        code,
        message: `${sourceOf(track.id)} plays through the connected app`,
      });
      return;
    }
  }

  if (deps.policy === 'skip' && consecutiveSkips < deps.maxConsecutiveSkips) {
    consecutiveSkips++;
    logger.warn(`ServerPlayer: skipping "${track.title}" (${code}): ${message}`);
    playbackService.setDispatch({
      state: 'skipped',
      deviceId,
      itemId,
      trackId: track.id,
      code,
      message,
      attempts: deps.maxAttempts,
    });
    // advance() emits track-changed and fires onAdvance for the next item.
    const next = playbackService.advance(SERVER_ORIGIN);
    if (!next) consecutiveSkips = 0;
    return;
  }

  const reason =
    deps.policy === 'skip'
      ? `Stopped after ${consecutiveSkips} unplayable tracks in a row (last: ${message})`
      : message;
  logger.error(`ServerPlayer: stopping playback on ${deviceId}: ${reason}`);
  consecutiveSkips = 0;
  playbackService.markPlaybackFailed(reason, code);
  stopServerPlayback();
}

/** Device monitor gave up on the pinned device: no fictitious "playing". */
export function onDeviceUnreachable(deviceId: string, errors: number): void {
  if (deviceId !== activeDeviceId) return;
  logger.error(`ServerPlayer: ${deviceId} unreachable after ${errors} polls, stopping session`);
  playbackService.markPlaybackFailed(
    `Device ${deviceId} stopped responding; playback stopped`,
    'device_unreachable',
  );
  stopServerPlayback();
}

/**
 * After a restart: the queue is restored from disk, but is the speaker still
 * playing what we think it is? Ask it. Playing → keep driving it (the next
 * track end advances the queue again). Idle → the session is stopped; only
 * PLAYBACK_RESUME_ON_RESTART=true starts the current item again.
 */
export async function reconcileAfterRestart(): Promise<
  'not-managed' | 'device-playing' | 'resumed' | 'stopped'
> {
  const info = playbackService.getPersistedSessionInfo();
  if (!info.serverManaged || !isServerManagedDevice(info.deviceId)) return 'not-managed';

  try {
    await deps.discover();
  } catch (err) {
    logger.warn(`ServerPlayer: device discovery after restart failed: ${err}`);
  }

  let deviceState = 'unknown';
  try {
    deviceState = (await withTimeout(deps.getDeviceState(info.deviceId), 5000, 'device status'))
      .state;
  } catch (err) {
    logger.warn(`ServerPlayer: ${info.deviceId} did not answer after restart: ${err}`);
  }

  const current = playbackService.getCurrentTrack();
  if (deviceState === 'playing' || deviceState === 'buffering') {
    activeDeviceId = info.deviceId;
    deviceMonitor.pin(info.deviceId);
    playbackService.setServerManaged(true, info.ownerUserId);
    playbackService.setDispatch({
      state: 'playing',
      deviceId: info.deviceId,
      itemId: info.queueItemId,
      trackId: info.trackId,
      attempts: 0,
      message: 'Reconciled after restart: device was still playing',
    });
    logger.info(`ServerPlayer: ${info.deviceId} still playing after restart; resuming control`);
    return 'device-playing';
  }

  if (deps.resumeOnRestart && current && info.state === 'playing') {
    activeDeviceId = info.deviceId;
    deviceMonitor.pin(info.deviceId);
    playbackService.setServerManaged(true, info.ownerUserId);
    logger.info(`ServerPlayer: resuming "${current.title}" on ${info.deviceId} after restart`);
    void dispatch(info.deviceId, current, info.queueItemId);
    return 'resumed';
  }

  if (info.state === 'playing') {
    playbackService.markPlaybackFailed(
      `Server restarted while ${info.deviceId} was ${deviceState === 'unknown' ? 'unreachable' : deviceState}; press play to continue`,
      'restart',
    );
  }
  playbackService.setServerManaged(false);
  logger.info(`ServerPlayer: ${info.deviceId} is ${deviceState} after restart; session stopped`);
  return 'stopped';
}

function recordPlay(track: TrackInfo): void {
  // Mirror what the client's recordPlay does so overnight listening still
  // shows up in history and gets scrobbled. Provider tracks have no local
  // album/artist rows; V05 gives history a proper listening-session model.
  try {
    const db = getRawDb();
    const row = db.prepare('SELECT album_id, artist_id FROM tracks WHERE id = ?').get(track.id) as
      | { album_id: string | null; artist_id: string | null }
      | undefined;
    if (row) {
      db.prepare(
        'INSERT INTO play_history (track_id, album_id, artist_id, played_at) VALUES (?, ?, ?, unixepoch())',
      ).run(track.id, row.album_id ?? track.albumId ?? '', row.artist_id ?? '');
    }
    const payload = {
      title: track.title,
      artist: track.artistName,
      album: track.albumTitle,
      duration: track.duration ? Math.round(track.duration) : undefined,
    };
    scrobbler.scrobble(payload);
    scrobbler.nowPlaying(payload);
  } catch (err) {
    logger.debug(`ServerPlayer: history/scrobble record failed: ${err}`);
  }
}

/** Wire the playback hooks. Call once at startup. */
export function initServerPlayer(): void {
  playbackService.setHooks({
    onAdvance: (deviceId, track, itemId) => {
      if (!isServerManagedDevice(deviceId) || deviceId !== activeDeviceId) return;
      dispatch(deviceId, track, itemId).catch((err) => {
        logger.error(`ServerPlayer: dispatch crashed for ${deviceId}: ${err}`);
      });
    },
    onIdle: (deviceId) => {
      if (deviceId === activeDeviceId) {
        playbackService.setDispatch({ state: 'idle', deviceId });
        stopServerPlayback();
      }
    },
  });
  deviceMonitor.setUnreachableHandler(onDeviceUnreachable);
  logger.info('ServerPlayer: hooks registered');
}

/** Test helper: forget in-memory ownership without touching the service. */
export function resetServerPlayerForTests(): void {
  activeDeviceId = null;
  dispatchSeq++;
  consecutiveSkips = 0;
}

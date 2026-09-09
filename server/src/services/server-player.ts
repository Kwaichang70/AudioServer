import { SERVER_ORIGIN, type PlaybackService, type TrackInfo } from './playback.js';
import { zones } from './zones.js';
import { DEFAULT_ZONE_ID } from '../db/index.js';
import { deviceMonitor } from './device-monitor.js';
import { deviceManager } from '../devices/manager.js';
import {
  PlaybackResolveError,
  resolveForDevice,
  sourceOf,
  type ResolvedStream,
} from './playback-resolver.js';
import { isClientConnected } from '../socketio.js';
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

/**
 * Per zone (V10): every room drives its own speaker. A dispatch in the
 * kitchen must not cancel the one in the living room, so the sequence number
 * and the skip counter are per zone too.
 */
interface ZonePlayback {
  activeDeviceId: string | null;
  dispatchSeq: number;
  consecutiveSkips: number;
}

const perZone = new Map<string, ZonePlayback>();

function zoneState(zoneId: string): ZonePlayback {
  const existing = perZone.get(zoneId);
  if (existing) return existing;
  const fresh: ZonePlayback = { activeDeviceId: null, dispatchSeq: 0, consecutiveSkips: 0 };
  perZone.set(zoneId, fresh);
  return fresh;
}

function sessionOf(zoneId: string): PlaybackService {
  return zones.sessionFor(zoneId);
}

/** The zone that drives a device, or null when no zone claimed it. */
function zoneDriving(deviceId: string): string | null {
  for (const [zoneId, state] of perZone) {
    if (state.activeDeviceId === deviceId) return zoneId;
  }
  return null;
}

/** External renderers we can stream to (DLNA/Sonos/Volumio). */
export function isServerManagedDevice(deviceId: string | null | undefined): boolean {
  return !!deviceId && deviceId !== 'browser' && !deviceId.startsWith('spotify-connect:');
}

export function getActiveServerDevice(zoneId: string = DEFAULT_ZONE_ID): string | null {
  return zoneState(zoneId).activeDeviceId;
}

/**
 * Take ownership: called when a client hands its queue to the server for an
 * external device. Pins the device so the monitor keeps polling (and thus
 * advancing) after every client disconnects.
 */
export function startServerPlayback(
  userId: string,
  deviceId: string,
  zoneId: string = DEFAULT_ZONE_ID,
): void {
  const state = zoneState(zoneId);
  if (state.activeDeviceId && state.activeDeviceId !== deviceId) {
    deviceMonitor.unpin(state.activeDeviceId);
  }
  state.activeDeviceId = deviceId;
  state.consecutiveSkips = 0;
  deviceMonitor.pin(deviceId);
  sessionOf(zoneId).setServerManaged(true, userId);
  logger.info(`ServerPlayer[${zoneId}]: driving playback on ${deviceId}`);
}

export function stopServerPlayback(zoneId: string = DEFAULT_ZONE_ID): void {
  const state = zoneState(zoneId);
  if (state.activeDeviceId) {
    deviceMonitor.unpin(state.activeDeviceId);
    logger.info(`ServerPlayer[${zoneId}]: released ${state.activeDeviceId}`);
  }
  state.activeDeviceId = null;
  state.dispatchSeq++; // any in-flight dispatch becomes stale
  sessionOf(zoneId).setServerManaged(false);
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
  zoneId: string = DEFAULT_ZONE_ID,
): Promise<void> {
  const zone = zoneState(zoneId);
  const session = sessionOf(zoneId);
  const seq = ++zone.dispatchSeq;
  const stale = () => seq !== zone.dispatchSeq || zone.activeDeviceId !== deviceId;
  session.setDispatch({
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
      zone.consecutiveSkips = 0;
      session.setDispatch({
        state: 'playing',
        deviceId,
        itemId,
        trackId: track.id,
        attempts: attempt,
      });
      logger.info(
        `ServerPlayer[${zoneId}]: sent "${track.title}" (${resolved.source}) to ${deviceId}`,
      );
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
  handleUnplayable(deviceId, track, itemId, lastError, zoneId);
}

function handleUnplayable(
  deviceId: string,
  track: TrackInfo,
  itemId: string | null,
  err: unknown,
  zoneId: string,
): void {
  const zone = zoneState(zoneId);
  const session = sessionOf(zoneId);
  const code = err instanceof PlaybackResolveError ? err.code : 'dispatch_failed';
  const message = err instanceof Error ? err.message : String(err);

  // Spotify: not a stream url. A connected controlling tab plays it through
  // the SDK/Connect and reports back; with nobody awake there is nothing to
  // wait for, so the policy applies.
  if (code === 'external_player_only') {
    const controller = session.getSnapshot().controller.clientId;
    if (deps.isClientConnected(controller)) {
      session.setDispatch({
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

  if (deps.policy === 'skip' && zone.consecutiveSkips < deps.maxConsecutiveSkips) {
    zone.consecutiveSkips++;
    logger.warn(`ServerPlayer[${zoneId}]: skipping "${track.title}" (${code}): ${message}`);
    session.setDispatch({
      state: 'skipped',
      deviceId,
      itemId,
      trackId: track.id,
      code,
      message,
      attempts: deps.maxAttempts,
    });
    // advance() emits track-changed and fires onAdvance for the next item.
    const next = session.advance(SERVER_ORIGIN);
    if (!next) zone.consecutiveSkips = 0;
    return;
  }

  const reason =
    deps.policy === 'skip'
      ? `Stopped after ${zone.consecutiveSkips} unplayable tracks in a row (last: ${message})`
      : message;
  logger.error(`ServerPlayer[${zoneId}]: stopping playback on ${deviceId}: ${reason}`);
  zone.consecutiveSkips = 0;
  session.markPlaybackFailed(reason, code);
  stopServerPlayback(zoneId);
}

/** Device monitor gave up on the pinned device: no fictitious "playing". */
export function onDeviceUnreachable(deviceId: string, errors: number): void {
  const zoneId = zoneDriving(deviceId);
  if (!zoneId) return;
  logger.error(
    `ServerPlayer[${zoneId}]: ${deviceId} unreachable after ${errors} polls, stopping session`,
  );
  sessionOf(zoneId).markPlaybackFailed(
    `Device ${deviceId} stopped responding; playback stopped`,
    'device_unreachable',
  );
  stopServerPlayback(zoneId);
}

/**
 * After a restart: the queue is restored from disk, but is the speaker still
 * playing what we think it is? Ask it. Playing → keep driving it (the next
 * track end advances the queue again). Idle → the session is stopped; only
 * PLAYBACK_RESUME_ON_RESTART=true starts the current item again.
 */
export async function reconcileAfterRestart(
  zoneId: string = DEFAULT_ZONE_ID,
): Promise<'not-managed' | 'device-playing' | 'resumed' | 'stopped'> {
  const zone = zoneState(zoneId);
  const session = sessionOf(zoneId);
  const info = session.getPersistedSessionInfo();
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

  const current = session.getCurrentTrack();
  if (deviceState === 'playing' || deviceState === 'buffering') {
    zone.activeDeviceId = info.deviceId;
    deviceMonitor.pin(info.deviceId);
    session.setServerManaged(true, info.ownerUserId);
    session.setDispatch({
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
    zone.activeDeviceId = info.deviceId;
    deviceMonitor.pin(info.deviceId);
    session.setServerManaged(true, info.ownerUserId);
    logger.info(`ServerPlayer: resuming "${current.title}" on ${info.deviceId} after restart`);
    void dispatch(info.deviceId, current, info.queueItemId, zoneId);
    return 'resumed';
  }

  if (info.state === 'playing') {
    session.markPlaybackFailed(
      `Server restarted while ${info.deviceId} was ${deviceState === 'unknown' ? 'unreachable' : deviceState}; press play to continue`,
      'restart',
    );
  }
  session.setServerManaged(false);
  logger.info(`ServerPlayer: ${info.deviceId} is ${deviceState} after restart; session stopped`);
  return 'stopped';
}

/** Every zone reconciles its own speaker after a restart (V10). */
export async function reconcileAllZones(): Promise<void> {
  for (const zone of zones.list()) {
    try {
      const outcome = await reconcileAfterRestart(zone.id);
      if (outcome !== 'not-managed') {
        logger.info(`ServerPlayer: zone "${zone.name}" after restart: ${outcome}`);
      }
    } catch (err) {
      logger.warn(`ServerPlayer: reconciling zone "${zone.name}" failed: ${err}`);
    }
  }
}

/** Wire the playback hooks. Call once at startup. */
export function initServerPlayer(): void {
  zones.setHooks({
    onAdvance: (deviceId, track, itemId, zoneId) => {
      if (!isServerManagedDevice(deviceId) || deviceId !== zoneState(zoneId).activeDeviceId) return;
      dispatch(deviceId, track, itemId, zoneId).catch((err) => {
        logger.error(`ServerPlayer[${zoneId}]: dispatch crashed for ${deviceId}: ${err}`);
      });
    },
    onIdle: (deviceId, zoneId) => {
      if (deviceId === zoneState(zoneId).activeDeviceId) {
        sessionOf(zoneId).setDispatch({ state: 'idle', deviceId });
        stopServerPlayback(zoneId);
      }
    },
  });
  deviceMonitor.setUnreachableHandler(onDeviceUnreachable);
  logger.info('ServerPlayer: hooks registered');
}

/** Test helper: forget in-memory ownership without touching the service. */
export function resetServerPlayerForTests(): void {
  for (const state of perZone.values()) {
    state.activeDeviceId = null;
    state.dispatchSeq++;
    state.consecutiveSkips = 0;
  }
}

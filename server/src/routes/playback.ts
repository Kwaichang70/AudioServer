import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { SERVER_ORIGIN, StaleRevisionError, type PlaybackService } from '../services/playback.js';
import { zones, ZoneTakenError } from '../services/zones.js';
import type { PlaybackOrigin, PlaybackSnapshot } from '../types/socket-events.js';
import {
  isServerManagedDevice,
  startServerPlayback,
  stopServerPlayback,
} from '../services/server-player.js';
import { validate } from '../utils/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { getIO } from '../socketio.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  forgetCapabilities,
  getAllOutputCapabilities,
  getOutputCapabilities,
} from '../services/output-capabilities.js';
import { addMeasurement, listTransitions, recordTransition } from '../services/transitions.js';
import { describeAudioPath } from '../services/audio-path.js';
import { getAllCapabilities } from '../services/playback-resolver.js';

export const playbackRouter = Router();

/**
 * Queue command protocol (V03.2)
 *
 * - Every mutating request must carry `X-Client-Id` (a per-tab id the SPA
 *   generates). A request without it comes from an outdated page; it gets
 *   426 so that page shows "reload" instead of silently overwriting the
 *   household's queue with its stale local copy.
 * - `commandId` (optional, any unique string) makes a command idempotent:
 *   a retry after a lost response returns the snapshot of the first run.
 * - `expectedRevision` (optional) on position-sensitive commands: when the
 *   queue changed since the client last looked, the command is refused with
 *   409 and the fresh snapshot, and the client re-applies on that.
 * - Every command answers with the full snapshot ({ revision, queue,
 *   currentItemId, queueIndex, state, shuffle, repeat, controller }).
 * - Clear vs. stop: /queue/clear drops the upcoming items and lets the
 *   current track finish; /stop stops the current track and keeps the queue.
 */

// Queue persistence stores these display fields in NOT NULL columns. Reject an
// incomplete entry at the API boundary instead of accepting it in memory and
// then silently failing to persist the entire queue.
const trackSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    artistName: z.string(),
    albumTitle: z.string(),
    albumId: z.string().optional(),
    duration: z.number().optional(),
    source: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const commandFields = {
  commandId: z.string().min(1).max(128).optional(),
  expectedRevision: z.number().int().min(0).optional(),
};

/** Tell every client which rooms exist now. Best effort: no socket, no news. */
function broadcastZones(): void {
  try {
    getIO().emit('zones:changed', zones.list());
  } catch {
    // Socket.IO is not up in unit tests; the REST answer already carried it.
  }
}

const originHeaderName = 'x-client-id';
const zoneHeaderName = 'x-zone-id';

/**
 * Which room is this request steering (V10)? An explicit `X-Zone-Id` header
 * or `zoneId` in the body wins; otherwise the zone that owns the named
 * device; otherwise the default zone. A client that names a zone that does
 * not exist gets 404 rather than silently steering another room.
 */
function sessionOf(req: Request, res: Response): PlaybackService | null {
  const header = req.headers[zoneHeaderName];
  const fromHeader = typeof header === 'string' && header ? header.slice(0, 128) : null;
  const body = (req.body ?? {}) as { zoneId?: unknown; deviceId?: unknown };
  const fromBody = typeof body.zoneId === 'string' ? body.zoneId : null;
  const query = typeof req.query.zoneId === 'string' ? req.query.zoneId : null;
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId : null;

  const zone = zones.resolve({ zoneId: fromBody ?? fromHeader ?? query, deviceId });
  if (!zone) {
    res.status(404).json({ error: 'NotFound', message: 'That zone does not exist' });
    return null;
  }
  return zones.sessionFor(zone.id);
}

function originOf(req: Request): PlaybackOrigin {
  const header = req.headers[originHeaderName];
  const clientId = typeof header === 'string' && header.length > 0 ? header.slice(0, 128) : null;
  return { clientId, sessionId: req.sessionId ?? null };
}

/** Mutations need a client id; an old SPA without one must reload, not overwrite. */
function requireClientId(req: Request, res: Response, next: NextFunction): void {
  if (originOf(req).clientId) {
    next();
    return;
  }
  res.status(426).json({
    error: 'UpgradeRequired',
    message: 'This AudioServer page is outdated. Reload the app to keep using the queue.',
  });
}

/**
 * Collect the extra fields a client sends with a track (ReplayGain, format,
 * sample rate…) so they survive the round trip through the server queue.
 */
function withMetadata(track: z.infer<typeof trackSchema>) {
  const { id, title, artistName, albumTitle, albumId, duration, source, metadata, ...rest } = track;
  const extra: Record<string, unknown> = { ...(metadata ?? {}) };
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null) extra[key] = value;
  }
  return {
    id,
    title,
    artistName,
    albumTitle,
    albumId,
    duration,
    source,
    metadata: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

function sendSnapshot(res: Response, snapshot: PlaybackSnapshot) {
  res.json({ data: snapshot });
}

function runCommand(
  res: Response,
  session: PlaybackService,
  commandId: string | undefined,
  apply: () => void,
): void {
  try {
    sendSnapshot(res, session.withCommand(commandId, apply));
  } catch (err) {
    if (err instanceof StaleRevisionError) {
      res.status(409).json({
        error: 'StaleRevision',
        message: err.message,
        revision: err.actual,
        data: err.snapshot,
      });
      return;
    }
    throw err;
  }
}

/** After a play-type command, hand server-driven devices to the server player. */
function syncServerPlayer(req: Request, deviceId: string | undefined, zoneId: string) {
  if (!deviceId) return;
  if (isServerManagedDevice(deviceId) && req.userId) {
    startServerPlayback(req.userId, deviceId, zoneId);
  } else {
    stopServerPlayback(zoneId);
  }
}

// ─── Reads ───────────────────────────────────────────────────────

playbackRouter.get('/session', (req, res) => {
  const session = sessionOf(req, res);
  if (session) sendSnapshot(res, session.getSnapshot());
});

// Every room and what it is doing (V10).
playbackRouter.get('/zones', (_req, res) => {
  res.json({
    data: zones.list().map((zone) => {
      const snapshot = zones.sessionFor(zone.id).getSnapshot();
      return {
        ...zone,
        state: snapshot.state.state,
        track: snapshot.state.track,
        queueLength: snapshot.queue.length,
        queueIndex: snapshot.queueIndex,
        volume: snapshot.state.volume,
      };
    }),
  });
});

// What each source can do right now (server dispatch / browser / external
// player), so the client stops guessing from id prefixes (V04.1).
playbackRouter.get('/capabilities', (_req, res) => {
  res.json({ data: getAllCapabilities() });
});

playbackRouter.get('/now-playing', (req, res) => {
  const session = sessionOf(req, res);
  if (session) res.json({ data: session.getState() });
});

playbackRouter.get('/queue', (req, res) => {
  const session = sessionOf(req, res);
  if (session) res.json({ data: session.getQueue(), revision: session.getRevision() });
});

// ─── Zones ───────────────────────────────────────────────────────
//
// A zone is a room: its own queue, transport and volume, bound to exactly
// one output device. Creating and removing rooms is household plumbing, so
// it needs an admin; playing in a room does not.

const zoneSchema = z.object({
  name: z.string().min(1).max(80),
  deviceId: z.string().min(1).max(200),
});

playbackRouter.post(
  '/zones',
  requireAdmin,
  validate({ body: zoneSchema }),
  (req: Request, res: Response) => {
    try {
      res.status(201).json({ data: zones.create(req.body) });
      broadcastZones();
    } catch (err) {
      if (err instanceof ZoneTakenError) {
        res.status(409).json({
          error: 'Conflict',
          message: `${err.deviceId} already plays in "${err.zone.name}"`,
          data: err.zone,
        });
        return;
      }
      throw err;
    }
  },
);

playbackRouter.patch(
  '/zones/:id',
  requireAdmin,
  validate({ body: z.object({ name: z.string().min(1).max(80) }) }),
  (req: Request, res: Response) => {
    const zone = zones.rename(String(req.params.id), req.body.name);
    if (!zone) {
      res.status(404).json({ error: 'NotFound', message: 'That zone does not exist' });
      return;
    }
    res.json({ data: zone });
    broadcastZones();
  },
);

playbackRouter.delete('/zones/:id', requireAdmin, (req: Request, res: Response) => {
  const zone = zones.get(String(req.params.id));
  if (!zone) {
    res.status(404).json({ error: 'NotFound', message: 'That zone does not exist' });
    return;
  }
  if (zone.isDefault) {
    res.status(400).json({
      error: 'BadRequest',
      message: 'The browser zone is where clients without a room land; it cannot be removed',
    });
    return;
  }
  stopServerPlayback(zone.id);
  zones.remove(zone.id);
  res.json({ data: { ok: true } });
  broadcastZones();
});

// ─── Audio path and transitions (V11) ────────────────────────────

// What each output can really do, asked of the device itself. `refresh=1`
// asks again instead of using the cached answer.
playbackRouter.get(
  '/outputs',
  asyncHandler(async (req: Request, res: Response) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json({ data: await getAllOutputCapabilities({ refresh }) });
  }),
);

playbackRouter.get(
  '/outputs/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const caps = await getOutputCapabilities(String(req.params.id), { refresh });
    if (!caps) {
      res.status(404).json({ error: 'NotFound', message: 'That output is not known' });
      return;
    }
    res.json({ data: caps });
  }),
);

/**
 * The audio path of what is playing right now: where the music comes from,
 * what happens to it on the way, and where it comes out. Steps the server
 * cannot see are reported as unknown — a FLAC source is no proof of a
 * bit-perfect output (V11.4).
 */
playbackRouter.get(
  '/audio-path',
  asyncHandler(async (req: Request, res: Response) => {
    const session = sessionOf(req, res);
    if (!session) return;
    res.json({ data: await describeAudioPath(session) });
  }),
);

// The transition log: how each boundary was made and what was measured.
playbackRouter.get('/transitions', (req: Request, res: Response) => {
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
  const limit = Number(req.query.limit) || 50;
  res.json({ data: listTransitions({ deviceId, limit }) });
});

/**
 * A boundary made inside a browser tab (V11.4). The tab can time its own
 * handover far more precisely than polling a renderer, but it still only
 * measures the element swap, not the sound at the speaker — so it is stored
 * as an observation and can never turn into a gapless verdict by itself.
 */
playbackRouter.post(
  '/transitions',
  validate({
    body: z.object({
      fromTrackId: z.string().max(256).nullable().optional(),
      toTrackId: z.string().max(256).nullable().optional(),
      gapMs: z.number().min(0).max(600_000),
      how: z.enum(['preloaded', 'reloaded']),
    }),
  }),
  (req: Request, res: Response) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const id = recordTransition({
      zoneId: session.getZoneId(),
      deviceId: 'browser',
      fromTrackId: req.body.fromTrackId ?? null,
      toTrackId: req.body.toTrackId ?? null,
      handover: 'client',
      observedGapMs: Math.round(req.body.gapMs),
    });
    res.json({ data: { id, note: req.body.how } });
  },
);

// A real measurement of one boundary — the only thing that can support the
// words "gapless verified", so it says how it was measured.
playbackRouter.post(
  '/transitions/:id/measurement',
  requireAdmin,
  validate({
    body: z.object({
      gapMs: z.number().min(0).max(60_000),
      method: z.string().min(1).max(200),
      note: z.string().max(2000).optional(),
    }),
  }),
  (req: Request, res: Response) => {
    const record = addMeasurement(Number(req.params.id), req.body);
    if (!record) {
      res.status(404).json({ error: 'NotFound', message: 'That transition is not in the log' });
      return;
    }
    // The verdict is derived from the measurements, so it has to be re-derived.
    forgetCapabilities(record.deviceId);
    res.json({ data: record });
  },
);

// Everything below mutates the household session.
playbackRouter.use(requireClientId);

// ─── Queue commands ──────────────────────────────────────────────

playbackRouter.post(
  '/queue/add',
  validate({ body: z.object({ track: trackSchema, ...commandFields }) }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    runCommand(res, session, req.body.commandId, () => {
      session.addToQueue(withMetadata(req.body.track), originOf(req));
    });
  },
);

// Replace the queue and make `startIndex` current. For external local
// devices (DLNA/Sonos) this also transfers PLAYBACK OWNERSHIP: the server
// pins the device monitor and pushes each next track itself, so the album
// keeps playing after the tablet goes to sleep.
playbackRouter.post(
  '/queue/set',
  validate({
    body: z.object({
      tracks: z.array(trackSchema),
      startIndex: z.number().int().min(0).optional(),
      deviceId: z.string().optional(),
      shuffle: z.boolean().optional(),
      repeat: z.enum(['off', 'all', 'one']).optional(),
      /** Default true: the start item becomes current and playing. */
      play: z.boolean().optional(),
      ...commandFields,
    }),
  }),
  (req, res) => {
    const origin = originOf(req);
    const session = sessionOf(req, res);
    if (!session) return;
    runCommand(res, session, req.body.commandId, () => {
      session.setQueue(
        req.body.tracks.map(withMetadata),
        req.body.startIndex ?? 0,
        origin,
        req.body.deviceId,
      );
      if (req.body.shuffle !== undefined) session.setShuffle(req.body.shuffle, origin);
      if (req.body.repeat) session.setRepeat(req.body.repeat, origin);
      syncServerPlayer(req, req.body.deviceId, session.getZoneId());
      // Start the chosen item: for server-managed devices this streams it to
      // the speaker (onAdvance hook); for the browser the calling tab plays
      // it and other tabs only mirror (origin = this client).
      const current = session.getCurrentItemId();
      if (req.body.play !== false && current) {
        session.playItem(current, origin, req.body.deviceId);
      }
    });
  },
);

playbackRouter.post(
  '/queue/clear',
  validate({ body: z.object({ ...commandFields }).optional() }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    runCommand(res, session, req.body?.commandId, () => {
      session.clearQueue(originOf(req));
      // Nothing left to advance to: release the device monitor pin once the
      // current track ends (onIdle) — but stop driving now if nothing plays.
      if (session.getState().state !== 'playing') stopServerPlayback(session.getZoneId());
    });
  },
);

playbackRouter.post(
  '/queue/remove',
  validate({
    body: z
      .object({
        itemId: z.string().min(1).optional(),
        index: z.number().int().min(0).optional(),
        ...commandFields,
      })
      .refine((b) => b.itemId !== undefined || b.index !== undefined, {
        message: 'itemId or index required',
      }),
  }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    runCommand(res, session, req.body.commandId, () => {
      session.assertRevision(req.body.expectedRevision);
      if (req.body.itemId) session.removeItem(req.body.itemId, originOf(req));
      else session.removeFromQueue(req.body.index!, originOf(req));
    });
  },
);

playbackRouter.post(
  '/queue/move',
  validate({
    body: z
      .object({
        itemId: z.string().min(1).optional(),
        from: z.number().int().min(0).optional(),
        to: z.number().int().min(0),
        ...commandFields,
      })
      .refine((b) => b.itemId !== undefined || b.from !== undefined, {
        message: 'itemId or from required',
      }),
  }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    runCommand(res, session, req.body.commandId, () => {
      session.assertRevision(req.body.expectedRevision);
      if (req.body.itemId) session.moveItem(req.body.itemId, req.body.to, originOf(req));
      else session.moveInQueue(req.body.from!, req.body.to, originOf(req));
    });
  },
);

// Make one occurrence current (QueuePage tap). The response snapshot tells
// the caller which track to start on its device.
playbackRouter.post(
  '/queue/play',
  validate({
    body: z.object({
      itemId: z.string().min(1),
      deviceId: z.string().optional(),
      ...commandFields,
    }),
  }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const track = session.playItem(req.body.itemId, originOf(req), req.body.deviceId);
    if (!track) {
      res.status(404).json({
        error: 'NotFound',
        message: 'That queue item no longer exists',
        data: session.getSnapshot(),
      });
      return;
    }
    syncServerPlayer(req, req.body.deviceId, session.getZoneId());
    sendSnapshot(res, session.getSnapshot());
  },
);

// ─── Transport ───────────────────────────────────────────────────

playbackRouter.post(
  '/next',
  validate({ body: z.object({ deviceId: z.string().optional(), ...commandFields }).optional() }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    runCommand(res, session, req.body?.commandId, () => {
      session.advance(originOf(req));
    });
  },
);

playbackRouter.post(
  '/previous',
  validate({ body: z.object({ ...commandFields }).optional() }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    runCommand(res, session, req.body?.commandId, () => {
      session.previous(originOf(req));
    });
  },
);

playbackRouter.post(
  '/play',
  validate({
    body: z.object({
      track: trackSchema.optional(),
      deviceId: z.string().nullish(),
      itemId: z.string().optional(),
    }),
  }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    if (req.body.track) {
      session.play(
        withMetadata(req.body.track),
        req.body.deviceId ?? undefined,
        req.body.itemId,
        originOf(req),
      );
    } else {
      session.resume(originOf(req));
    }
    res.json({ data: session.getState() });
  },
);

/**
 * A browser that plays audio itself confirms every few seconds that it is
 * still playing (V05.3). Only the current queue item counts; a stale tab
 * reporting an old item is ignored. No revision or client id needed: it is
 * an observation, not an edit.
 */
playbackRouter.post(
  '/progress',
  validate({
    body: z.object({
      itemId: z.string().max(128).optional().nullable(),
      position: z
        .number()
        .min(0)
        .max(24 * 3600),
    }),
  }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const current = session.getSnapshot().currentItemId ?? null;
    if (req.body.itemId && current && req.body.itemId !== current) {
      res.status(200).json({ data: { accepted: false, reason: 'stale-item' } });
      return;
    }
    session.progress(req.body.position);
    res.json({ data: { accepted: true } });
  },
);

playbackRouter.post('/pause', (req, res) => {
  const session = sessionOf(req, res);
  if (!session) return;
  session.pause(originOf(req));
  res.json({ data: session.getState() });
});

playbackRouter.post('/stop', (req, res) => {
  const session = sessionOf(req, res);
  if (!session) return;
  session.stop(originOf(req));
  res.json({ data: session.getState() });
});

playbackRouter.post(
  '/volume',
  // Accept any number — playbackService clamps to 0-100. Schema rejection would break
  // legacy clients that depend on server-side clamping.
  validate({ body: z.object({ volume: z.number() }) }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    session.setVolume(req.body.volume, originOf(req));
    res.json({ data: session.getState() });
  },
);

playbackRouter.post(
  '/shuffle',
  validate({ body: z.object({ shuffle: z.boolean() }) }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    session.setShuffle(req.body.shuffle, originOf(req));
    res.json({ data: session.getState() });
  },
);

playbackRouter.post(
  '/repeat',
  validate({ body: z.object({ repeat: z.enum(['off', 'all', 'one']) }) }),
  (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    session.setRepeat(req.body.repeat, originOf(req));
    res.json({ data: session.getState() });
  },
);

export { SERVER_ORIGIN };

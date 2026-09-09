import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { playbackService, SERVER_ORIGIN, StaleRevisionError } from '../services/playback.js';
import type { PlaybackOrigin } from '../types/socket-events.js';
import {
  isServerManagedDevice,
  startServerPlayback,
  stopServerPlayback,
} from '../services/server-player.js';
import { validate } from '../utils/validate.js';
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

const originHeaderName = 'x-client-id';

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

function sendSnapshot(res: Response, snapshot = playbackService.getSnapshot()) {
  res.json({ data: snapshot });
}

function runCommand(res: Response, commandId: string | undefined, apply: () => void): void {
  try {
    sendSnapshot(res, playbackService.withCommand(commandId, apply));
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
function syncServerPlayer(req: Request, deviceId: string | undefined) {
  if (!deviceId) return;
  if (isServerManagedDevice(deviceId) && req.userId) {
    startServerPlayback(req.userId, deviceId);
  } else {
    stopServerPlayback();
  }
}

// ─── Reads ───────────────────────────────────────────────────────

playbackRouter.get('/session', (_req, res) => sendSnapshot(res));

// What each source can do right now (server dispatch / browser / external
// player), so the client stops guessing from id prefixes (V04.1).
playbackRouter.get('/capabilities', (_req, res) => {
  res.json({ data: getAllCapabilities() });
});

playbackRouter.get('/now-playing', (_req, res) => {
  res.json({ data: playbackService.getState() });
});

playbackRouter.get('/queue', (_req, res) => {
  res.json({ data: playbackService.getQueue(), revision: playbackService.getRevision() });
});

// Everything below mutates the household session.
playbackRouter.use(requireClientId);

// ─── Queue commands ──────────────────────────────────────────────

playbackRouter.post(
  '/queue/add',
  validate({ body: z.object({ track: trackSchema, ...commandFields }) }),
  (req, res) => {
    runCommand(res, req.body.commandId, () => {
      playbackService.addToQueue(withMetadata(req.body.track), originOf(req));
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
    runCommand(res, req.body.commandId, () => {
      playbackService.setQueue(
        req.body.tracks.map(withMetadata),
        req.body.startIndex ?? 0,
        origin,
        req.body.deviceId,
      );
      if (req.body.shuffle !== undefined) playbackService.setShuffle(req.body.shuffle, origin);
      if (req.body.repeat) playbackService.setRepeat(req.body.repeat, origin);
      syncServerPlayer(req, req.body.deviceId);
      // Start the chosen item: for server-managed devices this streams it to
      // the speaker (onAdvance hook); for the browser the calling tab plays
      // it and other tabs only mirror (origin = this client).
      const current = playbackService.getCurrentItemId();
      if (req.body.play !== false && current) {
        playbackService.playItem(current, origin, req.body.deviceId);
      }
    });
  },
);

playbackRouter.post(
  '/queue/clear',
  validate({ body: z.object({ ...commandFields }).optional() }),
  (req, res) => {
    runCommand(res, req.body?.commandId, () => {
      playbackService.clearQueue(originOf(req));
      // Nothing left to advance to: release the device monitor pin once the
      // current track ends (onIdle) — but stop driving now if nothing plays.
      if (playbackService.getState().state !== 'playing') stopServerPlayback();
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
    runCommand(res, req.body.commandId, () => {
      playbackService.assertRevision(req.body.expectedRevision);
      if (req.body.itemId) playbackService.removeItem(req.body.itemId, originOf(req));
      else playbackService.removeFromQueue(req.body.index!, originOf(req));
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
    runCommand(res, req.body.commandId, () => {
      playbackService.assertRevision(req.body.expectedRevision);
      if (req.body.itemId) playbackService.moveItem(req.body.itemId, req.body.to, originOf(req));
      else playbackService.moveInQueue(req.body.from!, req.body.to, originOf(req));
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
    const track = playbackService.playItem(req.body.itemId, originOf(req), req.body.deviceId);
    if (!track) {
      res.status(404).json({
        error: 'NotFound',
        message: 'That queue item no longer exists',
        data: playbackService.getSnapshot(),
      });
      return;
    }
    syncServerPlayer(req, req.body.deviceId);
    sendSnapshot(res);
  },
);

// ─── Transport ───────────────────────────────────────────────────

playbackRouter.post(
  '/next',
  validate({ body: z.object({ deviceId: z.string().optional(), ...commandFields }).optional() }),
  (req, res) => {
    runCommand(res, req.body?.commandId, () => {
      playbackService.advance(originOf(req));
    });
  },
);

playbackRouter.post(
  '/previous',
  validate({ body: z.object({ ...commandFields }).optional() }),
  (req, res) => {
    runCommand(res, req.body?.commandId, () => {
      playbackService.previous(originOf(req));
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
    if (req.body.track) {
      playbackService.play(
        withMetadata(req.body.track),
        req.body.deviceId ?? undefined,
        req.body.itemId,
        originOf(req),
      );
    } else {
      playbackService.resume(originOf(req));
    }
    res.json({ data: playbackService.getState() });
  },
);

playbackRouter.post('/pause', (req, res) => {
  playbackService.pause(originOf(req));
  res.json({ data: playbackService.getState() });
});

playbackRouter.post('/stop', (req, res) => {
  playbackService.stop(originOf(req));
  res.json({ data: playbackService.getState() });
});

playbackRouter.post(
  '/volume',
  // Accept any number — playbackService clamps to 0-100. Schema rejection would break
  // legacy clients that depend on server-side clamping.
  validate({ body: z.object({ volume: z.number() }) }),
  (req, res) => {
    playbackService.setVolume(req.body.volume, originOf(req));
    res.json({ data: playbackService.getState() });
  },
);

playbackRouter.post(
  '/shuffle',
  validate({ body: z.object({ shuffle: z.boolean() }) }),
  (req, res) => {
    playbackService.setShuffle(req.body.shuffle, originOf(req));
    res.json({ data: playbackService.getState() });
  },
);

playbackRouter.post(
  '/repeat',
  validate({ body: z.object({ repeat: z.enum(['off', 'all', 'one']) }) }),
  (req, res) => {
    playbackService.setRepeat(req.body.repeat, originOf(req));
    res.json({ data: playbackService.getState() });
  },
);

export { SERVER_ORIGIN };

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../utils/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { PlaybackOrigin } from '../types/socket-events.js';
import {
  ControlError,
  listPlaylists,
  listRooms,
  nowPlaying,
  pauseRoom,
  playInRoom,
  resumeRoom,
  setRoomVolume,
  skipInRoom,
  stopInRoom,
} from '../services/remote-control.js';

/**
 * Simple commands for automations and assistants (Homey, Grok, Jarvis), by
 * name: `POST /api/control/play {"room":"Woonkamer","playlist":"Zondag"}`.
 * Works with an API key (Settings → Account → API keys). See docs/control-api.md.
 */
export const controlRouter = Router();

const originOf = (req: Request): PlaybackOrigin => {
  const header = req.headers['x-client-id'];
  return {
    clientId: typeof header === 'string' && header ? header.slice(0, 128) : 'control',
    sessionId: req.sessionId ?? null,
  };
};

const STATUS: Record<ControlError['code'], number> = {
  unknown_room: 404,
  not_found: 404,
  room_required: 400,
  ambiguous: 409,
  not_playable: 409,
  empty: 409,
};

function fail(res: Response, err: unknown): boolean {
  if (!(err instanceof ControlError)) return false;
  res
    .status(STATUS[err.code])
    .json({ error: err.code, message: err.message, options: err.options });
  return true;
}

/** Run a command; a ControlError becomes a clear 4xx with the names that exist. */
const command = (run: (req: Request) => unknown) =>
  asyncHandler(async (req: Request, res: Response) => {
    try {
      res.json({ data: await run(req) });
    } catch (err) {
      if (!fail(res, err)) throw err;
    }
  });

const room = z.string().min(1).max(100).optional();
const roomBody = z.object({ room }).optional();

controlRouter.get('/rooms', (_req, res) => {
  res.json({ data: listRooms() });
});

controlRouter.get('/playlists', (req, res) => {
  res.json({ data: listPlaylists(req.userId!) });
});

controlRouter.get(
  '/now-playing',
  command((req) => nowPlaying(typeof req.query.room === 'string' ? req.query.room : undefined)),
);

controlRouter.post(
  '/play',
  validate({
    body: z
      .object({
        room,
        playlist: z.string().min(1).max(200).optional(),
        album: z.string().min(1).max(200).optional(),
        artist: z.string().min(1).max(200).optional(),
        shuffle: z.boolean().optional(),
      })
      .refine((b) => b.playlist || b.album || b.artist, {
        message: 'Say what to play: playlist, album or artist',
      }),
  }),
  command((req) => playInRoom(req.userId!, req.body, originOf(req))),
);

controlRouter.post(
  '/pause',
  validate({ body: roomBody }),
  command((req) => pauseRoom(req.body?.room, originOf(req))),
);

controlRouter.post(
  '/resume',
  validate({ body: roomBody }),
  command((req) => resumeRoom(req.body?.room, req.userId!, originOf(req))),
);

controlRouter.post(
  '/stop',
  validate({ body: roomBody }),
  command((req) => stopInRoom(req.body?.room)),
);

controlRouter.post(
  '/next',
  validate({ body: roomBody }),
  command((req) => skipInRoom(req.body?.room, 'next', originOf(req))),
);

controlRouter.post(
  '/previous',
  validate({ body: roomBody }),
  command((req) => skipInRoom(req.body?.room, 'previous', originOf(req))),
);

controlRouter.post(
  '/volume',
  validate({ body: z.object({ room, volume: z.number().min(0).max(100) }) }),
  command((req) => setRoomVolume(req.body.room, req.body.volume, originOf(req))),
);

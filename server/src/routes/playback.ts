import { Router } from 'express';
import { z } from 'zod';
import { playbackService } from '../services/playback.js';
import {
  isServerManagedDevice,
  startServerPlayback,
  stopServerPlayback,
} from '../services/server-player.js';
import { validate } from '../utils/validate.js';

export const playbackRouter = Router();

// Queue persistence stores these display fields in NOT NULL columns. Reject an
// incomplete entry at the API boundary instead of accepting it in memory and
// then silently failing to persist the entire queue.
const trackSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    artistName: z.string(),
    albumTitle: z.string(),
  })
  .passthrough();

playbackRouter.get('/now-playing', (_req, res) => {
  res.json({ data: playbackService.getState() });
});

playbackRouter.get('/queue', (_req, res) => {
  res.json({ data: playbackService.getQueue() });
});

playbackRouter.post(
  '/queue/add',
  validate({ body: z.object({ track: trackSchema }) }),
  (req, res) => {
    playbackService.addToQueue(req.body.track);
    res.json({ data: playbackService.getQueue() });
  },
);

// Hand the client's queue to the server. For external local devices
// (DLNA/Sonos) this also transfers PLAYBACK OWNERSHIP: the server pins the
// device monitor and pushes each next track itself, so the album keeps playing
// after the tablet goes to sleep. The client mirrors progress via the
// playback:track-changed socket event.
playbackRouter.post(
  '/queue/set',
  validate({
    body: z.object({
      tracks: z.array(trackSchema),
      startIndex: z.number().int().min(0).optional(),
      deviceId: z.string().optional(),
      shuffle: z.boolean().optional(),
      repeat: z.enum(['off', 'all', 'one']).optional(),
    }),
  }),
  (req, res) => {
    playbackService.setQueue(req.body.tracks, req.body.startIndex ?? 0);
    if (req.body.shuffle !== undefined) playbackService.setShuffle(req.body.shuffle);
    if (req.body.repeat) playbackService.setRepeat(req.body.repeat);

    const deviceId = req.body.deviceId;
    if (deviceId && isServerManagedDevice(deviceId) && req.userId) {
      startServerPlayback(req.userId, deviceId);
    } else if (deviceId) {
      stopServerPlayback();
    }

    res.json({
      data: { queue: playbackService.getQueue(), index: playbackService.getQueueIndex() },
    });
  },
);

playbackRouter.post('/queue/clear', (_req, res) => {
  playbackService.clearQueue();
  stopServerPlayback();
  res.json({ data: playbackService.getQueue() });
});

playbackRouter.post(
  '/queue/remove',
  validate({ body: z.object({ index: z.number().int().min(0) }) }),
  (req, res) => {
    playbackService.removeFromQueue(req.body.index);
    res.json({ data: playbackService.getQueue() });
  },
);

playbackRouter.post(
  '/queue/move',
  validate({ body: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }) }),
  (req, res) => {
    playbackService.moveInQueue(req.body.from, req.body.to);
    res.json({ data: playbackService.getQueue() });
  },
);

playbackRouter.post(
  '/play',
  validate({ body: z.object({ track: trackSchema.optional(), deviceId: z.string().nullish() }) }),
  (req, res) => {
    if (req.body.track) {
      playbackService.play(req.body.track, req.body.deviceId);
    } else {
      playbackService.resume();
    }
    res.json({ data: playbackService.getState() });
  },
);

playbackRouter.post('/pause', (_req, res) => {
  playbackService.pause();
  res.json({ data: playbackService.getState() });
});

playbackRouter.post('/stop', (_req, res) => {
  playbackService.stop();
  res.json({ data: playbackService.getState() });
});

playbackRouter.post(
  '/volume',
  // Accept any number — playbackService clamps to 0-100. Schema rejection would break
  // legacy clients that depend on server-side clamping.
  validate({ body: z.object({ volume: z.number() }) }),
  (req, res) => {
    playbackService.setVolume(req.body.volume);
    res.json({ data: playbackService.getState() });
  },
);

playbackRouter.post(
  '/shuffle',
  validate({ body: z.object({ shuffle: z.boolean() }) }),
  (req, res) => {
    playbackService.setShuffle(req.body.shuffle);
    res.json({ data: playbackService.getState() });
  },
);

playbackRouter.post(
  '/repeat',
  validate({ body: z.object({ repeat: z.enum(['off', 'all', 'one']) }) }),
  (req, res) => {
    playbackService.setRepeat(req.body.repeat);
    res.json({ data: playbackService.getState() });
  },
);

import { Router } from 'express';
import { z } from 'zod';
import { playbackService } from '../services/playback.js';
import { validate } from '../utils/validate.js';

export const playbackRouter = Router();

// Only `id` is required and load-bearing — playbackService stores the rest of
// the track verbatim as display metadata and never type-checks it. The client
// forwards objects straight from the DB/providers, where any "optional" field
// can be null or an unexpected type (e.g. bitDepth/sampleRate on MP3, a numeric
// id from a provider). A strict schema here bought no safety but rejected real
// tracks with a 400 — so accept any shape with a string id and pass it through.
const trackSchema = z.object({ id: z.string() }).passthrough();

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

playbackRouter.post('/queue/clear', (_req, res) => {
  playbackService.clearQueue();
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

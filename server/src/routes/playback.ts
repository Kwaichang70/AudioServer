import { Router } from 'express';
import { z } from 'zod';
import { playbackService } from '../services/playback.js';
import { validate } from '../utils/validate.js';

export const playbackRouter = Router();

// Optional fields use .nullish() (null | undefined), not .optional(): the client
// forwards track objects straight from the DB/provider, where columns like
// bitDepth/sampleRate (MP3) or albumId can be null. .optional() rejects null,
// which made playing such a track 400 — and on an external device that meant
// the track silently failed to register on the server.
const trackSchema = z
  .object({
    id: z.string(),
    title: z.string().nullish(),
    artistName: z.string().nullish(),
    albumTitle: z.string().nullish(),
    albumId: z.string().nullish(),
    duration: z.number().nullish(),
    format: z.string().nullish(),
    sampleRate: z.number().nullish(),
    bitDepth: z.number().nullish(),
    source: z.string().nullish(),
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
  validate({ body: z.object({ track: trackSchema.optional(), deviceId: z.string().optional() }) }),
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

import { Router } from 'express';
import { playbackService } from '../services/playback.js';

export const playbackRouter = Router();

playbackRouter.get('/now-playing', (_req, res) => {
  res.json({ data: playbackService.getState() });
});

playbackRouter.get('/queue', (_req, res) => {
  res.json({ data: playbackService.getQueue() });
});

playbackRouter.post('/queue/add', (req, res) => {
  const { track } = req.body;
  if (!track) return res.status(400).json({ error: 'Track is required' });
  playbackService.addToQueue(track);
  res.json({ data: playbackService.getQueue() });
});

playbackRouter.post('/queue/clear', (_req, res) => {
  playbackService.clearQueue();
  res.json({ data: playbackService.getQueue() });
});

playbackRouter.post('/queue/remove', (req, res) => {
  const { index } = req.body;
  if (typeof index !== 'number') return res.status(400).json({ error: 'index required' });
  playbackService.removeFromQueue(index);
  res.json({ data: playbackService.getQueue() });
});

playbackRouter.post('/queue/move', (req, res) => {
  const { from, to } = req.body;
  if (typeof from !== 'number' || typeof to !== 'number') {
    return res.status(400).json({ error: 'from and to required' });
  }
  playbackService.moveInQueue(from, to);
  res.json({ data: playbackService.getQueue() });
});

playbackRouter.post('/play', (req, res) => {
  const { track, deviceId } = req.body;
  if (track) {
    playbackService.play(track, deviceId);
  } else {
    playbackService.resume();
  }
  res.json({ data: playbackService.getState() });
});

playbackRouter.post('/pause', (_req, res) => {
  playbackService.pause();
  res.json({ data: playbackService.getState() });
});

playbackRouter.post('/stop', (_req, res) => {
  playbackService.stop();
  res.json({ data: playbackService.getState() });
});

playbackRouter.post('/volume', (req, res) => {
  const { volume } = req.body;
  if (typeof volume === 'number') {
    playbackService.setVolume(volume);
  }
  res.json({ data: playbackService.getState() });
});

playbackRouter.post('/shuffle', (req, res) => {
  const { shuffle } = req.body;
  playbackService.setShuffle(!!shuffle);
  res.json({ data: playbackService.getState() });
});

playbackRouter.post('/repeat', (req, res) => {
  const { repeat } = req.body;
  if (['off', 'all', 'one'].includes(repeat)) {
    playbackService.setRepeat(repeat);
  }
  res.json({ data: playbackService.getState() });
});

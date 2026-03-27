import { Router } from 'express';
import type { NowPlaying, QueueItem } from '@audioserver/shared';

export const playbackRouter = Router();

// In-memory playback state (later: per-device, persistent)
let nowPlaying: NowPlaying = {
  track: null,
  state: 'stopped',
  position: 0,
  duration: 0,
  volume: 50,
  deviceId: 'browser',
};

const queue: QueueItem[] = [];

playbackRouter.get('/now-playing', (_req, res) => {
  res.json({ data: nowPlaying });
});

playbackRouter.get('/queue', (_req, res) => {
  res.json({ data: queue });
});

playbackRouter.post('/queue/add', (req, res) => {
  const { track } = req.body;
  if (!track) return res.status(400).json({ error: 'Track is required' });
  queue.push({ track, addedAt: Date.now() });
  res.json({ data: queue });
});

playbackRouter.post('/queue/clear', (_req, res) => {
  queue.length = 0;
  res.json({ data: queue });
});

playbackRouter.post('/play', (req, res) => {
  const { track, deviceId } = req.body;
  if (track) {
    nowPlaying = {
      track,
      state: 'playing',
      position: 0,
      duration: track.duration || 0,
      volume: nowPlaying.volume,
      deviceId: deviceId || nowPlaying.deviceId,
    };
  } else {
    nowPlaying.state = 'playing';
  }
  res.json({ data: nowPlaying });
});

playbackRouter.post('/pause', (_req, res) => {
  nowPlaying.state = 'paused';
  res.json({ data: nowPlaying });
});

playbackRouter.post('/stop', (_req, res) => {
  nowPlaying.state = 'stopped';
  nowPlaying.position = 0;
  res.json({ data: nowPlaying });
});

playbackRouter.post('/volume', (req, res) => {
  const { volume } = req.body;
  if (typeof volume === 'number' && volume >= 0 && volume <= 100) {
    nowPlaying.volume = volume;
  }
  res.json({ data: nowPlaying });
});

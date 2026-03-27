import { Router } from 'express';
import { deviceManager } from '../devices/manager.js';

export const devicesRouter = Router();

devicesRouter.get('/', async (_req, res) => {
  const devices = await deviceManager.getDevices();
  res.json({ data: devices });
});

devicesRouter.get('/discover', async (_req, res) => {
  const devices = await deviceManager.getDevices(true);
  res.json({ data: devices });
});

devicesRouter.get('/:id/status', async (req, res) => {
  try {
    const status = await deviceManager.getPlaybackState(req.params.id);
    res.json({ data: status });
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});

devicesRouter.post('/:id/play', async (req, res) => {
  try {
    const { streamUrl, metadata } = req.body;
    await deviceManager.play(req.params.id, streamUrl, metadata);
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

devicesRouter.post('/:id/pause', async (req, res) => {
  try {
    await deviceManager.pause(req.params.id);
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

devicesRouter.post('/:id/resume', async (req, res) => {
  try {
    await deviceManager.resume(req.params.id);
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

devicesRouter.post('/:id/stop', async (req, res) => {
  try {
    await deviceManager.stop(req.params.id);
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

devicesRouter.post('/:id/volume', async (req, res) => {
  try {
    const { volume } = req.body;
    await deviceManager.setVolume(req.params.id, volume);
    res.json({ data: { ok: true } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

import { Router } from 'express';
import { deviceManager } from '../devices/manager.js';
import { getDb } from '../db/index.js';
import { tracks } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';

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
    let { streamUrl, metadata, trackId } = req.body;

    // If trackId provided, enrich metadata with format info from DB
    if (trackId && !metadata?.mimeType) {
      const db = getDb();
      const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get();
      if (track) {
        const mimeTypes: Record<string, string> = {
          flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4',
          aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/opus',
        };
        // Build cover URL from the stream URL base
        const baseUrl = streamUrl.replace(/\/api\/library\/tracks\/.*/, '');
        const coverUrl = `${baseUrl}/api/library/albums/${track.albumId}/cover`;

        metadata = {
          ...metadata,
          title: metadata?.title || track.title,
          artist: metadata?.artist || track.artistName,
          album: metadata?.album || track.albumTitle,
          mimeType: mimeTypes[track.format || ''] || 'audio/mpeg',
          coverUrl,
        };
      }
    }

    await deviceManager.play(req.params.id, streamUrl, metadata);
    res.json({ data: { ok: true } });
  } catch (err) {
    logger.error(`Device play error: ${err}`);
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

import { Router } from 'express';
import { deviceManager } from '../devices/manager.js';
import { getDb } from '../db/index.js';
import { tracks } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';

export const devicesRouter = Router();

export function buildDeviceCoverUrl(streamUrl: string, albumId: string): string {
  const stream = new URL(streamUrl);
  const cover = new URL(`/api/library/albums/${encodeURIComponent(albumId)}/cover`, stream.origin);
  const streamToken = stream.searchParams.get('t');
  if (streamToken) cover.searchParams.set('t', streamToken);
  return cover.toString();
}

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
    const { streamUrl, trackId } = req.body;
    let { metadata } = req.body;

    // If trackId provided, enrich metadata with format info from DB
    if (trackId && !metadata?.mimeType) {
      const db = getDb();
      const track = db.select().from(tracks).where(eq(tracks.id, trackId)).get();
      if (track) {
        const mimeTypes: Record<string, string> = {
          flac: 'audio/flac',
          mp3: 'audio/mpeg',
          m4a: 'audio/mp4',
          aac: 'audio/aac',
          ogg: 'audio/ogg',
          wav: 'audio/wav',
          opus: 'audio/opus',
        };
        // Reuse the stream token: renderers cannot attach our Bearer header when
        // they fetch album art, and the cover route is protected after first-run.
        const coverUrl = buildDeviceCoverUrl(streamUrl, track.albumId);

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

devicesRouter.post('/:id/set-next', async (req, res) => {
  try {
    const { streamUrl, metadata } = req.body;
    await deviceManager.setNextUri(req.params.id, streamUrl, metadata);
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

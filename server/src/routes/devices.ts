import { Router } from 'express';
import { deviceManager } from '../devices/manager.js';
import { getDb } from '../db/index.js';
import { tracks } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { validate } from '../utils/validate.js';
import { z } from 'zod';
import type { Response } from 'express';

export const devicesRouter = Router();

/**
 * What a tab may hand to a speaker (S02). The URL is a radio stream, a
 * Qobuz address or this server's own stream, so the host cannot be pinned
 * down here; what can be is that it is a plain http(s) address of sane
 * length and that the metadata is text. Anything else used to reach the
 * speaker as it came, and a value that was not a URL answered 500 with the
 * raw error.
 */
const httpUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');

const text = z.string().max(500);
const metadataSchema = z
  .object({
    title: text.nullish(),
    artist: text.nullish(),
    album: text.nullish(),
    coverUrl: httpUrl.nullish(),
    duration: z.number().finite().nonnegative().nullish(),
    mimeType: z
      .string()
      .regex(/^audio\/[\w.+-]{1,40}$/)
      .optional(),
  })
  .optional();

const playSchema = z.object({
  streamUrl: httpUrl,
  trackId: z.string().min(1).max(300).optional(),
  metadata: metadataSchema,
});
/** An empty URL clears the next track a speaker was handed. */
const setNextSchema = z.object({
  streamUrl: z.union([z.literal(''), httpUrl]),
  metadata: metadataSchema,
});
const volumeSchema = z.object({ volume: z.number().finite().min(0).max(100) });

/** A speaker refused or did not answer: say so without the raw error text (S12). */
function deviceFailed(res: Response, what: string, err: unknown): void {
  logger.warn(`Device ${what} failed: ${err}`);
  res.status(502).json({
    error: 'DeviceError',
    message: `The speaker did not ${what}. It may be off or not on the network.`,
  });
}

export function buildDeviceCoverUrl(streamUrl: string, albumId: string): string {
  const stream = new URL(streamUrl);
  const cover = new URL(`/api/library/albums/${encodeURIComponent(albumId)}/cover`, stream.origin);
  const streamToken = stream.searchParams.get('t');
  if (streamToken) cover.searchParams.set('t', streamToken);
  return cover.toString();
}

devicesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const devices = await deviceManager.getDevices();
    res.json({ data: devices });
  }),
);

devicesRouter.get(
  '/discover',
  asyncHandler(async (_req, res) => {
    const devices = await deviceManager.getDevices(true);
    res.json({ data: devices });
  }),
);

devicesRouter.get(
  '/:id/status',
  asyncHandler(async (req, res) => {
    try {
      const status = await deviceManager.getPlaybackState(req.params.id);
      res.json({ data: status });
    } catch (err) {
      logger.debug(`Device status for ${req.params.id} failed: ${err}`);
      res.status(404).json({ error: 'NotFound', message: 'That speaker does not answer.' });
    }
  }),
);

devicesRouter.post(
  '/:id/play',
  validate({ body: playSchema }),
  asyncHandler(async (req, res) => {
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
      deviceFailed(res, 'start the track', err);
    }
  }),
);

devicesRouter.post(
  '/:id/set-next',
  validate({ body: setNextSchema }),
  asyncHandler(async (req, res) => {
    try {
      const { streamUrl, metadata } = req.body;
      await deviceManager.setNextUri(req.params.id, streamUrl, metadata);
      res.json({ data: { ok: true } });
    } catch (err) {
      deviceFailed(res, 'take the next track', err);
    }
  }),
);

devicesRouter.post(
  '/:id/pause',
  asyncHandler(async (req, res) => {
    try {
      await deviceManager.pause(req.params.id);
      res.json({ data: { ok: true } });
    } catch (err) {
      deviceFailed(res, 'pause', err);
    }
  }),
);

devicesRouter.post(
  '/:id/resume',
  asyncHandler(async (req, res) => {
    try {
      await deviceManager.resume(req.params.id);
      res.json({ data: { ok: true } });
    } catch (err) {
      deviceFailed(res, 'resume', err);
    }
  }),
);

devicesRouter.post(
  '/:id/stop',
  asyncHandler(async (req, res) => {
    try {
      await deviceManager.stop(req.params.id);
      res.json({ data: { ok: true } });
    } catch (err) {
      deviceFailed(res, 'stop', err);
    }
  }),
);

devicesRouter.post(
  '/:id/volume',
  validate({ body: volumeSchema }),
  asyncHandler(async (req, res) => {
    try {
      const { volume } = req.body;
      await deviceManager.setVolume(req.params.id, volume);
      res.json({ data: { ok: true } });
    } catch (err) {
      deviceFailed(res, 'change its volume', err);
    }
  }),
);

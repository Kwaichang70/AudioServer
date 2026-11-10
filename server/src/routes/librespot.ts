import { Router } from 'express';
import {
  startLibrespot,
  stopLibrespot,
  getLibrespotState,
  handleStreamRequest,
  checkLibrespotAvailable,
  checkFfmpegAvailable,
} from '../services/librespot.js';
import { deviceManager } from '../devices/manager.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { z } from 'zod';
import { requireAdmin, signSystemStreamToken } from '../middleware/auth.js';
import { getLanAddress } from '../utils/network.js';
import { validate } from '../utils/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const librespotStartSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
});

export const librespotRouter = Router();

// Check if librespot + ffmpeg are installed
librespotRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const [hasLibrespot, hasFfmpeg] = await Promise.all([
      checkLibrespotAvailable(),
      checkFfmpegAvailable(),
    ]);
    res.json({
      data: {
        ...getLibrespotState(),
        librespotInstalled: hasLibrespot,
        ffmpegInstalled: hasFfmpeg,
      },
    });
  }),
);

// Start librespot with Spotify credentials
librespotRouter.post(
  '/start',
  requireAdmin,
  validate({ body: librespotStartSchema }),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const ok = await startLibrespot(username, password);
    if (ok) {
      res.json({ data: { started: true } });
    } else {
      res
        .status(500)
        .json({ error: 'Failed to start librespot. Check if librespot and ffmpeg are installed.' });
    }
  }),
);

// Stop librespot
librespotRouter.post('/stop', requireAdmin, (_req, res) => {
  stopLibrespot();
  res.json({ data: { stopped: true } });
});

// Live MP3 audio stream endpoint — DLNA/Volumio devices connect here
librespotRouter.get('/stream', (req, res) => {
  handleStreamRequest(req, res);
});

/**
 * Play a Spotify track via librespot to a specific output device.
 *
 * Flow:
 * 1. Use Spotify Web API to start playback on the "AudioServer" Connect device
 * 2. Librespot receives the audio and pipes it through ffmpeg
 * 3. The stream endpoint serves it as MP3
 * 4. We send the stream URL to the target DLNA/Volumio device
 */
const playToDeviceSchema = z.object({
  trackUri: z.string().min(1).max(300),
  deviceId: z.string().min(1).max(200),
});

librespotRouter.post(
  '/play-to-device',
  validate({ body: playToDeviceSchema }),
  asyncHandler(async (req, res) => {
    const { deviceId } = req.body as z.infer<typeof playToDeviceSchema>;

    const state = getLibrespotState();
    if (!state.isRunning) {
      res
        .status(400)
        .json({ error: 'Librespot is not running. Start it first via /api/librespot/start' });
      return;
    }

    try {
      // Step 1: Tell Spotify to play on the "AudioServer" librespot device
      // (This is done via the Spotify Connect API from the frontend)

      // Step 2: Build the stream URL that the target device will connect to.
      // Use the configured port — 3001 was hardcoded, so a custom PORT broke
      // DLNA playback with a connection-refused on the device.
      // The server's own LAN address, as for every other stream a speaker
      // fetches: the Host header is the public name behind the reverse proxy
      // (and whatever a caller puts in it). The speaker cannot log in, so the
      // URL carries a system stream token; without it the speaker got 401 and
      // this never played (S07).
      const lanAddress = getLanAddress();
      if (!lanAddress) {
        res.status(503).json({
          error: 'NoLanAddress',
          message: 'The server has no LAN address a speaker could reach.',
        });
        return;
      }
      const token = encodeURIComponent(signSystemStreamToken());
      const streamUrl = `http://${lanAddress}:${config.port}/api/librespot/stream?t=${token}`;

      // Step 3: Send the stream URL to the target DLNA/Volumio device
      await deviceManager.play(deviceId, streamUrl, {
        title: 'Spotify Stream',
        artist: 'via AudioServer',
        album: 'Spotify',
      });

      logger.info(`Librespot: Routing Spotify stream to device ${deviceId}`);
      res.json({ data: { ok: true } });
    } catch (err) {
      logger.error(`Librespot play-to-device failed: ${err}`);
      res.status(502).json({
        error: 'DeviceError',
        message: 'The speaker did not accept the Spotify stream.',
      });
    }
  }),
);

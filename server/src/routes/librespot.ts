import { Router } from 'express';
import {
  startLibrespot, stopLibrespot, getLibrespotState,
  handleStreamRequest, checkLibrespotAvailable, checkFfmpegAvailable,
} from '../services/librespot.js';
import { deviceManager } from '../devices/manager.js';
import { logger } from '../logger.js';

export const librespotRouter = Router();

// Check if librespot + ffmpeg are installed
librespotRouter.get('/status', async (_req, res) => {
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
});

// Start librespot with Spotify credentials
librespotRouter.post('/start', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Spotify username and password required' });
    return;
  }
  const ok = await startLibrespot(username, password);
  if (ok) {
    res.json({ data: { started: true } });
  } else {
    res.status(500).json({ error: 'Failed to start librespot. Check if librespot and ffmpeg are installed.' });
  }
});

// Stop librespot
librespotRouter.post('/stop', (_req, res) => {
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
librespotRouter.post('/play-to-device', async (req, res) => {
  const { trackUri, deviceId } = req.body;
  if (!trackUri || !deviceId) {
    res.status(400).json({ error: 'trackUri and deviceId required' });
    return;
  }

  const state = getLibrespotState();
  if (!state.isRunning) {
    res.status(400).json({ error: 'Librespot is not running. Start it first via /api/librespot/start' });
    return;
  }

  try {
    // Step 1: Tell Spotify to play on the "AudioServer" librespot device
    // (This is done via the Spotify Connect API from the frontend)

    // Step 2: Build the stream URL that the target device will connect to
    const lanAddress = req.headers.host?.split(':')[0] || '127.0.0.1';
    const streamUrl = `http://${lanAddress}:3001/api/librespot/stream`;

    // Step 3: Send the stream URL to the target DLNA/Volumio device
    await deviceManager.play(deviceId, streamUrl, {
      title: 'Spotify Stream',
      artist: 'via AudioServer',
      album: 'Spotify',
    });

    logger.info(`Librespot: Routing Spotify stream to device ${deviceId}`);
    res.json({ data: { ok: true, streamUrl } });
  } catch (err) {
    logger.error(`Librespot play-to-device failed: ${err}`);
    res.status(500).json({ error: String(err) });
  }
});

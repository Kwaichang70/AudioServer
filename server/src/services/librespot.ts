import { spawn, type ChildProcess } from 'child_process';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../logger.js';
import { config } from '../config.js';

/**
 * Librespot integration — runs a Spotify Connect receiver as a subprocess.
 *
 * Flow:
 * 1. Start librespot with --backend pipe (outputs raw PCM to stdout)
 * 2. Pipe stdout through ffmpeg to convert to MP3
 * 3. Serve the MP3 stream via an HTTP endpoint
 * 4. Send that endpoint URL to DLNA/Volumio/Sonos
 *
 * Install:
 *   cargo install librespot   (requires Rust toolchain)
 *   or download from https://github.com/librespot-org/librespot/releases
 *
 * The librespot process stays running and acts as a Spotify Connect device
 * named "AudioServer". When Spotify sends audio to it, we pipe it to
 * whatever output device is selected.
 */

interface LibrespotState {
  isRunning: boolean;
  isStreaming: boolean;
  currentTrackId: string | null;
  process: ChildProcess | null;
  ffmpegProcess: ChildProcess | null;
  streamPath: string | null;
}

const state: LibrespotState = {
  isRunning: false,
  isStreaming: false,
  currentTrackId: null,
  process: null,
  ffmpegProcess: null,
  streamPath: null,
};

// Clients waiting for stream data
const streamClients: Set<import('http').ServerResponse> = new Set();

let pcmBuffer: Buffer[] = [];

export function isLibrespotAvailable(): boolean {
  try {
    const result = spawn('librespot', ['--version'], { stdio: 'pipe' });
    return new Promise((resolve) => {
      result.on('error', () => resolve(false));
      result.on('close', (code) => resolve(code === 0));
      setTimeout(() => { result.kill(); resolve(false); }, 2000);
    }) as any;
  } catch {
    return false;
  }
}

export async function checkLibrespotAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn('librespot', ['--version'], { stdio: 'pipe' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
      setTimeout(() => { proc.kill(); resolve(false); }, 3000);
    } catch {
      resolve(false);
    }
  });
}

export async function checkFfmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn('ffmpeg', ['-version'], { stdio: 'pipe' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
      setTimeout(() => { proc.kill(); resolve(false); }, 3000);
    } catch {
      resolve(false);
    }
  });
}

/**
 * Start librespot as a background Spotify Connect receiver.
 * It authenticates with the user's Spotify credentials and
 * outputs raw PCM audio to stdout when a track is played.
 */
export async function startLibrespot(username: string, password: string): Promise<boolean> {
  if (state.isRunning) {
    logger.info('Librespot: Already running');
    return true;
  }

  const hasLibrespot = await checkLibrespotAvailable();
  const hasFfmpeg = await checkFfmpegAvailable();

  if (!hasLibrespot) {
    logger.warn('Librespot: not installed. Install with: cargo install librespot');
    return false;
  }
  if (!hasFfmpeg) {
    logger.warn('Librespot: ffmpeg not installed. Install ffmpeg to enable audio transcoding.');
    return false;
  }

  try {
    // Start librespot with pipe backend (raw PCM output)
    const proc = spawn('librespot', [
      '--name', 'AudioServer',
      '--backend', 'pipe',
      '--bitrate', '320',
      '--username', username,
      '--password', password,
      '--initial-volume', '80',
      '--format', 'S16', // 16-bit signed PCM
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    state.process = proc;
    state.isRunning = true;

    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) logger.debug(`Librespot: ${msg}`);

      // Detect track changes from librespot stderr
      if (msg.includes('Loading <') || msg.includes('Track "')) {
        state.isStreaming = true;
        startFfmpegTranscode(proc);
      }
      if (msg.includes('Player::Stopped') || msg.includes('Stopped')) {
        state.isStreaming = false;
        stopFfmpegTranscode();
      }
    });

    proc.on('close', (code) => {
      logger.info(`Librespot: process exited with code ${code}`);
      state.isRunning = false;
      state.isStreaming = false;
      state.process = null;
      stopFfmpegTranscode();
    });

    proc.on('error', (err) => {
      logger.error(`Librespot: ${err.message}`);
      state.isRunning = false;
    });

    logger.info('Librespot: Started as Spotify Connect receiver "AudioServer"');
    return true;
  } catch (err) {
    logger.error(`Librespot: Failed to start: ${err}`);
    return false;
  }
}

function startFfmpegTranscode(librespotProc: ChildProcess) {
  stopFfmpegTranscode(); // Kill existing

  // Transcode PCM (44100Hz, 16-bit, stereo) to MP3
  const ffmpeg = spawn('ffmpeg', [
    '-f', 's16le',        // Input format: signed 16-bit little-endian
    '-ar', '44100',        // Sample rate
    '-ac', '2',            // Stereo
    '-i', 'pipe:0',       // Read from stdin
    '-codec:a', 'libmp3lame',
    '-b:a', '320k',       // Output bitrate
    '-f', 'mp3',           // Output format
    'pipe:1',              // Write to stdout
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  state.ffmpegProcess = ffmpeg;

  // Pipe librespot PCM output → ffmpeg stdin
  librespotProc.stdout?.pipe(ffmpeg.stdin!);

  // Pipe ffmpeg MP3 output → all connected HTTP clients
  ffmpeg.stdout?.on('data', (chunk: Buffer) => {
    for (const client of streamClients) {
      try {
        client.write(chunk);
      } catch {
        streamClients.delete(client);
      }
    }
  });

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && !msg.startsWith('size=')) {
      logger.debug(`FFmpeg: ${msg}`);
    }
  });

  ffmpeg.on('close', () => {
    state.ffmpegProcess = null;
  });

  logger.info('Librespot: FFmpeg transcoder started (PCM → MP3)');
}

function stopFfmpegTranscode() {
  if (state.ffmpegProcess) {
    state.ffmpegProcess.kill();
    state.ffmpegProcess = null;
  }
  // Close all stream clients
  for (const client of streamClients) {
    try { client.end(); } catch {}
  }
  streamClients.clear();
}

export function stopLibrespot() {
  if (state.process) {
    state.process.kill();
    state.process = null;
  }
  stopFfmpegTranscode();
  state.isRunning = false;
  state.isStreaming = false;
  logger.info('Librespot: Stopped');
}

export function getLibrespotState() {
  return {
    isRunning: state.isRunning,
    isStreaming: state.isStreaming,
    currentTrackId: state.currentTrackId,
  };
}

/**
 * HTTP handler for the live MP3 stream.
 * DLNA/Volumio devices connect to this endpoint to receive audio.
 */
export function handleStreamRequest(req: import('http').IncomingMessage, res: import('http').ServerResponse) {
  if (!state.isRunning || !state.ffmpegProcess) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Librespot is not running');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'transferMode.dlna.org': 'Streaming',
  });

  streamClients.add(res);
  logger.info(`Librespot: Stream client connected (${streamClients.size} total)`);

  req.on('close', () => {
    streamClients.delete(res);
    logger.info(`Librespot: Stream client disconnected (${streamClients.size} total)`);
  });
}

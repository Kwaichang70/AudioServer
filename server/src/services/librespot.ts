import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { Readable } from 'stream';
import { config } from '../config.js';
import { logger } from '../logger.js';

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

export async function checkLibrespotAvailable(): Promise<boolean> {
  return checkBinaryAvailable('librespot', ['--version']);
}

export async function checkFfmpegAvailable(): Promise<boolean> {
  return checkBinaryAvailable('ffmpeg', ['-version']);
}

const BINARY_CHECK_TTL_MS = 5 * 60_000;
const binaryChecks = new Map<string, { at: number; result: Promise<boolean> }>();

/**
 * Is this program installed? Asked by starting it, so the answer is kept for
 * five minutes: the status route is polled and is not rate limited, and it
 * started two processes on every request (S04).
 */
function checkBinaryAvailable(cmd: string, args: string[]): Promise<boolean> {
  const known = binaryChecks.get(cmd);
  if (known && Date.now() - known.at < BINARY_CHECK_TTL_MS) return known.result;
  const result = probeBinary(cmd, args);
  binaryChecks.set(cmd, { at: Date.now(), result });
  return result;
}

function probeBinary(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };
    try {
      const proc = spawn(cmd, args, { stdio: 'pipe' });
      proc.on('error', () => done(false));
      proc.on('close', (code) => done(code === 0));
      setTimeout(() => {
        try {
          proc.kill();
        } catch {}
        done(false);
      }, 5000);
    } catch {
      done(false);
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
    // Build args — if credentials provided use them, otherwise discovery mode
    const args = [
      '--name',
      'AudioServer',
      '--backend',
      'pipe',
      '--bitrate',
      '320',
      '--initial-volume',
      '80',
      // No audio files on disk; only the login below is kept.
      '--disable-audio-cache',
    ];
    // Remember who picked "AudioServer" in the Spotify app. Without it the
    // receiver was unknown to Spotify again after every restart, until
    // somebody chose it in the app once more.
    const cacheDir = librespotCacheDir();
    if (cacheDir) args.push('--cache', cacheDir);
    if (username && password) {
      args.push('--username', username, '--password', password);
    }
    // v0.4.x doesn't support --format flag

    const proc = spawn('librespot', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    state.process = proc;
    state.isRunning = true;
    proc.stdout?.on('error', (err) =>
      logger.warn(`Librespot: audio output failed: ${err.message}`),
    );

    proc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg.includes('ERROR') || msg.includes('WARN')) {
        logger.warn(`Librespot: ${msg}`);
      } else if (msg) {
        logger.info(`Librespot: ${msg}`);
      }

      // Detect track changes from librespot stderr. The transcoder is
      // started once and kept: librespot's PCM is one continuous stream, so
      // the speaker holds one connection across tracks. Restarting it per
      // track cut that connection at every track change, so an album fell
      // silent after its first track, and left the PCM piped into the
      // transcoder that had just been killed.
      if (msg.includes('Loading <') || msg.includes('Track "')) {
        state.isStreaming = true;
        ensureTranscoder(proc);
      }
      if (msg.includes('Player::Stopped') || msg.includes('Stopped')) {
        state.isStreaming = false;
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

    ensureTranscoder(proc);
    logger.info('Librespot: Started as Spotify Connect receiver "AudioServer"');
    return true;
  } catch (err) {
    logger.error(`Librespot: Failed to start: ${err}`);
    return false;
  }
}

/** Where librespot keeps its Spotify login: next to the database, so it survives an update. */
function librespotCacheDir(): string | null {
  try {
    const dir = join(dirname(resolve(config.databasePath)), 'librespot');
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    logger.warn(`Librespot: no cache folder, the Spotify login will not be remembered: ${err}`);
    return null;
  }
}

function spawnFfmpeg(): ChildProcess {
  // PCM (44100 Hz, 16 bit, stereo) from stdin → MP3 320 on stdout.
  return spawn(
    'ffmpeg',
    [
      '-f',
      's16le',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-i',
      'pipe:0',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '320k',
      '-f',
      'mp3',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

/**
 * Feed `source` into a transcoder and hand its output to `onChunk`.
 *
 * Every stream involved gets an error handler and the transcoder is taken
 * out of the pipe as soon as it is gone, so audio that still arrives is
 * never written into a dead process. Returns a function that takes the
 * transcoder out again.
 */
export function connectTranscoder(
  source: Readable,
  transcoder: ChildProcess,
  onChunk: (chunk: Buffer) => void,
  onGone: (reason: string) => void = () => {},
): () => void {
  const stdin = transcoder.stdin;
  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    if (stdin) source.unpipe(stdin);
  };
  const gone = (reason: string): void => {
    if (detached) return;
    detach();
    onGone(reason);
  };
  stdin?.on('error', (err) => gone(`its input closed: ${err.message}`));
  transcoder.stdout?.on('error', (err) => gone(`its output failed: ${err.message}`));
  transcoder.on('error', (err) => gone(`it could not run: ${err.message}`));
  transcoder.on('close', () => gone('it exited'));
  transcoder.stdout?.on('data', onChunk);
  if (stdin) source.pipe(stdin);
  return detach;
}

let detachTranscoder: (() => void) | null = null;

/** Start the transcoder when it is not running; a running one is left alone. */
function ensureTranscoder(librespotProc: ChildProcess): void {
  if (state.ffmpegProcess || !librespotProc.stdout) return;
  let ffmpeg: ChildProcess;
  try {
    ffmpeg = spawnFfmpeg();
  } catch (err) {
    logger.warn(`Librespot: could not start ffmpeg: ${err}`);
    return;
  }
  state.ffmpegProcess = ffmpeg;
  detachTranscoder = connectTranscoder(
    librespotProc.stdout,
    ffmpeg,
    (chunk) => {
      for (const client of streamClients) {
        try {
          client.write(chunk);
        } catch {
          streamClients.delete(client);
        }
      }
    },
    (reason) => {
      // Gone by itself: the next track starts a fresh one.
      if (state.ffmpegProcess === ffmpeg) {
        state.ffmpegProcess = null;
        detachTranscoder = null;
        logger.warn(`Librespot: the MP3 transcoder stopped (${reason})`);
        closeStreamClients();
      }
    },
  );
  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg && !msg.startsWith('size=')) logger.debug(`FFmpeg: ${msg}`);
  });
  logger.info('Librespot: FFmpeg transcoder started (PCM → MP3)');
}

function closeStreamClients(): void {
  for (const client of streamClients) {
    try {
      client.end();
    } catch {}
  }
  streamClients.clear();
}

function stopFfmpegTranscode() {
  // Take it out of the PCM stream BEFORE killing it, so nothing is written
  // into a process that is going away.
  detachTranscoder?.();
  detachTranscoder = null;
  if (state.ffmpegProcess) {
    state.ffmpegProcess.kill();
    state.ffmpegProcess = null;
  }
  closeStreamClients();
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
/**
 * Auto-start librespot if available and SPOTIFY_USERNAME/SPOTIFY_PASSWORD are set.
 */
export async function autoStartLibrespot(): Promise<void> {
  const hasLibrespot = await checkLibrespotAvailable();
  const hasFfmpeg = await checkFfmpegAvailable();

  if (!hasLibrespot || !hasFfmpeg) {
    logger.info(`Librespot: auto-start skipped (librespot: ${hasLibrespot}, ffmpeg: ${hasFfmpeg})`);
    return;
  }

  const username = process.env.SPOTIFY_USERNAME || '';
  const password = process.env.SPOTIFY_PASSWORD || '';

  // Start with credentials if available, otherwise discovery mode
  await startLibrespot(username, password);
}

export function handleStreamRequest(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
) {
  if (!state.isRunning || !state.ffmpegProcess) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Librespot is not running');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'transferMode.dlna.org': 'Streaming',
  });

  streamClients.add(res);
  logger.info(`Librespot: Stream client connected (${streamClients.size} total)`);

  // A speaker that hangs up mid-write must not take the server with it.
  res.on('error', () => streamClients.delete(res));
  req.on('close', () => {
    streamClients.delete(res);
    logger.info(`Librespot: Stream client disconnected (${streamClients.size} total)`);
  });
}

import { spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import type { Readable } from 'stream';
import { getOutputCapabilities } from './output-capabilities.js';
import { logger } from '../logger.js';
import { getLeveling, replayGainFor, type LevelGain } from './zone-audio.js';

/**
 * Format adaptation for speakers (R10.1, a trial).
 *
 * The server normally hands a speaker the original file. Only when the
 * speaker itself lists the formats it accepts, and the source format is not
 * among them, is the file converted on the NAS — FLAC to MP3 320 (default)
 * or to WAV. A speaker that lists nothing is not converted for: silence is
 * not a "no", and converting costs NAS CPU and the original file.
 *
 * Every conversion is counted: CPU time and peak memory per ffmpeg process,
 * read from /proc while it runs, so the trial can be decided on numbers
 * (R10.3). At most two run per room — the track playing and the one handed
 * to the speaker in advance; a third replaces the oldest.
 */

export type TranscodeTarget = 'mp3' | 'wav' | 'flac';

export const TARGET_MIME: Record<TranscodeTarget, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

const ALIASES: Record<string, string> = {
  'audio/x-flac': 'audio/flac',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
  'audio/x-ogg': 'audio/ogg',
};

export const TARGET_LABEL: Record<TranscodeTarget, string> = {
  mp3: 'MP3 320 kbit/s',
  wav: 'WAV (lossless)',
  flac: 'FLAC',
};

/** `audio/x-flac;foo=bar` → `audio/flac`: one name per format. */
export function normalizeMime(mime: string): string {
  const bare = mime.split(';')[0].trim().toLowerCase();
  return ALIASES[bare] ?? bare;
}

export interface TranscodeDecision {
  target: TranscodeTarget;
  /** Source and result as mime types. */
  from: string;
  to: string;
  /** Why, in a sentence the audio path can show. */
  reason: string;
  /** Volume leveling applied on the way (R10.2). */
  gain?: LevelGain;
}

/**
 * Convert, or play as is? Converts only when the speaker said what it takes,
 * the source is not in that list, and something we can make is.
 */
export function decideTranscode(
  sourceMime: string,
  accepted: string[],
  preferred: TranscodeTarget = 'mp3',
): TranscodeDecision | null {
  if (accepted.length === 0) return null;
  const accepts = new Set(accepted.map(normalizeMime));
  const from = normalizeMime(sourceMime);
  if (accepts.has(from)) return null;
  const order: TranscodeTarget[] = preferred === 'wav' ? ['wav', 'mp3'] : ['mp3', 'wav'];
  const target = order.find((t) => accepts.has(TARGET_MIME[t]));
  if (!target) return null;
  const label = (mime: string) => mime.replace('audio/', '').toUpperCase();
  return {
    target,
    from,
    to: TARGET_MIME[target],
    reason: `The speaker does not list ${label(from)} among the formats it accepts, so the NAS converts it to ${TARGET_LABEL[target]}.`,
  };
}

interface TranscodeDeps {
  ffmpegAvailable: () => Promise<boolean>;
  spawn: (command: string, args: string[]) => ChildProcess;
  /** Read CPU ticks and peak memory of a running process; null when unknown. */
  sample: (pid: number) => { cpuMs: number; peakRssKb: number } | null;
  preferred: () => TranscodeTarget;
  sampleIntervalMs: number;
}

let ffmpegCheck: Promise<boolean> | null = null;

function checkFfmpeg(): Promise<boolean> {
  ffmpegCheck ??= new Promise((resolve) => {
    try {
      const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  return ffmpegCheck;
}

/** Linux: utime + stime (clock ticks, 100 per second) and VmHWM (kB). */
function sampleProc(pid: number): { cpuMs: number; peakRssKb: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name may contain spaces; fields are counted after its ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const hwm = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0);
    return { cpuMs: ticks * 10, peakRssKb: hwm };
  } catch {
    return null;
  }
}

const defaults = (): TranscodeDeps => ({
  ffmpegAvailable: checkFfmpeg,
  spawn: (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  sample: sampleProc,
  preferred: () => (process.env.TRANSCODE_TARGET === 'wav' ? 'wav' : 'mp3'),
  sampleIntervalMs: 2000,
});

let deps = defaults();

export function configureTranscode(overrides: Partial<TranscodeDeps>): void {
  deps = { ...deps, ...overrides };
}

export function resetTranscode(): void {
  deps = defaults();
  for (const job of running.values()) job.stop('reset');
  running.clear();
  finished.length = 0;
}

/**
 * What a speaker gets for a file of this type: the original (null) or a
 * conversion. Asks the speaker's own capabilities; never converts when
 * ffmpeg is missing or the speaker did not answer.
 */
export async function planTranscode(
  sourceMime: string,
  deviceId: string,
  context?: { zoneId: string; trackId: string },
): Promise<TranscodeDecision | null> {
  if (process.env.TRANSCODE_FOR_SPEAKERS === 'false') return null;
  const caps = await getOutputCapabilities(deviceId).catch(() => null);
  const accepted = caps?.formats ?? [];
  let decision = decideTranscode(sourceMime, accepted, deps.preferred());

  // Volume leveling (R10.2): with what is converted anyway in 'auto', always
  // in 'track'/'album'. Without ReplayGain data nothing is leveled.
  const leveling = context ? getLeveling(context.zoneId) : 'off';
  const mode =
    leveling === 'track' || leveling === 'album'
      ? leveling
      : leveling === 'auto' && decision
        ? 'album'
        : null;
  const gain = mode && context ? replayGainFor(context.trackId, mode) : null;

  if (!decision && gain) {
    // Leveling alone: keep the format where the speaker takes it.
    const from = normalizeMime(sourceMime);
    const same: TranscodeTarget | undefined = (Object.keys(TARGET_MIME) as TranscodeTarget[]).find(
      (t) => TARGET_MIME[t] === from,
    );
    const takes = (t: TranscodeTarget) =>
      accepted.length === 0 || accepted.map(normalizeMime).includes(TARGET_MIME[t]);
    const target = same && takes(same) ? same : takes('mp3') ? 'mp3' : null;
    if (!target) return null;
    decision = {
      target,
      from,
      to: TARGET_MIME[target],
      reason:
        target === same
          ? `Volume leveling is on for this room, so the NAS adjusts the level and sends ${TARGET_LABEL[target]} again.`
          : `Volume leveling is on for this room, so the NAS adjusts the level and sends ${TARGET_LABEL[target]}.`,
    };
  }
  if (!decision) return null;
  if (gain) {
    decision = {
      ...decision,
      gain,
      reason: `${decision.reason} Level: ${gain.basis} ReplayGain ${gain.gainDb > 0 ? '+' : ''}${gain.gainDb.toFixed(1)} dB${
        gain.limitedByPeak ? ' (held back so the loudest peak does not clip)' : ''
      }.`,
    };
  }
  if (!(await deps.ffmpegAvailable())) {
    logger.warn(
      `Transcode: ${deviceId} needs ${decision.to}${gain ? ' with leveling' : ''} but ffmpeg is not installed; sending the original`,
    );
    return null;
  }
  return decision;
}

/** ffmpeg arguments for one file; the audio stream only, written to stdout. */
export function ffmpegArgs(
  file: string,
  target: TranscodeTarget,
  source: { sampleRate?: number | null; bitDepth?: number | null; gainDb?: number | null } = {},
): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', '0:a:0'];
  const deep = (source.bitDepth ?? 16) > 16;
  const filters: string[] = [];
  if (source.gainDb) {
    filters.push(`volume=${source.gainDb.toFixed(2)}dB`);
    // Back to 16 bit after a gain change: dither, so the rounding is noise
    // instead of distortion. 24 bit has room enough.
    if (target !== 'mp3' && !deep) filters.push('aresample=osf=s16:dither_method=triangular');
  }
  if (filters.length > 0) args.push('-af', filters.join(','));
  if (target === 'mp3') {
    // MP3 stops at 48 kHz: higher rates come down to their own family.
    const rate = source.sampleRate ?? 44100;
    if (![32000, 44100, 48000].includes(rate)) {
      args.push('-ar', rate % 48000 === 0 ? '48000' : '44100');
    }
    args.push('-codec:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3', 'pipe:1');
  } else if (target === 'flac') {
    args.push('-codec:a', 'flac');
    if (deep) args.push('-sample_fmt', 's32', '-bits_per_raw_sample', '24');
    else args.push('-sample_fmt', 's16');
    args.push('-f', 'flac', 'pipe:1');
  } else {
    args.push('-codec:a', deep ? 'pcm_s24le' : 'pcm_s16le', '-f', 'wav', 'pipe:1');
  }
  return args;
}

export interface TranscodeRun {
  id: number;
  zoneId: string;
  trackId: string;
  target: TranscodeTarget;
  /** Leveling applied, in dB (R10.2). */
  gainDb?: number | null;
  startedAt: number;
  endedAt?: number;
  /** CPU time ffmpeg used, as far as sampled. */
  cpuMs: number;
  peakRssKb: number;
  outcome?: 'finished' | 'stopped' | 'replaced' | 'failed' | 'reset';
}

interface Job extends TranscodeRun {
  stop: (why: NonNullable<TranscodeRun['outcome']>) => void;
}

const MAX_PER_ZONE = 2;
const running = new Map<number, Job>();
const finished: TranscodeRun[] = [];
let seq = 0;

/**
 * Start one conversion. The caller pipes `stream` to the speaker and calls
 * `stop()` when the speaker hangs up.
 */
export function startTranscode(input: {
  file: string;
  target: TranscodeTarget;
  zoneId: string;
  trackId: string;
  sampleRate?: number | null;
  bitDepth?: number | null;
  gainDb?: number | null;
}): { stream: Readable; stop: () => void; run: TranscodeRun } {
  // At most two per room: the oldest beyond that is a track nobody hears.
  const mine = [...running.values()]
    .filter((j) => j.zoneId === input.zoneId)
    .sort((a, b) => a.startedAt - b.startedAt || a.id - b.id);
  while (mine.length >= MAX_PER_ZONE) mine.shift()!.stop('replaced');

  const proc = deps.spawn('ffmpeg', ffmpegArgs(input.file, input.target, input));
  const job: Job = {
    id: ++seq,
    zoneId: input.zoneId,
    trackId: input.trackId,
    target: input.target,
    gainDb: input.gainDb ?? null,
    startedAt: Date.now(),
    cpuMs: 0,
    peakRssKb: 0,
    stop: () => {},
  };
  const sample = () => {
    if (!proc.pid) return;
    const s = deps.sample(proc.pid);
    if (s) {
      job.cpuMs = Math.max(job.cpuMs, s.cpuMs);
      job.peakRssKb = Math.max(job.peakRssKb, s.peakRssKb);
    }
  };
  const timer = setInterval(sample, deps.sampleIntervalMs);
  timer.unref?.();
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-500);
  });

  const end = (outcome: NonNullable<TranscodeRun['outcome']>) => {
    if (!running.has(job.id)) return;
    clearInterval(timer);
    running.delete(job.id);
    const { stop: _stop, ...run } = job;
    void _stop;
    const record: TranscodeRun = { ...run, endedAt: Date.now(), outcome };
    finished.unshift(record);
    finished.length = Math.min(finished.length, 20);
    logger.info(
      `Transcode #${job.id} ${job.trackId} → ${job.target} (${job.zoneId}): ${outcome} after ${Math.round(
        (record.endedAt! - job.startedAt) / 1000,
      )} s, ${job.cpuMs} ms CPU, peak ${Math.round(job.peakRssKb / 1024)} MB`,
    );
  };
  job.stop = (why) => {
    sample();
    end(why);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  };
  // Sample right before the process disappears, so short runs count too.
  proc.stdout?.on('end', sample);
  proc.on('close', (code) => {
    if (code !== 0 && code !== null && running.has(job.id)) {
      logger.warn(`Transcode #${job.id} failed (${code}): ${stderr.trim()}`);
      end('failed');
      return;
    }
    end('finished');
  });
  proc.on('error', (err) => {
    logger.warn(`Transcode #${job.id} could not start: ${err}`);
    end('failed');
  });
  running.set(job.id, job);
  sample();

  const { stop: _s, ...run } = job;
  void _s;
  return { stream: proc.stdout as Readable, stop: () => job.stop('stopped'), run };
}

/** What runs now and what ran recently, with CPU and memory: the trial's numbers. */
export function transcodeStats(): { active: TranscodeRun[]; recent: TranscodeRun[] } {
  const strip = ({ stop: _s, ...run }: Job): TranscodeRun => {
    void _s;
    return { ...run };
  };
  return { active: [...running.values()].map(strip), recent: [...finished] };
}

import { describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import { connectTranscoder } from '../services/librespot.js';

/**
 * The Spotify receiver's audio goes through a transcoder process to the
 * speaker. The transcoder used to be killed and restarted at every track
 * while the audio stayed piped into the old one; now one transcoder serves
 * the whole session and a dead one is taken out of the pipe.
 *
 * A child Node process that copies stdin to stdout stands in for ffmpeg.
 */
const echo = () =>
  spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

const until = async (condition: () => boolean, ms = 5000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('the transcoder behind the Spotify receiver', () => {
  it('passes audio through', async () => {
    const source = new PassThrough();
    const transcoder = echo();
    const out: Buffer[] = [];
    const detach = connectTranscoder(source, transcoder, (chunk) => out.push(chunk));
    source.write('pcm-audio');
    await until(() => Buffer.concat(out).toString().includes('pcm-audio'));
    detach();
    transcoder.kill();
  });

  it('survives a transcoder that dies while audio keeps arriving', async () => {
    const source = new PassThrough();
    const transcoder = echo();
    let gone = '';
    connectTranscoder(
      source,
      transcoder,
      () => {},
      (reason) => {
        gone = reason;
      },
    );
    transcoder.kill();
    // Audio keeps coming, as it does between two tracks.
    for (let i = 0; i < 50; i++) source.write(Buffer.alloc(4096));
    await until(() => gone !== '');
    for (let i = 0; i < 50; i++) source.write(Buffer.alloc(4096));
    await new Promise((r) => setTimeout(r, 100));
    expect(gone).not.toBe('');
    // The source is free again for the next transcoder.
    const next = echo();
    const out: Buffer[] = [];
    const detach = connectTranscoder(source, next, (chunk) => out.push(chunk));
    source.write('second-track');
    await until(() => Buffer.concat(out).toString().includes('second-track'));
    detach();
    next.kill();
  });
});

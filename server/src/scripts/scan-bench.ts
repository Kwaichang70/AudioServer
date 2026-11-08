/**
 * Library import benchmark (plan §6, "Grote bibliotheken").
 *
 *   npm run bench:scan --workspace=server -- [tracks=50000] [perAlbum=10]
 *
 * Writes N tiny but real FLAC files (STREAMINFO + Vorbis comments, no audio
 * frames) into album folders under a temp directory, then runs the real
 * scanner against a throw-away database twice:
 *
 *   1. first scan  — every file is new (the case of a fresh install),
 *   2. rescan      — nothing changed (the nightly / watcher case).
 *
 * It prints wall time and files per second for both, and the time per 1000
 * files over the course of the first scan, so a cost that grows with the
 * library (a lookup without an index) shows up as a rising line rather than
 * hiding in the average.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.AUDIOSERVER_SKIP_DOTENV = '1';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.split('=');
    return [k, v];
  }),
);
const TRACKS = Number(args.tracks ?? 50_000);
const PER_ALBUM = Number(args.perAlbum ?? 10);

const ARTISTS = ['Miles Davis', 'Björk', 'Radiohead', 'Nina Simone', 'Kraftwerk', 'Sigur Rós'];
const WORDS = ['Blue', 'Night', 'River', 'Stone', 'Heart', 'Light', 'Dream', 'Rain'];
const GENRES = ['Jazz', 'Rock', 'Electronic', 'Soul'];

/** A FLAC file the tag reader accepts: header blocks only, 3 minutes long. */
function flac(tags: Record<string, string>): Buffer {
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0); // min block size
  info.writeUInt16BE(4096, 2); // max block size
  // bytes 4–9: min/max frame size unknown (0)
  const sampleRate = 44_100n;
  const channels = 2n - 1n;
  const bits = 16n - 1n;
  const samples = 44_100n * 180n;
  const packed = (sampleRate << 44n) | (channels << 41n) | (bits << 36n) | samples;
  info.writeBigUInt64BE(packed, 10);
  // bytes 18–33: MD5 left zero (unknown)

  const vendor = Buffer.from('audioserver-bench');
  const entries = Object.entries(tags).map(([k, v]) => Buffer.from(`${k}=${v}`));
  const comment = Buffer.concat([
    u32le(vendor.length),
    vendor,
    u32le(entries.length),
    ...entries.flatMap((e) => [u32le(e.length), e]),
  ]);

  return Buffer.concat([
    Buffer.from('fLaC'),
    blockHeader(0, info.length, false),
    info,
    blockHeader(4, comment.length, true),
    comment,
  ]);
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

function blockHeader(type: number, length: number, last: boolean): Buffer {
  return Buffer.from([
    (last ? 0x80 : 0) | type,
    (length >> 16) & 0xff,
    (length >> 8) & 0xff,
    length & 0xff,
  ]);
}

function writeLibrary(root: string): void {
  const albums = Math.ceil(TRACKS / PER_ALBUM);
  let written = 0;
  for (let a = 0; a < albums && written < TRACKS; a++) {
    const artist = ARTISTS[a % ARTISTS.length];
    const album = `${WORDS[a % WORDS.length]} ${WORDS[(a * 7) % WORDS.length]} ${a}`;
    const dir = join(root, artist, album).replace(/\\/g, '/');
    mkdirSync(dir, { recursive: true });
    for (let t = 1; t <= PER_ALBUM && written < TRACKS; t++, written++) {
      writeFileSync(
        `${dir}/${String(t).padStart(2, '0')}.flac`,
        flac({
          TITLE: `${WORDS[(a + t) % WORDS.length]} ${t}`,
          ARTIST: artist,
          ALBUMARTIST: artist,
          ALBUM: album,
          TRACKNUMBER: String(t),
          DATE: String(1960 + (a % 60)),
          GENRE: GENRES[a % GENRES.length],
        }),
      );
    }
  }
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'audioserver-scan-bench-'));
  const root = join(work, 'music').replace(/\\/g, '/');
  try {
    let t0 = performance.now();
    writeLibrary(root);
    console.log(`Wrote ${TRACKS} FLAC files in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

    const { initDatabase, closeDatabase, getRawDb } = await import('../db/index.js');
    const { scanLibrary, getScanStatus } = await import('../services/scanner.js');
    initDatabase(join(work, 'bench.db'));

    // Time per 1000 processed files during the first scan.
    const marks: number[] = [];
    let next = 1000;
    let last = performance.now();
    const timer = setInterval(() => {
      const done = getScanStatus().processedFiles;
      while (done >= next) {
        const now = performance.now();
        marks.push(now - last);
        last = now;
        next += 1000;
      }
    }, 20);

    t0 = performance.now();
    last = t0;
    await scanLibrary([root], { trigger: 'manual' });
    const first = performance.now() - t0;
    clearInterval(timer);

    t0 = performance.now();
    await scanLibrary([root], { trigger: 'manual' });
    const rescan = performance.now() - t0;

    const count = (getRawDb().prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
    const rate = (ms: number) => Math.round(TRACKS / (ms / 1000));
    console.log(`Tracks in database: ${count}`);
    console.log(`First scan: ${(first / 1000).toFixed(1)} s (${rate(first)} files/s)`);
    console.log(`Rescan (unchanged): ${(rescan / 1000).toFixed(1)} s (${rate(rescan)} files/s)`);
    if (marks.length > 1) {
      const fmt = (ms: number) => `${Math.round(ms)} ms`;
      const q = (f: number) => marks[Math.min(marks.length - 1, Math.floor(marks.length * f))];
      console.log(
        `First scan, per 1000 files: first ${fmt(marks[0])}, middle ${fmt(q(0.5))}, last ${fmt(marks[marks.length - 1])}`,
      );
    }
    closeDatabase();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

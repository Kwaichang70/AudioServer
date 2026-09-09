/**
 * Local search benchmark (V07.3).
 *
 *   npm run bench:search --workspace=server -- [tracks=50000] [rounds=200]
 *
 * Builds a throw-away database with N synthetic tracks (realistic title,
 * artist and album mix, some non-Latin names), runs the ranked LIKE search
 * used by /api/library/search and prints p50 / p95 / max per query class.
 * The plan's target: p95 under 300 ms at 50 000 tracks on NAS hardware.
 * Decide about FTS5 on these numbers, not on intuition.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { searchLocal } from '../services/local-search.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.split('=');
    return [k, v];
  }),
);
const TRACKS = Number(args.tracks ?? 50_000);
const ROUNDS = Number(args.rounds ?? 200);

const ARTISTS = [
  'Miles Davis',
  'Adele',
  'Radiohead',
  'Björk',
  'Sigur Rós',
  'Café Tacvba',
  'Пётр Чайковский',
  '宇多田ヒカル',
  'Ólafur Arnalds',
  'The Beatles',
  'Nina Simone',
  'Kraftwerk',
];
const WORDS = [
  'Blue',
  'Night',
  'Love',
  'River',
  'Stone',
  'Heart',
  'Light',
  'Shadow',
  'Dream',
  'Fire',
  'Rain',
  'Road',
  'Song',
  'Silver',
  'Golden',
  'Winter',
];
const VERSIONS = ['', '', '', ' (Live)', ' (Remastered 2011)', ' - Radio Edit', ' [Acoustic]'];

function pick<T>(list: T[], i: number): T {
  return list[i % list.length];
}

function seed(db: ReturnType<typeof getRawDb>): void {
  const insertArtist = db.prepare("INSERT INTO artists (id, name, source) VALUES (?, ?, 'local')");
  const insertAlbum = db.prepare(
    "INSERT INTO albums (id, title, artist_id, artist_name, source) VALUES (?, ?, ?, ?, 'local')",
  );
  const insertTrack = db.prepare(
    `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, track_number, duration, format, sample_rate, bit_depth, file_path, source, availability)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', 'available')`,
  );
  db.transaction(() => {
    ARTISTS.forEach((name, i) => insertArtist.run(`ar${i}`, name));
    const albumsPerArtist = Math.ceil(TRACKS / 12 / ARTISTS.length);
    let t = 0;
    for (let a = 0; a < ARTISTS.length; a++) {
      for (let b = 0; b < albumsPerArtist; b++) {
        const albumId = `al${a}-${b}`;
        const albumTitle = `${pick(WORDS, a + b)} ${pick(WORDS, a * 3 + b * 7)} ${b}`;
        insertAlbum.run(albumId, albumTitle, `ar${a}`, ARTISTS[a]);
        for (let n = 1; n <= 12 && t < TRACKS; n++, t++) {
          const title = `${pick(WORDS, t)} ${pick(WORDS, t * 5 + 3)}${pick(VERSIONS, t * 11)}`;
          insertTrack.run(
            `t${t}`,
            title,
            albumId,
            albumTitle,
            `ar${a}`,
            ARTISTS[a],
            n,
            120 + (t % 300),
            t % 3 === 0 ? 'flac' : 'mp3',
            t % 5 === 0 ? 96000 : 44100,
            t % 5 === 0 ? 24 : 16,
            `/music/${a}/${b}/${t}.flac`,
          );
        }
      }
    }
  })();
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'audioserver-bench-'));
  const path = join(dir, 'bench.db');
  await initDatabase(path);
  const db = getRawDb();
  const t0 = performance.now();
  seed(db);
  console.log(`Seeded ${TRACKS} tracks in ${Math.round(performance.now() - t0)} ms`);

  const classes: Array<[string, string[]]> = [
    ['exact title', ['Blue Night', 'River Stone']],
    ['prefix', ['Sil', 'Gold', 'Ra']],
    ['contains (worst case)', ['ver', 'ight', 'on']],
    ['artist', ['Adele', 'Miles', 'Björk', 'Чайковский', '宇多田']],
    ['version word', ['Live', 'Remastered']],
  ];
  console.log(`\nquery class                p50     p95     max   (ms, ${ROUNDS} rounds)`);
  for (const [name, queries] of classes) {
    const times: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const q = queries[i % queries.length];
      const start = performance.now();
      searchLocal(q, { limit: 20 });
      times.push(performance.now() - start);
    }
    console.log(
      `${name.padEnd(24)} ${percentile(times, 50).toFixed(1).padStart(6)}  ${percentile(times, 95)
        .toFixed(1)
        .padStart(6)}  ${Math.max(...times)
        .toFixed(1)
        .padStart(6)}`,
    );
  }
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

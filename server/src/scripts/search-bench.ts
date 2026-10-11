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
 *
 * Focus (R05.1) is measured on the same library: filtered, sorted album and
 * track pages and the facet counts, with one listener's history and
 * favourites, against the same 300 ms p95 target.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDatabase, getRawDb, initDatabase } from '../db/index.js';
import { searchLocal } from '../services/local-search.js';
import { albumFacets, focusAlbums, focusTracks, parseFocusQuery } from '../services/focus.js';

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
const GENRES = ['Jazz', 'Rock', 'Classical', 'Electronic', 'Pop', 'Blues', 'Folk', 'Soul'];
const LABELS = ['Columbia', 'Blue Note', 'ECM', 'Warp', 'Deutsche Grammophon', 'XL'];
const BENCH_USER = 'bench-user';
const VERSIONS = ['', '', '', ' (Live)', ' (Remastered 2011)', ' - Radio Edit', ' [Acoustic]'];

function pick<T>(list: T[], i: number): T {
  return list[i % list.length];
}

function seed(db: ReturnType<typeof getRawDb>): void {
  const insertArtist = db.prepare("INSERT INTO artists (id, name, source) VALUES (?, ?, 'local')");
  const insertAlbum = db.prepare(
    `INSERT INTO albums (id, title, artist_id, artist_name, source, year, genre, label, format,
                         sample_rate, bit_depth, created_at)
     VALUES (?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertGenre = db.prepare('INSERT INTO album_genres (album_id, genre) VALUES (?, ?)');
  const insertListen = db.prepare(
    `INSERT INTO listening_sessions (id, track_id, title, artist_name, started_at, status, qualified, user_id)
     VALUES (?, ?, 'x', 'x', ?, 'ended', 1, ?)`,
  );
  const insertFavorite = db.prepare(
    "INSERT INTO favorites (item_type, item_id, user_id) VALUES ('album', ?, ?)",
  );
  const now = Math.floor(Date.now() / 1000);
  let albumIndex = 0;
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
        const i = albumIndex++;
        const hires = i % 5 === 0;
        insertAlbum.run(
          albumId,
          albumTitle,
          `ar${a}`,
          ARTISTS[a],
          1950 + (i % 75),
          pick(GENRES, i),
          pick(LABELS, i * 7),
          i % 3 === 2 ? 'mp3' : 'flac',
          hires ? 96000 : 44100,
          hires ? 24 : 16,
          now - (i % 1000) * 86400,
        );
        insertGenre.run(albumId, pick(GENRES, i));
        if (i % 4 === 0) insertGenre.run(albumId, pick(GENRES, i + 3));
        if (i % 9 === 0) insertFavorite.run(albumId, BENCH_USER);
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
          // One listener with a few years of history: ~40 000 qualified plays.
          if (t % 5 !== 0) {
            insertListen.run(`ls${t}`, `t${t}`, now - (t % 900) * 86400, BENCH_USER);
          }
        }
      }
    }
  })();
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const page = { limit: 50, offset: 0 };

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
    // R05.4: typed without accents, found through the folded columns.
    ['without accents', ['Bjork', 'Sigur Ros', 'Cafe Tacvba', 'Olafur']],
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

  // Focus (R05.1): the questions the Focus panel asks, each a full page.
  const focusClasses: Array<[string, () => unknown]> = [
    ['albums, no filter', () => focusAlbums(parseFocusQuery({}), BENCH_USER, page)],
    [
      'albums, 3 facets',
      () =>
        focusAlbums(
          parseFocusQuery({ genre: 'Jazz', yearFrom: '1970', yearTo: '1979', quality: 'hires' }),
          BENCH_USER,
          page,
        ),
    ],
    [
      'albums, unplayed+plays',
      () => focusAlbums(parseFocusQuery({ unplayed: 'true', sort: 'plays' }), BENCH_USER, page),
    ],
    [
      'albums, sort lastPlayed',
      () => focusAlbums(parseFocusQuery({ sort: 'lastPlayed' }), BENCH_USER, page),
    ],
    [
      'albums, dedupe editions',
      () => focusAlbums(parseFocusQuery({ dedupeEditions: 'true' }), BENCH_USER, page),
    ],
    [
      'tracks, genre+sort plays',
      () => focusTracks(parseFocusQuery({ genre: 'Rock,Blues', sort: 'plays' }), BENCH_USER, page),
    ],
    ['facets, no filter', () => albumFacets(parseFocusQuery({}), BENCH_USER)],
    [
      'facets, 3 facets',
      () =>
        albumFacets(
          parseFocusQuery({ genre: 'Jazz', yearFrom: '1970', yearTo: '1979', unplayed: 'true' }),
          BENCH_USER,
        ),
    ],
  ];
  const focusRounds = Math.max(20, Math.round(ROUNDS / 4));
  console.log(`\nfocus                      p50     p95     max   (ms, ${focusRounds} rounds)`);
  for (const [name, run] of focusClasses) {
    const times: number[] = [];
    for (let i = 0; i < focusRounds; i++) {
      const start = performance.now();
      run();
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

# Performance measurements

Numbers to decide on, not to impress with. Every row says how it was
measured, so it can be repeated on the NAS.

## Library scan (plan §6, "Grote bibliotheken")

```bash
npm run bench:scan --workspace=server -- tracks=50000
```

The benchmark writes 50 000 tiny but real FLAC files (tags only, 10 per
album), runs the real scanner on a throw-away database, then scans again with
nothing changed. Tag reading is cheap for these files, so the numbers isolate
what the scanner and the database add; real files on a NAS disk add I/O time
on top.

Measured on 8 Nov 2026 in a 4-core Linux container (Node 22), so not the NAS
itself:

| Build                        | First scan    | Rescan, nothing changed | Time per 1000 files during the first scan |
| ---------------------------- | ------------- | ----------------------- | ----------------------------------------- |
| Before (`e0ba630`)           | 528 s (95/s)  | 132 s (379/s)           | 3.0 s at the start → 22.3 s at the end    |
| After (indexed path lookups) | 120 s (417/s) | 11 s (4 494/s)          | 2.7 s → 2.6 s, flat                       |

**What it was.** For every file the scanner asked "is this path known?" and,
for a new file, "is this the same path with other slashes?" (B14). Neither
lookup had an index, so each was a full scan of the tracks table: the cost
per file grew with the library, which is the rising last column. A nightly
or watcher rescan of an unchanged 50 000-track library took over two minutes
for the same reason.

**What changed.** `idx_tracks_file_path` and an expression index on
`REPLACE(file_path, '\', '/')` that matches the scanner's query exactly
(`server/src/db/index.ts`, `EQUIVALENT_PATH_SQL` in `scanner.ts`). The test
`scan-indexes.test.ts` fails when either lookup stops using its index. The
indexes are created on start-up (`CREATE INDEX IF NOT EXISTS`); the schema
version stays 21. On an existing database the first start builds them once,
which takes seconds.

## Search and Focus

```bash
npm run bench:search --workspace=server -- tracks=50000
```

Ranked search, filtered album/track pages and facet counts on a 50 000-track
library, against a p95 target of 300 ms (V07.3, R05.1). Run it on the NAS
before deciding on FTS5.

## Lists in the browser

Not changed. Album, artist and track pages load 50 items per page from the
server and add pages as you scroll, so the first render is bounded. The
plan's rule is to add virtualisation only after measuring a slowdown on a
real phone with a long scrolled list; that measurement has not been done.

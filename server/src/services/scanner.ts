import { readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, basename, dirname, join } from 'path';
import { parseFile, selectCover } from 'music-metadata';
import { v4 as uuid } from 'uuid';
import { getDb, getRawDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { logger } from '../logger.js';
import { eq, and, sql } from 'drizzle-orm';
import { cacheEmbeddedCover } from './coverart-fetch.js';

const SUPPORTED_EXTENSIONS = new Set([
  '.flac',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.aiff',
]);

/**
 * Bump when the metadata rules change (new columns, different tag parsing):
 * every file whose row carries an older version is re-read once, even when
 * its mtime and size did not change. V06.1 introduced size/mtime/fingerprint.
 * R03.2 reads MusicBrainz ids, release data, work/movement, every genre and
 * the people on a track, so version 3 re-reads the library once.
 */
export const SCAN_VERSION = 3;

const artistCache = new Map<string, string>();
const albumCache = new Map<string, string>();

export interface ScanStatus {
  isScanning: boolean;
  phase: 'idle' | 'discovering' | 'scanning' | 'cleaning' | 'done';
  processedFiles: number;
  totalFiles: number;
  newTracks: number;
  updatedTracks: number;
  /** Files that disappeared under a readable root: marked missing, never deleted (V06.2). Same value as missingTracks. */
  removedTracks: number;
  /** Files found at a new path that were recognised as an existing track (fingerprint match). */
  relinkedTracks: number;
  missingTracks: number;
  /** Previously missing files that are back at their old path. */
  recoveredTracks: number;
  /** New files that looked like a missing track but had more than one candidate: left as new. */
  doubtfulTracks: number;
  artists: number;
  albums: number;
  tracks: number;
  errors: number;
  currentDir?: string;
  currentFile?: string;
  successfulRoots: string[];
  failedRoots: Array<{ path: string; error: string; failedDirs: string[] }>;
  orphanCleanupSkipped: boolean;
  runId: string | null;
  forced: boolean;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface ScanRunSummary {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'done' | 'failed';
  trigger: string;
  forced: boolean;
  roots: string[];
  successfulRoots: string[];
  failedRoots: Array<{ path: string; error: string; failedDirs: string[] }>;
  totalFiles: number;
  newTracks: number;
  updatedTracks: number;
  relinkedTracks: number;
  missingTracks: number;
  recoveredTracks: number;
  errors: number;
  message: string | null;
}

export interface ScanOptions {
  /** Re-read every file even when size and mtime are unchanged. */
  force?: boolean;
  trigger?: 'manual' | 'watcher' | 'startup' | 'test';
}

function emptyStatus(): ScanStatus {
  return {
    isScanning: false,
    phase: 'idle',
    processedFiles: 0,
    totalFiles: 0,
    newTracks: 0,
    updatedTracks: 0,
    removedTracks: 0,
    relinkedTracks: 0,
    missingTracks: 0,
    recoveredTracks: 0,
    doubtfulTracks: 0,
    artists: 0,
    albums: 0,
    tracks: 0,
    errors: 0,
    successfulRoots: [],
    failedRoots: [],
    orphanCleanupSkipped: false,
    runId: null,
    forced: false,
    startedAt: null,
    finishedAt: null,
  };
}

let scanStatus: ScanStatus = emptyStatus();
let forceRescan = false;

export function getScanStatus(): ScanStatus {
  return { ...scanStatus };
}

function emitProgress(): void {
  try {
    // Dynamic import to avoid circular dependency
    import('../socketio.js')
      .then(({ getIO }) => {
        getIO().emit('library:scan-progress', scanStatus);
      })
      .catch(() => {});
  } catch {}
}

export async function scanLibrary(
  libraryPaths: string[],
  options: ScanOptions = {},
): Promise<ScanStatus> {
  if (scanStatus.isScanning) return scanStatus;

  const startedAt = Math.floor(Date.now() / 1000);
  scanStatus = {
    ...emptyStatus(),
    isScanning: true,
    phase: 'discovering',
    runId: uuid(),
    forced: Boolean(options.force),
    startedAt,
  };
  forceRescan = Boolean(options.force);
  artistCache.clear();
  albumCache.clear();
  openScanRun(scanStatus.runId!, libraryPaths, options.trigger ?? 'manual', forceRescan, startedAt);

  const seenFilePaths = new Set<string>();

  try {
    emitProgress();
    for (const libPath of libraryPaths) {
      scanStatus.currentDir = libPath.split('/').pop() || libPath;
      scanStatus.totalFiles += await countSupportedFiles(libPath);
      emitProgress();
    }

    scanStatus.phase = 'scanning';
    scanStatus.currentFile = undefined;
    emitProgress();

    for (const libPath of libraryPaths) {
      logger.info(`Scanning: ${libPath}${forceRescan ? ' (forced)' : ''}`);
      const result = await scanDirectory(libPath, seenFilePaths);
      if (result.ok) {
        scanStatus.successfulRoots.push(libPath);
      } else {
        scanStatus.failedRoots.push({
          path: libPath,
          error: result.error,
          failedDirs: result.failedDirs,
        });
        logger.warn(`Scan root skipped for missing-file marking: ${libPath} (${result.error})`);
      }
      emitProgress();
    }

    // Files that vanished are only judged under roots that were fully
    // readable, so a NAS share that is offline never makes its music
    // "missing". And missing means marked, not deleted (V06.2): playlists,
    // favorites and history keep pointing at the row until an admin purges.
    scanStatus.phase = 'cleaning';
    emitProgress();
    if (scanStatus.successfulRoots.length === 0) {
      scanStatus.orphanCleanupSkipped = true;
      logger.warn(
        'Skipping missing-file marking: no configured music roots were scanned successfully',
      );
    } else {
      markMissing(seenFilePaths, scanStatus.successfulRoots);
    }

    // Re-keying albums (e.g. splitting quality editions) moves tracks to new
    // album rows and leaves the old merged albums empty — sweep those up and
    // refresh counts. Missing tracks still count as members of their album.
    pruneEmptyAlbums();

    scanStatus.phase = 'done';
    scanStatus.isScanning = false;
    scanStatus.currentDir = undefined;
    scanStatus.currentFile = undefined;
    scanStatus.finishedAt = Math.floor(Date.now() / 1000);
    closeScanRun(scanStatus, 'done', null);
    emitProgress();
    logger.info(
      `Scan complete: ${scanStatus.newTracks} new, ${scanStatus.updatedTracks} updated, ${scanStatus.relinkedTracks} relinked, ${scanStatus.missingTracks} missing, ${scanStatus.recoveredTracks} recovered, ${scanStatus.errors} errors`,
    );
  } catch (err) {
    logger.error(`Scan failed: ${err}`);
    scanStatus.isScanning = false;
    scanStatus.phase = 'idle';
    scanStatus.finishedAt = Math.floor(Date.now() / 1000);
    closeScanRun(scanStatus, 'failed', describeFsError(err));
    emitProgress();
  }

  artistCache.clear();
  albumCache.clear();
  forceRescan = false;
  return scanStatus;
}

// ─── Scan runs (V06.3) ───────────────────────────────────────────

function openScanRun(
  id: string,
  roots: string[],
  trigger: string,
  forced: boolean,
  startedAt: number,
): void {
  try {
    getRawDb()
      .prepare(
        'INSERT INTO scan_runs (id, started_at, status, trigger, forced, roots) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, startedAt, 'running', trigger, forced ? 1 : 0, JSON.stringify(roots));
  } catch (err) {
    logger.warn(`Scan run could not be recorded: ${err}`);
  }
}

function closeScanRun(
  status: ScanStatus,
  outcome: 'done' | 'failed',
  message: string | null,
): void {
  if (!status.runId) return;
  try {
    getRawDb()
      .prepare(
        `UPDATE scan_runs SET finished_at = ?, status = ?, successful_roots = ?, failed_roots = ?,
           total_files = ?, new_tracks = ?, updated_tracks = ?, relinked_tracks = ?, missing_tracks = ?,
           recovered_tracks = ?, errors = ?, message = ?
         WHERE id = ?`,
      )
      .run(
        status.finishedAt ?? Math.floor(Date.now() / 1000),
        outcome,
        JSON.stringify(status.successfulRoots),
        JSON.stringify(status.failedRoots),
        status.totalFiles,
        status.newTracks,
        status.updatedTracks,
        status.relinkedTracks,
        status.missingTracks,
        status.recoveredTracks,
        status.errors,
        message,
        status.runId,
      );
  } catch (err) {
    logger.warn(`Scan run could not be closed: ${err}`);
  }
}

interface ScanRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  trigger: string;
  forced: number;
  roots: string;
  successful_roots: string | null;
  failed_roots: string | null;
  total_files: number;
  new_tracks: number;
  updated_tracks: number;
  relinked_tracks: number;
  missing_tracks: number;
  recovered_tracks: number;
  errors: number;
  message: string | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toRunSummary(row: ScanRunRow): ScanRunSummary {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as ScanRunSummary['status'],
    trigger: row.trigger,
    forced: Boolean(row.forced),
    roots: parseJson<string[]>(row.roots, []),
    successfulRoots: parseJson<string[]>(row.successful_roots, []),
    failedRoots: parseJson<ScanRunSummary['failedRoots']>(row.failed_roots, []),
    totalFiles: row.total_files,
    newTracks: row.new_tracks,
    updatedTracks: row.updated_tracks,
    relinkedTracks: row.relinked_tracks,
    missingTracks: row.missing_tracks,
    recoveredTracks: row.recovered_tracks,
    errors: row.errors,
    message: row.message,
  };
}

/** Most recent runs, newest first. */
export function listScanRuns(limit = 20): ScanRunSummary[] {
  const rows = getRawDb()
    .prepare('SELECT * FROM scan_runs ORDER BY started_at DESC, rowid DESC LIMIT ?')
    .all(Math.max(1, Math.min(limit, 100))) as ScanRunRow[];
  return rows.map(toRunSummary);
}

/** The last run that finished without failing, or null. */
export function getLastSuccessfulScanRun(): ScanRunSummary | null {
  const row = getRawDb()
    .prepare("SELECT * FROM scan_runs WHERE status = 'done' ORDER BY finished_at DESC LIMIT 1")
    .get() as ScanRunRow | undefined;
  return row ? toRunSummary(row) : null;
}

/** Startup: a run the previous process never closed is marked failed. */
export function closeInterruptedScanRuns(): number {
  const result = getRawDb()
    .prepare(
      "UPDATE scan_runs SET status = 'failed', finished_at = ?, message = 'Interrupted by a server restart' WHERE status = 'running'",
    )
    .run(Math.floor(Date.now() / 1000));
  return result.changes;
}

interface DirectoryScanResult {
  ok: boolean;
  error: string;
  failedDirs: string[];
}

interface LocalTrackRow {
  id: string;
  file_path: string | null;
  album_id: string;
  artist_id: string;
  availability: string;
}

function describeFsError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function normalizeScanPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isPathUnderRoot(filePath: string, normalizedRoot: string): boolean {
  const normalizedFile = normalizeScanPath(filePath);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

async function scanDirectory(dir: string, seenFiles: Set<string>): Promise<DirectoryScanResult> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const error = describeFsError(err);
    scanStatus.errors++;
    logger.warn(`Cannot read music directory ${dir}: ${error}`);
    return { ok: false, error, failedDirs: [dir] };
  }

  scanStatus.currentDir = dir.split('/').pop() || dir;

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    const filePath = dir + '/' + entry.name;
    seenFiles.add(filePath);
    scanStatus.currentFile = entry.name;

    try {
      let fileStat: Stats | null = null;
      try {
        fileStat = await stat(filePath);
      } catch {
        // Unreadable stat: process anyway, the parser will report the real error
      }
      // Is the file already known at this path, and did it change? Size and
      // mtime together decide (V06.1); a scan-version bump or a forced scan
      // re-reads it regardless.
      const existing = getDb().select().from(tracks).where(eq(tracks.filePath, filePath)).get();
      if (existing) {
        const wasMissing = existing.availability === 'missing';
        const unchanged =
          fileStat !== null &&
          !forceRescan &&
          (existing.scanVersion ?? 0) >= SCAN_VERSION &&
          existing.fileSize === fileStat.size &&
          existing.fileMtime === Math.floor(fileStat.mtimeMs / 1000);
        if (unchanged) {
          if (wasMissing) markAvailable(existing.id);
          scanStatus.tracks++;
          scanStatus.processedFiles++;
          continue;
        }
        if (wasMissing) scanStatus.recoveredTracks++;
        else scanStatus.updatedTracks++;
        await processFile(filePath, fileStat, existing.id);
      } else {
        const outcome = await processFile(filePath, fileStat, null);
        if (outcome === 'relinked') scanStatus.relinkedTracks++;
        else scanStatus.newTracks++;
        if (outcome === 'doubtful') scanStatus.doubtfulTracks++;
      }
      scanStatus.tracks++;
    } catch (err) {
      scanStatus.errors++;
      if (scanStatus.errors <= 3) {
        logger.error(`SCAN ERROR [${filePath}]: ${err instanceof Error ? err.stack : String(err)}`);
      }
    }

    scanStatus.processedFiles++;

    if (scanStatus.processedFiles % 100 === 0) {
      logger.info(
        `Progress: ${scanStatus.processedFiles} files | ${scanStatus.newTracks} new | ${scanStatus.updatedTracks} updated | ${scanStatus.errors} errors`,
      );
      emitProgress();
    }
  }

  // Recurse into subdirectories
  const failedDirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const result = await scanDirectory(dir + '/' + entry.name, seenFiles);
      if (!result.ok) failedDirs.push(...result.failedDirs);
    }
  }

  if (failedDirs.length > 0) {
    return {
      ok: false,
      error: `Failed to read ${failedDirs.length} director${failedDirs.length === 1 ? 'y' : 'ies'}`,
      failedDirs,
    };
  }

  return { ok: true, error: '', failedDirs: [] };
}

async function countSupportedFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countSupportedFiles(`${dir}/${entry.name}`);
    } else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      count++;
    }
  }
  return count;
}

// Delete albums that have no tracks left (orphaned by a re-key) and refresh
// every album's track_count. Safe to run after every scan: only genuinely
// empty albums are removed.
function pruneEmptyAlbums(): void {
  const db = getRawDb();
  const albumsList = db.prepare('SELECT id FROM albums').all() as { id: string }[];
  let removed = 0;
  for (const a of albumsList) {
    const count =
      (db.prepare('SELECT COUNT(*) as c FROM tracks WHERE album_id = ?').get(a.id) as { c: number })
        ?.c ?? 0;
    if (count === 0) {
      // A whole album folder that moved gets a new album row (the folder is
      // part of the edition key). Its favorite follows to the album with the
      // same artist and title when there is exactly one, instead of vanishing.
      const heir = db
        .prepare(
          `SELECT b.id FROM albums a JOIN albums b
              ON b.id != a.id AND b.artist_id = a.artist_id AND b.title = a.title COLLATE NOCASE
           WHERE a.id = ? AND EXISTS (SELECT 1 FROM tracks t WHERE t.album_id = b.id)`,
        )
        .all(a.id) as Array<{ id: string }>;
      if (heir.length === 1) {
        const exists = db
          .prepare("SELECT id FROM favorites WHERE item_type = 'album' AND item_id = ?")
          .get(heir[0].id);
        if (exists) {
          db.prepare("DELETE FROM favorites WHERE item_type = 'album' AND item_id = ?").run(a.id);
        } else {
          db.prepare(
            "UPDATE favorites SET item_id = ? WHERE item_type = 'album' AND item_id = ?",
          ).run(heir[0].id, a.id);
        }
      } else {
        db.prepare("DELETE FROM favorites WHERE item_type = 'album' AND item_id = ?").run(a.id);
      }
      db.prepare('DELETE FROM albums WHERE id = ?').run(a.id);
      removed++;
    } else {
      db.prepare('UPDATE albums SET track_count = ? WHERE id = ?').run(count, a.id);
    }
  }
  if (removed > 0) logger.info(`Pruned ${removed} empty albums`);
}

function markAvailable(trackId: string): void {
  getRawDb()
    .prepare("UPDATE tracks SET availability = 'available', missing_since = NULL WHERE id = ?")
    .run(trackId);
  scanStatus.recoveredTracks++;
}

/**
 * Files that are no longer at their path, under roots that were fully
 * readable, become `missing`. Nothing is deleted: the row, its playlist
 * positions, favorites and history stay until an admin purges (V06.2).
 */
function markMissing(seenFiles: Set<string>, successfulRoots: string[]): void {
  const db = getRawDb();
  const allTracks = db
    .prepare('SELECT id, file_path, album_id, artist_id, availability FROM tracks WHERE source = ?')
    .all('local') as LocalTrackRow[];
  const normalizedSeenFiles = new Set(Array.from(seenFiles, normalizeScanPath));
  const normalizedRoots = successfulRoots.map(normalizeScanPath);

  const newlyMissing: string[] = [];
  let stillMissing = 0;
  for (const track of allTracks) {
    const filePath = track.file_path;
    if (!filePath) continue;
    if (!normalizedRoots.some((root) => isPathUnderRoot(filePath, root))) continue;
    if (normalizedSeenFiles.has(normalizeScanPath(filePath))) continue;
    if (track.availability === 'missing') stillMissing++;
    else newlyMissing.push(track.id);
  }

  if (newlyMissing.length > 0) {
    const now = Math.floor(Date.now() / 1000);
    const mark = db.prepare(
      "UPDATE tracks SET availability = 'missing', missing_since = ? WHERE id = ?",
    );
    db.transaction(() => {
      for (const id of newlyMissing) mark.run(now, id);
    })();
    logger.info(
      `Marked ${newlyMissing.length} track(s) as missing (${stillMissing} were already missing); nothing deleted`,
    );
  }
  scanStatus.missingTracks = newlyMissing.length;
  scanStatus.removedTracks = newlyMissing.length;
}

export interface MissingTrack {
  id: string;
  title: string;
  artistName: string;
  albumTitle: string;
  albumId: string;
  filePath: string | null;
  duration: number | null;
  missingSince: number | null;
  /** Available tracks that could be the same recording. `strong` = fingerprint match. */
  candidates: Array<{
    id: string;
    title: string;
    artistName: string;
    albumTitle: string;
    filePath: string | null;
    duration: number | null;
    strength: 'strong' | 'weak';
  }>;
}

interface MissingRow {
  id: string;
  title: string;
  artist_name: string;
  album_title: string;
  album_id: string;
  file_path: string | null;
  duration: number | null;
  missing_since: number | null;
  fingerprint: string | null;
}

interface CandidateRow {
  id: string;
  title: string;
  artist_name: string;
  album_title: string;
  file_path: string | null;
  duration: number | null;
}

/** Missing tracks with their possible matches. Nothing is merged automatically. */
export function listMissingTracks(limit = 200): MissingTrack[] {
  const db = getRawDb();
  const rows = db
    .prepare(
      `SELECT id, title, artist_name, album_title, album_id, file_path, duration, missing_since, fingerprint
         FROM tracks WHERE availability = 'missing' ORDER BY missing_since DESC, title LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 1000))) as MissingRow[];
  const strong = db.prepare(
    `SELECT id, title, artist_name, album_title, file_path, duration FROM tracks
      WHERE availability = 'available' AND fingerprint = ? AND id != ? LIMIT 5`,
  );
  // Weak: same title and artist, whatever the length. Shown to the admin as a
  // suggestion only; a different duration is exactly why it is not merged.
  const weak = db.prepare(
    `SELECT id, title, artist_name, album_title, file_path, duration FROM tracks
      WHERE availability = 'available' AND id != ?
        AND title = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
      ORDER BY ABS(COALESCE(duration, 0) - COALESCE(?, 0)) LIMIT 5`,
  );
  return rows.map((row) => {
    const strongRows = row.fingerprint
      ? (strong.all(row.fingerprint, row.id) as CandidateRow[])
      : [];
    const strongIds = new Set(strongRows.map((c) => c.id));
    const weakRows = (
      weak.all(row.id, row.title, row.artist_name, row.duration) as CandidateRow[]
    ).filter((c) => !strongIds.has(c.id));
    const toCandidate = (c: CandidateRow, strength: 'strong' | 'weak') => ({
      id: c.id,
      title: c.title,
      artistName: c.artist_name,
      albumTitle: c.album_title,
      filePath: c.file_path,
      duration: c.duration,
      strength,
    });
    return {
      id: row.id,
      title: row.title,
      artistName: row.artist_name,
      albumTitle: row.album_title,
      albumId: row.album_id,
      filePath: row.file_path,
      duration: row.duration,
      missingSince: row.missing_since,
      candidates: [
        ...strongRows.map((c) => toCandidate(c, 'strong')),
        ...weakRows.map((c) => toCandidate(c, 'weak')),
      ],
    };
  });
}

/**
 * Admin decided that missing track A is available track B: A's playlist
 * positions, favorite and history move to B, then A's row goes away.
 */
export function relinkMissingTrack(
  missingId: string,
  targetId: string,
): { playlistRefs: number; favorites: number; sessions: number } | null {
  const db = getRawDb();
  const missing = db
    .prepare("SELECT id FROM tracks WHERE id = ? AND availability = 'missing'")
    .get(missingId);
  const target = db
    .prepare("SELECT id FROM tracks WHERE id = ? AND availability = 'available'")
    .get(targetId);
  if (!missing || !target || missingId === targetId) return null;
  let playlistRefs = 0;
  let favorites = 0;
  let sessions = 0;
  db.transaction(() => {
    playlistRefs = db
      .prepare('UPDATE playlist_tracks SET track_id = ? WHERE track_id = ?')
      .run(targetId, missingId).changes;
    // A favorite for B may already exist; then A's is simply dropped.
    const hasTargetFavorite = db
      .prepare("SELECT id FROM favorites WHERE item_type = 'track' AND item_id = ?")
      .get(targetId);
    if (hasTargetFavorite) {
      db.prepare("DELETE FROM favorites WHERE item_type = 'track' AND item_id = ?").run(missingId);
    } else {
      favorites = db
        .prepare("UPDATE favorites SET item_id = ? WHERE item_type = 'track' AND item_id = ?")
        .run(targetId, missingId).changes;
    }
    sessions = db
      .prepare('UPDATE listening_sessions SET track_id = ? WHERE track_id = ?')
      .run(targetId, missingId).changes;
    db.prepare('UPDATE play_history SET track_id = ? WHERE track_id = ?').run(targetId, missingId);
    db.prepare('DELETE FROM tracks WHERE id = ?').run(missingId);
  })();
  pruneEmptyAlbums();
  logger.info(`Relinked missing track ${missingId} to ${targetId}`);
  return { playlistRefs, favorites, sessions };
}

/**
 * The explicit clean-up: delete missing tracks (all, or the given ids) and
 * everything that referenced them. History rows keep their snapshot; only
 * the legacy play_history rows and playlist positions go.
 */
export function purgeMissingTracks(ids?: string[]): number {
  const db = getRawDb();
  const rows = (
    ids && ids.length > 0
      ? db
          .prepare(
            `SELECT id, file_path, album_id, artist_id, availability FROM tracks
              WHERE availability = 'missing' AND id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids)
      : db
          .prepare(
            "SELECT id, file_path, album_id, artist_id, availability FROM tracks WHERE availability = 'missing'",
          )
          .all()
  ) as LocalTrackRow[];
  if (rows.length === 0) return 0;

  const deletePlaylistRefs = db.prepare('DELETE FROM playlist_tracks WHERE track_id = ?');
  const deleteHistory = db.prepare('DELETE FROM play_history WHERE track_id = ?');
  const deleteTrackFavorite = db.prepare(
    "DELETE FROM favorites WHERE item_type = 'track' AND item_id = ?",
  );
  const deleteTrack = db.prepare('DELETE FROM tracks WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      deletePlaylistRefs.run(row.id);
      deleteHistory.run(row.id);
      deleteTrackFavorite.run(row.id);
      deleteTrack.run(row.id);
    }
    db.prepare(
      'UPDATE playlists SET track_count = (SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = playlists.id)',
    ).run();
  })();

  const affectedAlbumIds = new Set(rows.map((r) => r.album_id));
  const affectedArtistIds = new Set(rows.map((r) => r.artist_id));
  for (const albumId of affectedAlbumIds) {
    const count =
      (
        db.prepare('SELECT COUNT(*) as c FROM tracks WHERE album_id = ?').get(albumId) as
          | { c: number }
          | undefined
      )?.c ?? 0;
    if (count === 0) {
      db.prepare("DELETE FROM favorites WHERE item_type = 'album' AND item_id = ?").run(albumId);
      db.prepare('DELETE FROM albums WHERE id = ?').run(albumId);
    } else {
      db.prepare('UPDATE albums SET track_count = ? WHERE id = ?').run(count, albumId);
    }
  }
  for (const artistId of affectedArtistIds) {
    const count =
      (
        db.prepare('SELECT COUNT(*) as c FROM albums WHERE artist_id = ?').get(artistId) as
          | { c: number }
          | undefined
      )?.c ?? 0;
    if (count === 0) {
      db.prepare("DELETE FROM favorites WHERE item_type = 'artist' AND item_id = ?").run(artistId);
      db.prepare('DELETE FROM artists WHERE id = ?').run(artistId);
    }
  }
  logger.info(`Purged ${rows.length} missing track(s)`);
  return rows.length;
}

/**
 * Identity of a recording independent of its path: size and duration are
 * exact, the tags identify the piece. Same title and artist alone is never
 * enough (a re-rip, a different edition); the same bytes and length are.
 */
export function fingerprintOf(input: {
  size: number | null;
  duration: number | undefined;
  title: string;
  artistName: string;
  albumTitle: string;
  trackNumber: number | null | undefined;
  discNumber: number | null | undefined;
}): string {
  const parts = [
    input.size ?? '',
    input.duration !== undefined ? Math.round(input.duration * 1000) : '',
    input.title.trim().toLowerCase(),
    input.artistName.trim().toLowerCase(),
    input.albumTitle.trim().toLowerCase(),
    input.trackNumber ?? '',
    input.discNumber ?? '',
  ];
  return createHash('sha1').update(parts.join('|')).digest('hex');
}

/**
 * A file at a new path: is it a known track that moved? Only when exactly one
 * track carries the same fingerprint and its old file is really gone. Two
 * candidates, or the old file still present (a copy), and the file is new.
 */
function findMoveCandidate(
  fingerprint: string,
  newPath: string,
): { id: string; albumId: string } | 'doubtful' | null {
  const rows = getRawDb()
    .prepare(
      "SELECT id, file_path, album_id FROM tracks WHERE fingerprint = ? AND source = 'local' AND file_path != ?",
    )
    .all(fingerprint, newPath) as Array<{ id: string; file_path: string | null; album_id: string }>;
  const gone = rows.filter((r) => !r.file_path || !existsSync(r.file_path));
  if (gone.length === 1) return { id: gone[0].id, albumId: gone[0].album_id };
  if (gone.length > 1) return 'doubtful';
  return null;
}

/**
 * The artist row for a name, created once per scan and reused (R03.2).
 *
 * An MBID is only written when the tags give exactly one for this name: a
 * list of ids next to a list of names cannot be paired reliably, and a wrong
 * identity is worse than none. An id already on the row is never overwritten
 * with a guess.
 */
function upsertArtist(name: string, mbid?: string): string {
  const key = name.toLowerCase();
  const cached = artistCache.get(key);
  if (cached) {
    if (mbid) claimArtistMbid(cached, mbid);
    return cached;
  }
  const db = getDb();
  // COLLATE NOCASE: the in-scan cache key is lowercased, but a fresh scan
  // starts with an empty cache — a case-sensitive lookup would then miss
  // "ABBA" when this file is tagged "Abba" and create a duplicate artist.
  const existing = db
    .select()
    .from(artists)
    .where(sql`${artists.name} = ${name} COLLATE NOCASE`)
    .get();
  if (existing) {
    artistCache.set(key, existing.id);
    if (mbid) claimArtistMbid(existing.id, mbid);
    return existing.id;
  }
  const id = uuid();
  db.insert(artists)
    .values({ id, name, mbid: mbid ?? null, source: 'local' })
    .run();
  artistCache.set(key, id);
  scanStatus.artists++;
  return id;
}

/**
 * Write the album identity the tags gave, but only where the row is still
 * empty: an album is scanned track by track, and a file without MusicBrainz
 * tags must not undo what the file before it established.
 */
function claimAlbumIdentity(
  albumId: string,
  values: {
    mbid?: string;
    releaseGroupMbid?: string;
    label?: string;
    catalogNumber?: string;
    releaseDate?: string;
    originalYear?: number;
  },
): void {
  const columns: Array<[string, string | number]> = [];
  if (values.mbid) columns.push(['mbid', values.mbid]);
  if (values.releaseGroupMbid) columns.push(['release_group_mbid', values.releaseGroupMbid]);
  if (values.label) columns.push(['label', values.label]);
  if (values.catalogNumber) columns.push(['catalog_number', values.catalogNumber]);
  if (values.releaseDate) columns.push(['release_date', values.releaseDate]);
  if (values.originalYear) columns.push(['original_year', values.originalYear]);
  if (columns.length === 0) return;
  try {
    const db = getRawDb();
    for (const [column, value] of columns) {
      db.prepare(
        `UPDATE albums SET ${column} = ? WHERE id = ? AND (${column} IS NULL OR ${column} = '')`,
      ).run(value, albumId);
    }
  } catch (err) {
    logger.debug(`Scanner: could not store album identity for ${albumId}: ${err}`);
  }
}

/** Fill in an MBID that is still missing; never replace one that is there. */
function claimArtistMbid(artistId: string, mbid: string): void {
  try {
    getRawDb()
      .prepare("UPDATE artists SET mbid = ? WHERE id = ? AND (mbid IS NULL OR mbid = '')")
      .run(mbid, artistId);
  } catch {
    // An artists table without the column (pre-R03) is simply left alone.
  }
}

async function processFile(
  filePath: string,
  fileStat: Stats | null,
  knownTrackId: string | null,
): Promise<'new' | 'updated' | 'relinked' | 'doubtful'> {
  const metadata = await parseFile(filePath);
  const { common, format } = metadata;

  const trackArtistNames = normalizePeople(common.artists ?? common.artist);
  const isCompilation = Boolean((common as { compilation?: boolean | string }).compilation);
  const artistName = trackArtistNames.join(', ') || common.albumartist || 'Unknown Artist';
  const albumArtistName = common.albumartist || (isCompilation ? 'Various Artists' : artistName);
  const albumTitle = common.album || 'Unknown Album';
  const trackTitle = common.title || basename(filePath, extname(filePath));
  const composer = normalizePeople(common.composer).join(', ') || undefined;
  const conductor = normalizePeople(common.conductor).join(', ') || undefined;

  // ── What the tags say about identity (R03.2) ──
  // Read from the file, never inferred: a Picard-tagged folder is identified
  // without touching the network, and an untagged one stays honestly
  // unidentified until the job of R03.3 looks it up.
  const tags = common as unknown as Record<string, unknown>;
  const albumArtistMbids = tags.musicbrainz_albumartistid as string[] | undefined;
  const credits = creditsFromTags(tags);
  const genres = genresFromTags(common.genre);
  const recordingMbid =
    (tags.musicbrainz_recordingid as string | undefined) ??
    (tags.musicbrainz_trackid as string | undefined);
  const albumMbid = tags.musicbrainz_albumid as string | undefined;
  const releaseGroupMbid = tags.musicbrainz_releasegroupid as string | undefined;
  const label = firstOf(tags.label as string[] | undefined);
  const catalogNumber = firstOf(tags.catalognumber as string[] | undefined);
  const releaseDate = firstOf(tags.date as string | undefined);
  const originalYear =
    (tags.originalyear as number | undefined) ??
    yearFromDate(tags.originaldate as string | undefined);
  const isrc = firstOf(tags.isrc as string[] | undefined);
  const bpm = typeof tags.bpm === 'number' ? tags.bpm : undefined;
  const work = (tags.work as string | undefined)?.trim() || undefined;
  const movement = (tags.movement as string | undefined)?.trim() || undefined;

  // Upsert artist. Every credited person goes through here (R03.2), so a
  // guest on one track gets a row of their own instead of living inside a
  // display string.
  const artistId = upsertArtist(albumArtistName, firstOf(albumArtistMbids));

  // Upsert album. The folder is part of the identity: the same album ripped at
  // multiple qualities (each in its own folder) becomes separate album entries
  // instead of one album with every track duplicated. The quality (format /
  // sample rate / bit depth) is stored so the UI can tell those editions apart.
  const albumDir = dirname(filePath);
  const fileFormat = extname(filePath).slice(1).toLowerCase();
  // Edition = folder + quality. So the same album at multiple qualities — even
  // FLAC and MP3 sitting side by side in ONE folder — becomes separate album
  // entries, instead of one album with every track listed twice.
  const editionKey = `${albumDir.toLowerCase()}|${fileFormat}|${format.sampleRate ?? ''}|${format.bitsPerSample ?? ''}`;
  const albumKey = `${artistId}:${albumTitle.toLowerCase()}:${editionKey}`;
  let albumId = albumCache.get(albumKey);
  if (!albumId) {
    albumId = uuid();
    albumCache.set(albumKey, albumId);
    const db = getDb();
    const existing = db
      .select()
      .from(albums)
      .where(
        and(
          // NOCASE for the same reason as the artist lookup: mixed-case album
          // tags across files/scans must not spawn duplicate album rows.
          sql`${albums.title} = ${albumTitle} COLLATE NOCASE`,
          eq(albums.artistId, artistId),
          eq(albums.editionKey, editionKey),
        ),
      )
      .get();
    if (existing) {
      albumId = existing.id;
      albumCache.set(albumKey, albumId);
    } else {
      db.insert(albums)
        .values({
          id: albumId,
          title: albumTitle,
          artistId,
          artistName: albumArtistName,
          year: common.year,
          genre: common.genre?.[0],
          isCompilation,
          source: 'local',
          dirPath: albumDir,
          editionKey,
          format: fileFormat,
          sampleRate: format.sampleRate,
          bitDepth: format.bitsPerSample,
          mbid: albumMbid ?? null,
          releaseGroupMbid: releaseGroupMbid ?? null,
          label: label ?? null,
          catalogNumber: catalogNumber ?? null,
          releaseDate: releaseDate ?? null,
          originalYear: originalYear ?? null,
        })
        .run();
      scanStatus.albums++;
    }
  }

  // ReplayGain (per-track). music-metadata returns IRatio { ratio, dB }.
  // We store the dB value (player applies 10^(dB/20)) and the peak ratio
  // (used to clamp the gain so we don't clip when the track has hot peaks).
  const rgTrackGain = (common as { replaygain_track_gain?: { dB?: number } }).replaygain_track_gain
    ?.dB;
  const rgTrackPeak = (common as { replaygain_track_peak?: { ratio?: number } })
    .replaygain_track_peak?.ratio;
  const rgAlbumGain = (common as { replaygain_album_gain?: { dB?: number } }).replaygain_album_gain
    ?.dB;
  const rgAlbumPeak = (common as { replaygain_album_peak?: { ratio?: number } })
    .replaygain_album_peak?.ratio;

  const fingerprint = fingerprintOf({
    size: fileStat?.size ?? null,
    duration: format.duration,
    title: trackTitle,
    artistName,
    albumTitle,
    trackNumber: common.track?.no,
    discNumber: common.disk?.no ?? 1,
  });

  // Upsert track: known at this path → update; unknown → a moved file keeps
  // its identity (V06.2) when the fingerprint points at exactly one track
  // whose old file is gone; otherwise it is a new track.
  const db = getDb();
  let outcome: 'new' | 'updated' | 'relinked' | 'doubtful' = knownTrackId ? 'updated' : 'new';
  let targetTrackId = knownTrackId;
  if (!targetTrackId) {
    const candidate = findMoveCandidate(fingerprint, filePath);
    if (candidate === 'doubtful') outcome = 'doubtful';
    else if (candidate) {
      targetTrackId = candidate.id;
      outcome = 'relinked';
      logger.info(`Relinked moved file to existing track ${candidate.id}: ${filePath}`);
    }
  }
  const trackData = {
    title: trackTitle,
    albumId,
    albumTitle,
    artistId,
    artistName,
    artistNames: trackArtistNames.join(', ') || null,
    composer: composer ?? null,
    conductor: conductor ?? null,
    trackNumber: common.track?.no ?? undefined,
    discNumber: common.disk?.no ?? 1,
    duration: format.duration,
    format: extname(filePath).slice(1).toLowerCase(),
    sampleRate: format.sampleRate,
    bitDepth: format.bitsPerSample,
    replayGainTrack: rgTrackGain ?? null,
    replayGainTrackPeak: rgTrackPeak ?? null,
    mbid: recordingMbid ?? null,
    isrc: isrc ?? null,
    bpm: bpm ?? null,
    work: work ?? null,
    movement: movement ?? null,
    filePath,
    fileSize: fileStat?.size ?? null,
    fileMtime: fileStat ? Math.floor(fileStat.mtimeMs / 1000) : null,
    fingerprint,
    scanVersion: SCAN_VERSION,
    availability: 'available',
    missingSince: null,
    source: 'local' as const,
    updatedAt: new Date(),
  };

  if (targetTrackId) {
    db.update(tracks).set(trackData).where(eq(tracks.id, targetTrackId)).run();
  } else {
    targetTrackId = uuid();
    db.insert(tracks)
      .values({ id: targetTrackId, ...trackData })
      .run();
  }

  // Who is on this track, and under which genres it files (R03.2). Both are
  // replaced per track, so a corrected tag takes the old answer with it.
  writeCredits(targetTrackId, credits, (name) => upsertArtist(name));
  writeGenres(targetTrackId, albumId, genres);

  // Album-level RG: prefer the value embedded in the file (every track on the
  // same album should carry the identical album_gain tag). We write it every
  // time so the latest-scanned track wins — fine because the value is the
  // same across the album.
  if (rgAlbumGain !== undefined || rgAlbumPeak !== undefined) {
    db.update(albums)
      .set({
        replayGainAlbum: rgAlbumGain ?? null,
        replayGainAlbumPeak: rgAlbumPeak ?? null,
      })
      .where(eq(albums.id, albumId))
      .run();
  }

  // A cover file next to the music is usually the full-size scan, so it wins
  // over the embedded thumbnail (R03.2).
  const fromFolder = folderCover(albumDir);
  if (fromFolder) {
    cacheEmbeddedCover(albumId, fromFolder.data, fromFolder.mime);
  } else {
    const cover = selectCover(common.picture);
    if (cover) {
      cacheEmbeddedCover(albumId, Buffer.from(cover.data), cover.format || 'image/jpeg');
    }
  }

  // Update album track count
  const trackCountResult = db.select().from(tracks).where(eq(tracks.albumId, albumId)).all();
  db.update(albums)
    .set({
      trackCount: trackCountResult.length,
      artistName: albumArtistName,
      year: common.year,
      genre: common.genre?.[0],
      isCompilation,
      updatedAt: new Date(),
    })
    .where(eq(albums.id, albumId))
    .run();
  // Identity the tags provide is filled in, never overwritten with nothing:
  // one untagged track on an identified album must not erase its MBID.
  claimAlbumIdentity(albumId, {
    mbid: albumMbid,
    releaseGroupMbid,
    label,
    catalogNumber,
    releaseDate,
    originalYear,
  });
  return outcome;
}

function normalizePeople(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw
    .flatMap((item) => item.split(/\s*(?:;|\/)\s*/))
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * "feat." and friends mark a guest, so the name behind one is a FEATURED
 * artist rather than part of the act (R03.2). The display name is never
 * rewritten — `artist_name` keeps reading exactly as the tag does — this only
 * decides who gets a row and in which role.
 *
 * Deliberately NOT split on "&" or "and": "Simon & Garfunkel", "Earth, Wind &
 * Fire" and "Nick Cave and the Bad Seeds" are one act each, and a library full
 * of half-artists would be worse than no split at all. A tag that really means
 * two acts almost always separates them with ";" or "/", which is split above.
 */
const FEATURE_SPLIT = /\s+(?:feat\.?|ft\.?|featuring|with)\s+/i;

export function splitFeatured(names: string[]): { main: string[]; featured: string[] } {
  const main: string[] = [];
  const featured: string[] = [];
  for (const name of names) {
    const parts = name
      .split(FEATURE_SPLIT)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    main.push(parts[0]);
    featured.push(...parts.slice(1));
  }
  return {
    main: dedupeNames(main),
    featured: dedupeNames(featured).filter((name) => !main.some((m) => sameName(m, name))),
  };
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** A role on a track, in the order the tags listed it (R03.1 schema). */
export type CreditRole = 'main' | 'featured' | 'composer' | 'conductor' | 'performer' | 'producer';

interface Credit {
  name: string;
  role: CreditRole;
  position: number;
}

/**
 * Everyone the tags name, with their capacity. One artist can hold several
 * roles on one track (a composer who also conducts), which is why the key of
 * `track_artists` includes the role.
 */
function creditsFromTags(common: Record<string, unknown>): Credit[] {
  const credits: Credit[] = [];
  const add = (names: string[], role: CreditRole) => {
    names.forEach((name, index) => credits.push({ name, role, position: index }));
  };
  const trackArtists = normalizePeople(
    (common.artists as string[] | undefined) ?? (common.artist as string | undefined),
  );
  const { main, featured } = splitFeatured(trackArtists);
  add(main, 'main');
  add(featured, 'featured');
  add(normalizePeople(common.composer as string[] | undefined), 'composer');
  add(normalizePeople(common.conductor as string[] | undefined), 'conductor');
  // "performer:instrument" is how Vorbis and ID3 name a player on a track.
  add(normalizePeople(common['performer:instrument'] as string[] | undefined), 'performer');
  add(normalizePeople(common.producer as string[] | undefined), 'producer');
  return credits;
}

/** The year inside a date tag, which may be "1973", "1973-05" or "1973-05-25". */
function yearFromDate(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d{4})/);
  return match ? Number(match[1]) : undefined;
}

/** The first value of a tag that formats model as a list. */
function firstOf(value: string[] | string | undefined): string | undefined {
  if (Array.isArray(value)) return value.find((item) => item.trim())?.trim();
  return value?.trim() || undefined;
}

/** Every genre the file names, deduplicated, as a set for facets (R03.1). */
function genresFromTags(value: string[] | undefined): string[] {
  return dedupeNames(
    (value ?? [])
      .flatMap((item) => item.split(/\s*(?:;|\/|,)\s*/))
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/** Cover files a ripper leaves next to the music, in the order we trust them. */
const COVER_FILE_NAMES = ['folder.jpg', 'cover.jpg', 'front.jpg', 'folder.png', 'cover.png'];

const COVER_MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.png': 'image/png' };

/**
 * A cover file next to the music wins over the embedded picture (R03.2): it is
 * usually the full-size scan, where the embedded one is a thumbnail the ripper
 * squeezed into every track.
 */
function folderCover(albumDir: string): { data: Buffer; mime: string } | null {
  for (const name of COVER_FILE_NAMES) {
    const candidate = join(albumDir, name);
    if (!existsSync(candidate)) continue;
    try {
      return {
        data: readFileSync(candidate),
        mime: COVER_MIME[extname(name).toLowerCase()] ?? 'image/jpeg',
      };
    } catch (err) {
      logger.debug(`Scanner: could not read ${candidate}: ${err}`);
    }
  }
  return null;
}

/**
 * Everyone on this track, as rows (R03.2). The set is replaced rather than
 * added to, so a corrected tag removes the person it no longer names.
 */
function writeCredits(trackId: string, credits: Credit[], artistIdFor: (name: string) => string) {
  const db = getRawDb();
  db.prepare('DELETE FROM track_artists WHERE track_id = ?').run(trackId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO track_artists (track_id, artist_id, role, position)
     VALUES (?, ?, ?, ?)`,
  );
  for (const credit of credits) {
    insert.run(trackId, artistIdFor(credit.name), credit.role, credit.position);
  }
}

function writeGenres(trackId: string, albumId: string, genres: string[]): void {
  const db = getRawDb();
  db.prepare('DELETE FROM track_genres WHERE track_id = ?').run(trackId);
  const insertTrack = db.prepare(
    'INSERT OR IGNORE INTO track_genres (track_id, genre) VALUES (?, ?)',
  );
  // Album genres accumulate across the album's tracks: a compilation is
  // several genres, and no single track decides for the album.
  const insertAlbum = db.prepare(
    'INSERT OR IGNORE INTO album_genres (album_id, genre) VALUES (?, ?)',
  );
  for (const genre of genres) {
    insertTrack.run(trackId, genre);
    insertAlbum.run(albumId, genre);
  }
}

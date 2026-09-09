import { readdir, stat } from 'node:fs/promises';
import { existsSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, basename, dirname } from 'path';
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
 */
export const SCAN_VERSION = 2;

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

  // Upsert artist
  const artistKey = albumArtistName.toLowerCase();
  let artistId = artistCache.get(artistKey);
  if (!artistId) {
    artistId = uuid();
    artistCache.set(artistKey, artistId);
    const db = getDb();
    // COLLATE NOCASE: the in-scan cache key is lowercased, but a fresh scan
    // starts with an empty cache — a case-sensitive lookup would then miss
    // "ABBA" when this file is tagged "Abba" and create a duplicate artist.
    const existing = db
      .select()
      .from(artists)
      .where(sql`${artists.name} = ${albumArtistName} COLLATE NOCASE`)
      .get();
    if (existing) {
      artistId = existing.id;
      artistCache.set(artistKey, artistId);
    } else {
      db.insert(artists).values({ id: artistId, name: albumArtistName, source: 'local' }).run();
      scanStatus.artists++;
    }
  }

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
    db.insert(tracks)
      .values({ id: uuid(), ...trackData })
      .run();
  }

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

  const cover = selectCover(common.picture);
  if (cover) {
    cacheEmbeddedCover(albumId, Buffer.from(cover.data), cover.format || 'image/jpeg');
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
  return outcome;
}

function normalizePeople(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw
    .flatMap((item) => item.split(/\s*(?:;|\/)\s*/))
    .map((item) => item.trim())
    .filter(Boolean);
}

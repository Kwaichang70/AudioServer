import { getRawDb } from '../db/index.js';
import { logger } from '../logger.js';
import { providers } from '../providers/registry.js';
import { addQobuzAlbum, removeQobuzAlbum, QobuzLibraryError } from './qobuz-library.js';
import { QobuzProviderError } from '../providers/qobuz.js';

/**
 * Library ⇄ Qobuz favourites (R07.2).
 *
 * Adding a Qobuz album to the library makes it a Qobuz favourite, and a
 * Qobuz favourite you add on your phone appears in the library. A three-way
 * merge against what the previous sync agreed on tells which side changed:
 *
 *   in Qobuz, not seen before        → new on Qobuz: add to the library
 *   in the library, not seen before  → new here (or a push that failed): favourite it on Qobuz
 *   seen before, gone from library   → removed here (you confirmed): unfavourite on Qobuz
 *   seen before, gone from Qobuz     → removed there: NOT removed here — it waits
 *                                       for you to confirm (or keep it)
 *
 * The server has one Qobuz login, so "your Qobuz favourites" are that
 * account's. Titles Qobuz withdraws are marked 'unavailable' by
 * `refreshQobuzAvailability`, shown dimmed like a missing file.
 */

type State = 'synced' | 'removed_on_qobuz' | 'library_only';

export interface QobuzSyncDeps {
  ready: () => boolean;
  fetchFavorites: () => Promise<string[]>;
  setFavorite: (albumId: string, favorite: boolean) => Promise<void>;
  addAlbum: (albumId: string) => Promise<unknown>;
  fetchAlbum: typeof providers.qobuz.fetchAlbumForLibrary;
  now: () => number;
}

const defaults = (): QobuzSyncDeps => ({
  ready: () => providers.qobuz.getStatus().authenticated,
  fetchFavorites: () => providers.qobuz.fetchFavoriteAlbumIds(),
  setFavorite: (id, favorite) => providers.qobuz.setFavoriteAlbum(id, favorite),
  addAlbum: (id) => addQobuzAlbum(id),
  fetchAlbum: (id) => providers.qobuz.fetchAlbumForLibrary(id),
  now: () => Math.floor(Date.now() / 1000),
});

let deps = defaults();

export function configureQobuzSync(overrides: Partial<QobuzSyncDeps>): void {
  deps = { ...defaults(), ...overrides };
}

export function resetQobuzSync(): void {
  deps = defaults();
  lastResult = null;
}

export interface QobuzSyncResult {
  at: number;
  addedToLibrary: string[];
  favoritedOnQobuz: string[];
  unfavoritedOnQobuz: string[];
  /** Removed from your Qobuz favourites; still in the library until you decide. */
  removedOnQobuz: string[];
  errors: string[];
}

let lastResult: QobuzSyncResult | null = null;
let running: Promise<QobuzSyncResult | null> | null = null;

const db = () => getRawDb();

function libraryAlbums(): Set<string> {
  return new Set(
    (
      db().prepare("SELECT id FROM albums WHERE source = 'qobuz'").all() as Array<{ id: string }>
    ).map((r) => r.id),
  );
}

function syncStates(): Map<string, State> {
  return new Map(
    (
      db().prepare('SELECT album_id, state FROM qobuz_album_sync').all() as Array<{
        album_id: string;
        state: State;
      }>
    ).map((r) => [r.album_id, r.state]),
  );
}

function setState(albumId: string, state: State | null): void {
  if (state === null) {
    db().prepare('DELETE FROM qobuz_album_sync WHERE album_id = ?').run(albumId);
    return;
  }
  db()
    .prepare(
      `INSERT INTO qobuz_album_sync (album_id, state, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(album_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    )
    .run(albumId, state, deps.now());
}

/** Run one sync. Not signed in to Qobuz: nothing happens, nothing is lost. */
export function syncQobuzFavorites(): Promise<QobuzSyncResult | null> {
  if (running) return running;
  running = runSync().finally(() => {
    running = null;
  });
  return running;
}

async function runSync(): Promise<QobuzSyncResult | null> {
  if (!deps.ready()) return null;
  const result: QobuzSyncResult = {
    at: deps.now(),
    addedToLibrary: [],
    favoritedOnQobuz: [],
    unfavoritedOnQobuz: [],
    removedOnQobuz: [],
    errors: [],
  };
  let favorites: Set<string>;
  try {
    favorites = new Set(await deps.fetchFavorites());
  } catch (err) {
    result.errors.push(`Could not read the Qobuz favourites: ${String(err)}`);
    lastResult = result;
    return result;
  }
  const library = libraryAlbums();
  const states = syncStates();

  // New on Qobuz → into the library.
  for (const id of favorites) {
    if (library.has(id)) {
      setState(id, 'synced');
      continue;
    }
    if (states.has(id)) {
      // Seen before and gone from the library: you removed it here.
      try {
        await deps.setFavorite(id, false);
        result.unfavoritedOnQobuz.push(id);
        setState(id, null);
      } catch (err) {
        result.errors.push(`${id}: ${String(err)}`);
      }
      continue;
    }
    try {
      await deps.addAlbum(id);
      result.addedToLibrary.push(id);
      setState(id, 'synced');
    } catch (err) {
      // A favourite Qobuz no longer streams is not added; it is reported.
      result.errors.push(
        `${id}: ${err instanceof QobuzLibraryError || err instanceof QobuzProviderError ? err.message : String(err)}`,
      );
    }
  }

  for (const id of library) {
    if (favorites.has(id)) continue;
    const state = states.get(id);
    if (state === 'synced' || state === 'removed_on_qobuz') {
      // Gone from the Qobuz favourites: ask, do not delete.
      setState(id, 'removed_on_qobuz');
      result.removedOnQobuz.push(id);
    } else if (state === 'library_only') {
      // You chose to keep it without the favourite.
    } else {
      // Added here (or an earlier push failed): favourite it on Qobuz.
      try {
        await deps.setFavorite(id, true);
        result.favoritedOnQobuz.push(id);
        setState(id, 'synced');
      } catch (err) {
        result.errors.push(`${id}: ${String(err)}`);
      }
    }
  }
  // States for albums that are in neither place any more.
  for (const id of states.keys()) {
    if (!library.has(id) && !favorites.has(id)) setState(id, null);
  }

  lastResult = result;
  const changed =
    result.addedToLibrary.length +
    result.favoritedOnQobuz.length +
    result.unfavoritedOnQobuz.length;
  if (changed > 0 || result.removedOnQobuz.length > 0) {
    logger.info(
      `Qobuz sync: +${result.addedToLibrary.length} to library, +${result.favoritedOnQobuz.length}/-${result.unfavoritedOnQobuz.length} on Qobuz, ${result.removedOnQobuz.length} waiting for a decision`,
    );
  }
  return result;
}

/** Right after "Add to library": favourite it on Qobuz now (best effort). */
export async function afterAdd(albumId: string): Promise<'synced' | 'pending'> {
  if (!deps.ready()) return 'pending';
  try {
    await deps.setFavorite(albumId, true);
    setState(albumId, 'synced');
    return 'synced';
  } catch (err) {
    logger.warn(`Qobuz sync: could not favourite ${albumId} now, the next sync retries: ${err}`);
    return 'pending';
  }
}

/** Right after you confirmed "Remove from library": unfavourite on Qobuz. */
export async function afterRemove(albumId: string): Promise<'synced' | 'pending'> {
  if (!deps.ready()) return 'pending';
  try {
    await deps.setFavorite(albumId, false);
    setState(albumId, null);
    return 'synced';
  } catch (err) {
    logger.warn(`Qobuz sync: could not unfavourite ${albumId} now, the next sync retries: ${err}`);
    return 'pending';
  }
}

/** Your decision about an album removed from the Qobuz favourites. */
export function resolveRemovedOnQobuz(albumId: string, decision: 'remove' | 'keep'): boolean {
  const state = syncStates().get(albumId);
  if (state !== 'removed_on_qobuz') return false;
  if (decision === 'remove') {
    removeQobuzAlbum(albumId);
    setState(albumId, null);
  } else {
    setState(albumId, 'library_only');
  }
  return true;
}

export function qobuzSyncStatus(): {
  last: QobuzSyncResult | null;
  waiting: Array<{ id: string; title: string; artistName: string }>;
} {
  const waiting = db()
    .prepare(
      `SELECT a.id, a.title, a.artist_name as artistName FROM qobuz_album_sync s
         JOIN albums a ON a.id = s.album_id
        WHERE s.state = 'removed_on_qobuz' ORDER BY a.artist_name, a.title`,
    )
    .all() as Array<{ id: string; title: string; artistName: string }>;
  return { last: lastResult, waiting };
}

/**
 * Titles Qobuz withdrew become 'unavailable' (and come back to 'streaming'
 * when Qobuz offers them again). One album at a time, politely.
 */
export async function refreshQobuzAvailability(): Promise<{
  checked: number;
  unavailable: number;
}> {
  if (!deps.ready()) return { checked: 0, unavailable: 0 };
  const albums = [...libraryAlbums()];
  let unavailable = 0;
  const mark = db().prepare('UPDATE tracks SET availability = ? WHERE id = ?');
  for (const albumId of albums) {
    const local = db().prepare('SELECT id FROM tracks WHERE album_id = ?').all(albumId) as Array<{
      id: string;
    }>;
    let offered = new Map<string, boolean>();
    try {
      const { album, tracks } = await deps.fetchAlbum(albumId);
      offered = new Map(tracks.map((t) => [t.id, album.streamable && t.streamable]));
    } catch (err) {
      if (!(err instanceof QobuzProviderError) || err.statusCode !== 404) {
        // Qobuz unreachable or signed out: change nothing.
        continue;
      }
      // 404: the album is gone from Qobuz; every track is unavailable.
    }
    for (const row of local) {
      const ok = offered.get(row.id) === true;
      if (!ok) unavailable++;
      mark.run(ok ? 'streaming' : 'unavailable', row.id);
    }
  }
  return { checked: albums.length, unavailable };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Sync at start and every six hours; availability once a day. */
export function startQobuzSync(): void {
  if (timer) return;
  let ticks = 0;
  const tick = () => {
    void syncQobuzFavorites().catch((err) => logger.warn(`Qobuz sync failed: ${err}`));
    if (ticks++ % 4 === 0) {
      void refreshQobuzAvailability().catch((err) =>
        logger.warn(`Qobuz availability check failed: ${err}`),
      );
    }
  };
  setTimeout(tick, 30_000).unref?.();
  timer = setInterval(tick, 6 * 60 * 60 * 1000);
  timer.unref?.();
}

export function stopQobuzSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

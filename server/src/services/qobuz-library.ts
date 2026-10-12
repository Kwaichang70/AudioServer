import { getRawDb } from '../db/index.js';
import { providers } from '../providers/registry.js';
import type { Album, Track } from '@audioserver/shared';

/**
 * Qobuz in the collection (R07.1).
 *
 * "Add to library" stores a Qobuz album or track as ordinary library rows,
 * so it sits between your own albums, plays in every room and survives a
 * stream that is briefly away:
 *
 * - the row id is the provider id (`qobuz:123`) — every player, the queue
 *   and the client already route by that prefix, and adding twice gives the
 *   same rows instead of a copy;
 * - `source = 'qobuz'`, `source_ref = 'qobuz:album:123'` says where it came
 *   from; tracks are `availability = 'streaming'` (or 'unavailable' when
 *   Qobuz withdrew them);
 * - title, artist, cover and quality are a snapshot: the library shows them
 *   without asking Qobuz. Only playing asks Qobuz, for a fresh stream URL.
 *
 * The scanner never touches these rows: it only marks local tracks missing,
 * and only prunes local albums.
 */

export class QobuzLibraryError extends Error {
  constructor(
    public code: 'withdrawn' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'QobuzLibraryError';
  }
}

interface QobuzLibraryDeps {
  fetchAlbum: (id: string) => ReturnType<typeof providers.qobuz.fetchAlbumForLibrary>;
  fetchTrack: (id: string) => ReturnType<typeof providers.qobuz.fetchTrackForLibrary>;
  now: () => number;
}

const defaultDeps = (): QobuzLibraryDeps => ({
  fetchAlbum: (id) => providers.qobuz.fetchAlbumForLibrary(id),
  fetchTrack: (id) => providers.qobuz.fetchTrackForLibrary(id),
  now: () => Math.floor(Date.now() / 1000),
});

let deps: QobuzLibraryDeps = defaultDeps();

/** Tests replace the Qobuz calls; nothing here needs a network otherwise. */
export function configureQobuzLibrary(overrides: Partial<QobuzLibraryDeps>): void {
  deps = { ...defaultDeps(), ...overrides };
}

export function resetQobuzLibrary(): void {
  deps = defaultDeps();
}

const bare = (id: string) => id.replace(/^qobuz:/, '');
const qid = (id: string) => (id.startsWith('qobuz:') ? id : `qobuz:${id}`);

/**
 * The library artist for a Qobuz artist: the one you already have by that
 * name (so Miles Davis is one artist whether the album is a file or a
 * stream), otherwise a new row carrying the Qobuz id.
 */
function resolveArtist(qobuzArtistId: string, name: string): string {
  const db = getRawDb();
  const existing = db.prepare('SELECT id FROM artists WHERE name = ? COLLATE NOCASE').get(name) as
    | { id: string }
    | undefined;
  if (existing) return existing.id;
  const raw = bare(qobuzArtistId);
  const id = raw ? `qobuz:${raw}` : `qobuz:artist:${name.toLowerCase()}`;
  db.prepare(
    `INSERT INTO artists (id, name, source, source_ref, created_at, updated_at)
     VALUES (?, ?, 'qobuz', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(id, name, raw ? `qobuz:artist:${raw}` : null, deps.now(), deps.now());
  return id;
}

function writeAlbum(album: Album & { label?: string }, artistId: string): void {
  const db = getRawDb();
  const id = qid(album.id);
  const t = deps.now();
  db.prepare(
    `INSERT INTO albums (id, title, artist_id, artist_name, year, genre, cover_url, track_count,
                         format, sample_rate, bit_depth, label, source, source_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'flac', ?, ?, ?, 'qobuz', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, artist_id = excluded.artist_id, artist_name = excluded.artist_name,
       year = excluded.year, genre = excluded.genre, cover_url = excluded.cover_url,
       sample_rate = excluded.sample_rate, bit_depth = excluded.bit_depth, label = excluded.label,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    album.title,
    artistId,
    album.artistName,
    album.year ?? null,
    album.genre ?? null,
    album.coverUrl ?? null,
    album.sampleRate ?? null,
    album.bitDepth ?? null,
    album.label ?? null,
    `qobuz:album:${bare(album.id)}`,
    t,
    t,
  );
  if (album.genre) {
    db.prepare('INSERT OR IGNORE INTO album_genres (album_id, genre) VALUES (?, ?)').run(
      id,
      album.genre,
    );
  }
}

function writeTrack(
  track: Track & { streamable: boolean },
  album: Album,
  albumArtistId: string,
): void {
  const db = getRawDb();
  const artistId =
    track.artistName && track.artistName.toLowerCase() !== album.artistName.toLowerCase()
      ? resolveArtist(track.artistId, track.artistName)
      : albumArtistId;
  const t = deps.now();
  db.prepare(
    `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, track_number,
                         disc_number, duration, format, sample_rate, bit_depth, cover_url, source,
                         availability, source_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'flac', ?, ?, ?, 'qobuz', ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, album_id = excluded.album_id, album_title = excluded.album_title,
       artist_id = excluded.artist_id, artist_name = excluded.artist_name,
       track_number = excluded.track_number, disc_number = excluded.disc_number,
       duration = excluded.duration, sample_rate = excluded.sample_rate,
       bit_depth = excluded.bit_depth, cover_url = excluded.cover_url,
       availability = excluded.availability, updated_at = excluded.updated_at`,
  ).run(
    qid(track.id),
    track.version ? `${track.title} (${track.version})` : track.title,
    qid(album.id),
    album.title,
    artistId,
    track.artistName || album.artistName,
    track.trackNumber ?? null,
    track.discNumber ?? 1,
    track.duration ?? null,
    track.sampleRate ?? null,
    track.bitDepth ?? null,
    album.coverUrl ?? null,
    track.streamable ? 'streaming' : 'unavailable',
    `qobuz:track:${bare(track.id)}`,
    t,
    t,
  );
}

function refreshTrackCount(albumId: string): number {
  const db = getRawDb();
  const n = (
    db.prepare('SELECT COUNT(*) as n FROM tracks WHERE album_id = ?').get(albumId) as {
      n: number;
    }
  ).n;
  db.prepare('UPDATE albums SET track_count = ? WHERE id = ?').run(n, albumId);
  return n;
}

export interface AddedToLibrary {
  albumId: string;
  title: string;
  artistName: string;
  trackCount: number;
}

/** Add a whole Qobuz album. Adding again refreshes its snapshot. */
export async function addQobuzAlbum(albumId: string): Promise<AddedToLibrary> {
  const { album, tracks } = await deps.fetchAlbum(albumId);
  if (!album.streamable || tracks.length === 0) {
    throw new QobuzLibraryError('withdrawn', `Qobuz does not offer “${album.title}” for streaming`);
  }
  const db = getRawDb();
  let trackCount = 0;
  db.transaction(() => {
    const artistId = resolveArtist(album.artistId, album.artistName);
    writeAlbum(album, artistId);
    for (const track of tracks) writeTrack(track, album, artistId);
    trackCount = refreshTrackCount(qid(album.id));
  })();
  return { albumId: qid(album.id), title: album.title, artistName: album.artistName, trackCount };
}

/**
 * Add one Qobuz track. It comes with its album row — holding only the tracks
 * you added, as Roon shows a partly collected album.
 */
export async function addQobuzTrack(trackId: string): Promise<AddedToLibrary> {
  const track = await deps.fetchTrack(trackId);
  if (!track.album)
    throw new QobuzLibraryError('not_found', 'Qobuz did not say which album this is');
  if (!track.streamable) {
    throw new QobuzLibraryError('withdrawn', `Qobuz does not offer “${track.title}” for streaming`);
  }
  const album = track.album;
  let trackCount = 0;
  getRawDb().transaction(() => {
    const artistId = resolveArtist(album.artistId, album.artistName);
    writeAlbum(album, artistId);
    writeTrack(track, album, artistId);
    trackCount = refreshTrackCount(qid(album.id));
  })();
  return { albumId: qid(album.id), title: album.title, artistName: album.artistName, trackCount };
}

/**
 * Take a Qobuz album out of the library — never a local one. Its personal
 * marks (favourites, tags, ratings) go with it; listening history keeps its
 * own snapshot, as it does for a purged file.
 */
export function removeQobuzAlbum(albumId: string): boolean {
  const db = getRawDb();
  const album = db
    .prepare("SELECT id, artist_id FROM albums WHERE id = ? AND source = 'qobuz'")
    .get(albumId) as { id: string; artist_id: string } | undefined;
  if (!album) return false;
  db.transaction(() => {
    const trackIds = (
      db.prepare('SELECT id FROM tracks WHERE album_id = ?').all(album.id) as Array<{ id: string }>
    ).map((r) => r.id);
    const forget = (type: string, id: string) => {
      db.prepare('DELETE FROM favorites WHERE item_type = ? AND item_id = ?').run(type, id);
      db.prepare('DELETE FROM tag_items WHERE item_type = ? AND item_id = ?').run(type, id);
      db.prepare('DELETE FROM ratings WHERE item_type = ? AND item_id = ?').run(type, id);
    };
    for (const id of trackIds) forget('track', id);
    forget('album', album.id);
    db.prepare('DELETE FROM tracks WHERE album_id = ?').run(album.id);
    db.prepare('DELETE FROM album_genres WHERE album_id = ?').run(album.id);
    db.prepare('DELETE FROM albums WHERE id = ?').run(album.id);
    // A Qobuz-only artist with nothing left goes too; a local artist stays.
    db.prepare(
      `DELETE FROM artists WHERE source = 'qobuz' AND id = ?
          AND NOT EXISTS (SELECT 1 FROM albums WHERE artist_id = artists.id)
          AND NOT EXISTS (SELECT 1 FROM tracks WHERE artist_id = artists.id)`,
    ).run(album.artist_id);
  })();
  return true;
}

/** Which of these Qobuz album ids are in the library — for "Added ✓" buttons. */
export function qobuzAlbumsInLibrary(ids: string[]): string[] {
  if (ids.length === 0) return [];
  const list = ids.slice(0, 200).map(qid);
  return (
    getRawDb()
      .prepare(
        `SELECT id FROM albums WHERE source = 'qobuz' AND id IN (${list.map(() => '?').join(',')})`,
      )
      .all(...list) as Array<{ id: string }>
  ).map((r) => r.id);
}

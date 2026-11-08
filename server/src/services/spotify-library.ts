import { getRawDb } from '../db/index.js';
import { providers } from '../providers/registry.js';
import type { Album, Track } from '@audioserver/shared';
import { removeStreamingAlbum } from './qobuz-library.js';

/**
 * Spotify albums in the collection, added one by one ("Add to library"), as
 * Qobuz albums are (R07.1): ordinary library rows with the Spotify id
 * (`spotify:…`), `source = 'spotify'` and tracks `availability = 'streaming'`.
 * Title, artist and cover are a snapshot, so the library shows them without
 * asking Spotify.
 *
 * Spotify gives no audio, so these tracks play through Spotify Connect: in a
 * room the speaker plays the whole album itself (services/spotify-rooms.ts),
 * in the browser the Spotify player does. The scanner never touches them.
 */

export class SpotifyLibraryError extends Error {
  constructor(
    public code: 'not_found' | 'not_connected',
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyLibraryError';
  }
}

interface Deps {
  fetchAlbum: (id: string) => Promise<{ album: Album; tracks: Track[] }>;
  connected: () => boolean;
  now: () => number;
}

const defaultDeps = (): Deps => ({
  fetchAlbum: (id) => providers.spotify.fetchAlbumForLibrary(id),
  connected: () => providers.spotify.auth.isAuthenticated,
  now: () => Math.floor(Date.now() / 1000),
});

let deps: Deps = defaultDeps();

/** Tests replace the Spotify calls. */
export function configureSpotifyLibrary(overrides: Partial<Deps>): void {
  deps = { ...defaultDeps(), ...overrides };
}

export function resetSpotifyLibrary(): void {
  deps = defaultDeps();
}

const bare = (id: string) => id.replace(/^spotify:/, '');
const sid = (id: string) => (id.startsWith('spotify:') ? id : `spotify:${id}`);

/** The artist you already have by that name, otherwise a Spotify artist row. */
function resolveArtist(spotifyArtistId: string, name: string): string {
  const db = getRawDb();
  const existing = db.prepare('SELECT id FROM artists WHERE name = ? COLLATE NOCASE').get(name) as
    { id: string } | undefined;
  if (existing) return existing.id;
  const raw = bare(spotifyArtistId);
  const id = raw ? `spotify:${raw}` : `spotify:artist:${name.toLowerCase()}`;
  db.prepare(
    `INSERT INTO artists (id, name, source, source_ref, created_at, updated_at)
     VALUES (?, ?, 'spotify', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  ).run(id, name, raw ? `spotify:artist:${raw}` : null, deps.now(), deps.now());
  return id;
}

export interface AddedToLibrary {
  albumId: string;
  title: string;
  artistName: string;
  trackCount: number;
}

/** Add a whole Spotify album. Adding again refreshes its snapshot. */
export async function addSpotifyAlbum(albumId: string): Promise<AddedToLibrary> {
  if (!deps.connected()) {
    throw new SpotifyLibraryError('not_connected', 'Spotify is not connected');
  }
  const { album, tracks } = await deps.fetchAlbum(albumId);
  if (tracks.length === 0) {
    throw new SpotifyLibraryError('not_found', `Spotify returned no tracks for “${album.title}”`);
  }
  const db = getRawDb();
  const id = sid(album.id);
  const t = deps.now();
  db.transaction(() => {
    const artistId = resolveArtist(album.artistId, album.artistName);
    db.prepare(
      `INSERT INTO albums (id, title, artist_id, artist_name, year, cover_url, track_count,
                           source, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'spotify', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, artist_id = excluded.artist_id, artist_name = excluded.artist_name,
         year = excluded.year, cover_url = excluded.cover_url, track_count = excluded.track_count,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      album.title,
      artistId,
      album.artistName,
      album.year ?? null,
      album.coverUrl ?? null,
      tracks.length,
      `spotify:album:${bare(album.id)}`,
      t,
      t,
    );
    const write = db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_title, artist_id, artist_name, track_number,
                           disc_number, duration, cover_url, source, availability, source_ref,
                           created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'spotify', 'streaming', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, album_id = excluded.album_id, album_title = excluded.album_title,
         artist_id = excluded.artist_id, artist_name = excluded.artist_name,
         track_number = excluded.track_number, disc_number = excluded.disc_number,
         duration = excluded.duration, cover_url = excluded.cover_url,
         updated_at = excluded.updated_at`,
    );
    for (const track of tracks) {
      const trackArtist =
        track.artistName && track.artistName.toLowerCase() !== album.artistName.toLowerCase()
          ? resolveArtist(track.artistId, track.artistName)
          : artistId;
      write.run(
        sid(track.id),
        track.title,
        id,
        album.title,
        trackArtist,
        track.artistName || album.artistName,
        track.trackNumber ?? null,
        track.discNumber ?? 1,
        track.duration ?? null,
        album.coverUrl ?? null,
        `spotify:track:${bare(track.id)}`,
        t,
        t,
      );
    }
  })();
  return {
    albumId: id,
    title: album.title,
    artistName: album.artistName,
    trackCount: tracks.length,
  };
}

export function removeSpotifyAlbum(albumId: string): boolean {
  return removeStreamingAlbum(sid(albumId), 'spotify');
}

/** Which of these Spotify album ids are in the library — for "In library ✓". */
export function spotifyAlbumsInLibrary(ids: string[]): string[] {
  if (ids.length === 0) return [];
  const list = ids.slice(0, 200).map(sid);
  return (
    getRawDb()
      .prepare(
        `SELECT id FROM albums WHERE source = 'spotify' AND id IN (${list.map(() => '?').join(',')})`,
      )
      .all(...list) as Array<{ id: string }>
  ).map((r) => r.id);
}

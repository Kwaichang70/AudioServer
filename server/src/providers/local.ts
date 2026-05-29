import type { MusicProvider } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults } from '@audioserver/shared';
import { getDb, getRawDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { eq, like, or } from 'drizzle-orm';

/**
 * Local filesystem music provider.
 * Reads from the SQLite database populated by the scanner service.
 */
export class LocalProvider implements MusicProvider {
  readonly type = 'local' as const;
  readonly name = 'Local Library';
  isAvailable = true;

  async initialize(): Promise<void> {
    // DB is initialized separately
  }

  async dispose(): Promise<void> {
    // Nothing to clean up
  }

  async getArtists(page = 1, pageSize = 50) {
    const raw = getRawDb();
    const offset = (Math.max(1, page) - 1) * pageSize;
    const total = (raw.prepare('SELECT COUNT(*) as count FROM artists').get() as { count: number })
      .count;
    const items = raw
      .prepare(
        `
      SELECT id, name, image_url as imageUrl, source, created_at as createdAt, updated_at as updatedAt
      FROM artists
      ORDER BY name COLLATE NOCASE
      LIMIT ? OFFSET ?
    `,
      )
      .all(pageSize, offset) as Artist[];
    return { items, total };
  }

  async getArtist(id: string) {
    const db = getDb();
    return (db.select().from(artists).where(eq(artists.id, id)).get() as Artist) || null;
  }

  async getAlbums(page = 1, pageSize = 50) {
    const raw = getRawDb();
    const offset = (Math.max(1, page) - 1) * pageSize;
    const total = (raw.prepare('SELECT COUNT(*) as count FROM albums').get() as { count: number })
      .count;
    const items = raw
      .prepare(
        `
      SELECT id, title, artist_id as artistId, artist_name as artistName, year,
        cover_url as coverUrl, genre, track_count as trackCount,
        replay_gain_album as replayGainAlbum, replay_gain_album_peak as replayGainAlbumPeak,
        source, created_at as createdAt, updated_at as updatedAt
      FROM albums
      ORDER BY title COLLATE NOCASE
      LIMIT ? OFFSET ?
    `,
      )
      .all(pageSize, offset) as Album[];
    return { items, total };
  }

  async getAlbum(id: string) {
    const db = getDb();
    return (db.select().from(albums).where(eq(albums.id, id)).get() as Album) || null;
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    const db = getDb();
    return db
      .select()
      .from(tracks)
      .where(eq(tracks.albumId, albumId))
      .orderBy(tracks.discNumber, tracks.trackNumber)
      .all() as Track[];
  }

  async getArtistAlbums(artistId: string): Promise<Album[]> {
    const db = getDb();
    return db.select().from(albums).where(eq(albums.artistId, artistId)).all() as Album[];
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    const db = getDb();
    const pattern = `%${query}%`;

    return {
      artists: db
        .select()
        .from(artists)
        .where(like(artists.name, pattern))
        .limit(limit)
        .all() as Artist[],
      albums: db
        .select()
        .from(albums)
        .where(like(albums.title, pattern))
        .limit(limit)
        .all() as Album[],
      tracks: db
        .select()
        .from(tracks)
        .where(or(like(tracks.title, pattern), like(tracks.artistName, pattern)))
        .limit(limit)
        .all() as Track[],
      playlists: [],
    };
  }

  async getStreamUrl(trackId: string): Promise<string | null> {
    // Return the API stream endpoint URL
    return `/api/library/tracks/${trackId}/stream`;
  }
}

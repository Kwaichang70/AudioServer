import type { MusicProvider } from '@audioserver/shared';
import type { Artist, Album, Track, SearchResults } from '@audioserver/shared';
import { getDb } from '../db/index.js';
import { artists, albums, tracks } from '../db/schema.js';
import { eq, like, or } from 'drizzle-orm';
import { config } from '../config.js';

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
    const db = getDb();
    const all = db.select().from(artists).orderBy(artists.name).all();
    const start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize) as Artist[], total: all.length };
  }

  async getArtist(id: string) {
    const db = getDb();
    return (db.select().from(artists).where(eq(artists.id, id)).get() as Artist) || null;
  }

  async getAlbums(page = 1, pageSize = 50) {
    const db = getDb();
    const all = db.select().from(albums).orderBy(albums.title).all();
    const start = (page - 1) * pageSize;
    return { items: all.slice(start, start + pageSize) as Album[], total: all.length };
  }

  async getAlbum(id: string) {
    const db = getDb();
    return (db.select().from(albums).where(eq(albums.id, id)).get() as Album) || null;
  }

  async getAlbumTracks(albumId: string): Promise<Track[]> {
    const db = getDb();
    return db.select().from(tracks)
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
      artists: db.select().from(artists).where(like(artists.name, pattern)).limit(limit).all() as Artist[],
      albums: db.select().from(albums).where(like(albums.title, pattern)).limit(limit).all() as Album[],
      tracks: db.select().from(tracks).where(
        or(like(tracks.title, pattern), like(tracks.artistName, pattern))
      ).limit(limit).all() as Track[],
      playlists: [],
    };
  }

  async getStreamUrl(trackId: string): Promise<string | null> {
    // Return the API stream endpoint URL
    return `/api/library/tracks/${trackId}/stream`;
  }
}

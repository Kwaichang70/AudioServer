import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let db: ReturnType<typeof drizzle>;

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export async function initDatabase() {
  const dbPath = config.databasePath;
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  db = drizzle(sqlite, { schema });

  // Create tables if they don't exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS artists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image_url TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist_id TEXT NOT NULL REFERENCES artists(id),
      artist_name TEXT NOT NULL,
      year INTEGER,
      cover_url TEXT,
      genre TEXT,
      track_count INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      album_id TEXT NOT NULL REFERENCES albums(id),
      album_title TEXT NOT NULL,
      artist_id TEXT NOT NULL REFERENCES artists(id),
      artist_name TEXT NOT NULL,
      track_number INTEGER,
      disc_number INTEGER DEFAULT 1,
      duration REAL,
      format TEXT,
      sample_rate INTEGER,
      bit_depth INTEGER,
      file_path TEXT,
      cover_url TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
    CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title COLLATE NOCASE);
  `);

  logger.info(`Database initialized at ${dbPath}`);
}

export { schema };

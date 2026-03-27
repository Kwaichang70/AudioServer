import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const artists = sqliteTable('artists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  imageUrl: text('image_url'),
  source: text('source').notNull().default('local'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

export const albums = sqliteTable('albums', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  artistId: text('artist_id').notNull().references(() => artists.id),
  artistName: text('artist_name').notNull(),
  year: integer('year'),
  coverUrl: text('cover_url'),
  genre: text('genre'),
  trackCount: integer('track_count').default(0),
  source: text('source').notNull().default('local'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

export const tracks = sqliteTable('tracks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  albumId: text('album_id').notNull().references(() => albums.id),
  albumTitle: text('album_title').notNull(),
  artistId: text('artist_id').notNull().references(() => artists.id),
  artistName: text('artist_name').notNull(),
  trackNumber: integer('track_number'),
  discNumber: integer('disc_number').default(1),
  duration: real('duration'),
  format: text('format'),
  sampleRate: integer('sample_rate'),
  bitDepth: integer('bit_depth'),
  filePath: text('file_path'),
  coverUrl: text('cover_url'),
  source: text('source').notNull().default('local'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

export const playHistory = sqliteTable('play_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackId: text('track_id').notNull().references(() => tracks.id),
  albumId: text('album_id').notNull(),
  artistId: text('artist_id').notNull(),
  playedAt: integer('played_at', { mode: 'timestamp' }),
});

export const favorites = sqliteTable('favorites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemType: text('item_type').notNull(), // 'track', 'album', 'artist'
  itemId: text('item_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

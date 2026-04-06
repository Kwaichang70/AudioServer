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

export const playlists = sqliteTable('playlists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  trackCount: integer('track_count').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

export const playlistTracks = sqliteTable('playlist_tracks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  playlistId: text('playlist_id').notNull().references(() => playlists.id),
  trackId: text('track_id').notNull().references(() => tracks.id),
  position: integer('position').notNull(),
  addedAt: integer('added_at', { mode: 'timestamp' }),
});

export const playHistory = sqliteTable('play_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackId: text('track_id').notNull().references(() => tracks.id),
  albumId: text('album_id').notNull(),
  artistId: text('artist_id').notNull(),
  playedAt: integer('played_at', { mode: 'timestamp' }),
});

export const playbackState = sqliteTable('playback_state', {
  id: integer('id').primaryKey().default(1), // singleton row
  deviceId: text('device_id').default('browser'),
  trackId: text('track_id'),
  state: text('state').default('stopped'), // playing, paused, stopped
  position: real('position').default(0),
  volume: integer('volume').default(50),
  shuffle: integer('shuffle', { mode: 'boolean' }).default(false),
  repeat: text('repeat').default('off'), // off, all, one
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

export const queueItems = sqliteTable('queue_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackId: text('track_id').notNull(),
  trackTitle: text('track_title').notNull(),
  artistName: text('artist_name').notNull(),
  albumTitle: text('album_title').notNull(),
  albumId: text('album_id'),
  duration: real('duration'),
  source: text('source').default('local'),
  position: integer('position').notNull(),
  addedAt: integer('added_at', { mode: 'timestamp' }),
});

export const smartPlaylists = sqliteTable('smart_playlists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  rules: text('rules').notNull(), // JSON: array of rule objects
  trackCount: integer('track_count').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

export const favorites = sqliteTable('favorites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  itemType: text('item_type').notNull(), // 'track', 'album', 'artist'
  itemId: text('item_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

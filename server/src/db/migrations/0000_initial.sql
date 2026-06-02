CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image_url TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  artist_name TEXT NOT NULL,
  year INTEGER,
  cover_url TEXT,
  genre TEXT,
  is_compilation INTEGER DEFAULT 0,
  track_count INTEGER DEFAULT 0,
  replay_gain_album REAL,
  replay_gain_album_peak REAL,
  source TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  album_id TEXT NOT NULL REFERENCES albums(id),
  album_title TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  artist_name TEXT NOT NULL,
  artist_names TEXT,
  composer TEXT,
  conductor TEXT,
  track_number INTEGER,
  disc_number INTEGER DEFAULT 1,
  duration REAL,
  format TEXT,
  sample_rate INTEGER,
  bit_depth INTEGER,
  file_path TEXT,
  cover_url TEXT,
  replay_gain_track REAL,
  replay_gain_track_peak REAL,
  source TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS play_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  album_id TEXT NOT NULL,
  artist_id TEXT NOT NULL,
  played_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS provider_tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  track_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS playlist_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  position INTEGER NOT NULL,
  added_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id, position);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS playback_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  device_id TEXT DEFAULT 'browser',
  track_id TEXT,
  state TEXT DEFAULT 'stopped',
  position REAL DEFAULT 0,
  volume INTEGER DEFAULT 50,
  shuffle INTEGER DEFAULT 0,
  repeat TEXT DEFAULT 'off',
  updated_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS queue_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  track_title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_title TEXT NOT NULL,
  album_id TEXT,
  duration REAL,
  source TEXT DEFAULT 'local',
  position INTEGER NOT NULL,
  added_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_queue_position ON queue_items(position);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(item_type, item_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS scrobble_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  lastfm_enabled INTEGER DEFAULT 0,
  lastfm_session_key TEXT,
  lastfm_username TEXT,
  listenbrainz_enabled INTEGER DEFAULT 0,
  listenbrainz_token TEXT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS scrobble_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  track_title TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_title TEXT,
  duration INTEGER,
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retries INTEGER DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS smart_playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rules TEXT NOT NULL,
  track_count INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name COLLATE NOCASE);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_albums_title ON albums(title COLLATE NOCASE);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title COLLATE NOCASE);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_play_history_played ON play_history(played_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_favorites_type ON favorites(item_type, item_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS radio_stations (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stream_url TEXT NOT NULL,
  genre TEXT,
  country TEXT,
  language TEXT,
  homepage TEXT,
  favicon_url TEXT,
  bitrate INTEGER,
  codec TEXT,
  added_at INTEGER DEFAULT (unixepoch())
);

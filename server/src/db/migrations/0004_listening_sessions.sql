CREATE TABLE IF NOT EXISTS `listening_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`queue_item_id` text,
	`track_id` text,
	`source` text DEFAULT 'local' NOT NULL,
	`title` text NOT NULL,
	`artist_name` text NOT NULL,
	`album_title` text,
	`album_id` text,
	`artist_id` text,
	`duration` integer,
	`started_at` integer,
	`ended_at` integer,
	`listened_ms` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`qualified` integer DEFAULT false NOT NULL,
	`device_id` text,
	`user_id` text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_listening_started` ON `listening_sessions` (`started_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_listening_track` ON `listening_sessions` (`track_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_listening_artist` ON `listening_sessions` (`artist_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_listening_album` ON `listening_sessions` (`album_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_listening_status` ON `listening_sessions` (`status`);--> statement-breakpoint
INSERT INTO `listening_sessions` (`id`, `track_id`, `source`, `title`, `artist_name`, `album_title`, `album_id`, `artist_id`, `duration`, `started_at`, `ended_at`, `listened_ms`, `status`, `qualified`)
SELECT
	'legacy-' || h.id,
	h.track_id,
	'legacy',
	COALESCE(t.title, 'Unknown track'),
	COALESCE(NULLIF(t.artist_name, ''), ar.name, 'Unknown artist'),
	COALESCE(t.album_title, al.title),
	NULLIF(COALESCE(NULLIF(h.album_id, ''), t.album_id), ''),
	NULLIF(COALESCE(NULLIF(h.artist_id, ''), t.artist_id), ''),
	CASE WHEN t.duration IS NULL THEN NULL ELSE CAST(t.duration AS INTEGER) END,
	h.played_at,
	h.played_at,
	0,
	'ended',
	1
FROM `play_history` h
LEFT JOIN `tracks` t ON t.id = h.track_id
LEFT JOIN `albums` al ON al.id = NULLIF(h.album_id, '')
LEFT JOIN `artists` ar ON ar.id = NULLIF(h.artist_id, '');

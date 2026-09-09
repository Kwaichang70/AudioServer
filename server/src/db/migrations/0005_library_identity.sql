CREATE TABLE IF NOT EXISTS `scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`forced` integer DEFAULT false NOT NULL,
	`roots` text NOT NULL,
	`successful_roots` text,
	`failed_roots` text,
	`total_files` integer DEFAULT 0 NOT NULL,
	`new_tracks` integer DEFAULT 0 NOT NULL,
	`updated_tracks` integer DEFAULT 0 NOT NULL,
	`relinked_tracks` integer DEFAULT 0 NOT NULL,
	`missing_tracks` integer DEFAULT 0 NOT NULL,
	`recovered_tracks` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`message` text
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scan_runs_started` ON `scan_runs` (`started_at`);

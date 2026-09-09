ALTER TABLE `playback_state` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `playback_state` ADD `server_managed` integer DEFAULT false;
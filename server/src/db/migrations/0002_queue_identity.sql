ALTER TABLE `playback_state` ADD `queue_item_id` text;--> statement-breakpoint
ALTER TABLE `playback_state` ADD `revision` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `item_id` text;--> statement-breakpoint
ALTER TABLE `queue_items` ADD `metadata` text;
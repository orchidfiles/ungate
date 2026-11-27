-- Migration 0011: Persist Anthropic prompt-cache usage on requests
ALTER TABLE `requests` ADD COLUMN `cache_read_tokens` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `requests` ADD COLUMN `cache_creation_tokens` integer DEFAULT 0 NOT NULL;

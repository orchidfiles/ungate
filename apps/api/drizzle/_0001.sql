-- Migration 0001: oauth_tokens → provider_settings, add base_url
-- Handles both fresh DB and existing DB with tokens

CREATE TABLE IF NOT EXISTS `provider_settings` (
	`provider` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`expires_at` integer,
	`email` text,
	`created_at` integer NOT NULL,
	`base_url` text
);
--> statement-breakpoint
INSERT OR IGNORE INTO `provider_settings` (`provider`, `access_token`, `refresh_token`, `expires_at`, `email`, `created_at`)
SELECT 'claude', `access_token`, `refresh_token`, `expires_at`, `email`, `created_at`
FROM `oauth_tokens`
ORDER BY `id` DESC
LIMIT 1;
--> statement-breakpoint
DROP TABLE IF EXISTS `oauth_tokens`;

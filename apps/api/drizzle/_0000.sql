CREATE TABLE IF NOT EXISTS `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`port` integer DEFAULT 47821 NOT NULL,
	`api_key` text,
	`quiet` integer DEFAULT false NOT NULL,
	`extra_instruction` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`email` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`model` text NOT NULL,
	`source` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost` real DEFAULT 0 NOT NULL,
	`stream` integer DEFAULT false NOT NULL,
	`latency_ms` integer,
	`error` text
);

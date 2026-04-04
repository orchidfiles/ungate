CREATE TABLE IF NOT EXISTS `model_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`provider` text NOT NULL,
	`upstream_model` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`reasoning_budget` text
);
--> statement-breakpoint
INSERT OR IGNORE INTO `model_mappings` (`id`, `label`, `provider`, `upstream_model`, `enabled`, `sort_order`, `reasoning_budget`) VALUES
	('sonnet-4.6', 'Sonnet 4.6', 'claude', 'claude-sonnet-4-6', true, 0, NULL),
	('sonnet-4.6-medium', 'Sonnet 4.6 (medium)', 'claude', 'claude-sonnet-4-6', true, 1, 'medium'),
	('sonnet-4.6-high', 'Sonnet 4.6 (high)', 'claude', 'claude-sonnet-4-6', true, 2, 'high'),
	('opus-4.6', 'Opus 4.6', 'claude', 'claude-opus-4-6', true, 3, NULL),
	('opus-4.6-medium', 'Opus 4.6 (medium)', 'claude', 'claude-opus-4-6', true, 4, 'medium'),
	('opus-4.6-high', 'Opus 4.6 (high)', 'claude', 'claude-opus-4-6', true, 5, 'high'),
	('sonnet-4.5', 'Sonnet 4.5', 'claude', 'claude-sonnet-4-5-20250929', true, 6, NULL),
	('sonnet-4.5-medium', 'Sonnet 4.5 (medium)', 'claude', 'claude-sonnet-4-5-20250929', true, 7, 'medium'),
	('sonnet-4.5-high', 'Sonnet 4.5 (high)', 'claude', 'claude-sonnet-4-5-20250929', true, 8, 'high'),
	('opus-4.5', 'Opus 4.5', 'claude', 'claude-opus-4-5-20251101', true, 9, NULL),
	('opus-4.5-medium', 'Opus 4.5 (medium)', 'claude', 'claude-opus-4-5-20251101', true, 10, 'medium'),
	('opus-4.5-high', 'Opus 4.5 (high)', 'claude', 'claude-opus-4-5-20251101', true, 11, 'high'),
	('haiku-4.5', 'Haiku 4.5', 'claude', 'claude-haiku-4-5-20251001', true, 12, NULL);

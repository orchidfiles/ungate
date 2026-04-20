-- Migration 0004: remove enabled from model_mappings
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_model_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`provider` text NOT NULL,
	`upstream_model` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`reasoning_budget` text
);
--> statement-breakpoint
INSERT INTO `__new_model_mappings` (`id`, `label`, `provider`, `upstream_model`, `sort_order`, `reasoning_budget`)
SELECT `id`, `label`, `provider`, `upstream_model`, `sort_order`, `reasoning_budget` FROM `model_mappings`;
--> statement-breakpoint
DROP TABLE `model_mappings`;
--> statement-breakpoint
ALTER TABLE `__new_model_mappings` RENAME TO `model_mappings`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;

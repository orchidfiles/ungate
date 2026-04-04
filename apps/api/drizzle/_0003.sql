-- Migration 0003: add account_id to provider_settings
ALTER TABLE provider_settings ADD COLUMN account_id text;
--> statement-breakpoint
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, enabled, sort_order, reasoning_budget)
VALUES
	('gpt-5.4', 'GPT-5.4', 'openai', 'gpt-5.4', true, 100, NULL),
	('gpt-5.4-mini', 'GPT-5.4 Mini', 'openai', 'gpt-5.4-mini', true, 101, NULL),
	('gpt-5.3-codex', 'GPT-5.3 Codex', 'openai', 'gpt-5.3-codex', true, 102, 'medium'),
	('gpt-5.3-codex-high', 'GPT-5.3 Codex High', 'openai', 'gpt-5.3-codex-high', true, 103, 'high'),
	('gpt-5.3-codex-low', 'GPT-5.3 Codex Low', 'openai', 'gpt-5.3-codex-low', true, 104, 'low'),
	('gpt-5.1-codex-mini', 'GPT-5.1 Codex Mini', 'openai', 'gpt-5.1-codex-mini', true, 105, 'medium'),
	('gpt-5.1-codex-mini-high', 'GPT-5.1 Codex Mini High', 'openai', 'gpt-5.1-codex-mini-high', true, 106, 'high');

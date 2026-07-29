-- Migration 0007: add GPT-5.6 OpenAI model mappings
ALTER TABLE model_mappings ADD COLUMN service_tier text;
--> statement-breakpoint
WITH candidates(id, label, provider, upstream_model, reasoning_budget, service_tier, sort_offset) AS (
	VALUES
		('gpt-5.6-luna-medium', 'GPT-5.6 Luna Medium', 'openai', 'gpt-5.6-luna', 'medium', 'default', 1),
		('gpt-5.6-luna-fast-medium', 'GPT-5.6 Luna Fast Medium', 'openai', 'gpt-5.6-luna', 'medium', 'priority', 2),
		('gpt-5.6-terra-medium', 'GPT-5.6 Terra Medium', 'openai', 'gpt-5.6-terra', 'medium', 'default', 3),
		('gpt-5.6-terra-fast-medium', 'GPT-5.6 Terra Fast Medium', 'openai', 'gpt-5.6-terra', 'medium', 'priority', 4),
		('gpt-5.6-sol-medium', 'GPT-5.6 Sol Medium', 'openai', 'gpt-5.6-sol', 'medium', 'default', 5),
		('gpt-5.6-sol-fast-medium', 'GPT-5.6 Sol Fast Medium', 'openai', 'gpt-5.6-sol', 'medium', 'priority', 6)
),
base_sort_order(value) AS (
	SELECT COALESCE(MAX(sort_order), -1)
	FROM model_mappings
),
resolved_candidates AS (
	SELECT
		candidate.id,
		candidate.label,
		candidate.provider,
		candidate.upstream_model,
		(SELECT value FROM base_sort_order) + candidate.sort_offset AS sort_order,
		candidate.reasoning_budget,
		candidate.service_tier
	FROM candidates AS candidate
)
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, sort_order, reasoning_budget, service_tier)
SELECT candidate.id, candidate.label, candidate.provider, candidate.upstream_model, candidate.sort_order, candidate.reasoning_budget, candidate.service_tier
FROM resolved_candidates AS candidate
WHERE NOT EXISTS (
	SELECT 1
	FROM model_mappings AS existing
	WHERE existing.provider = candidate.provider
		AND existing.upstream_model = candidate.upstream_model
		AND (
			existing.reasoning_budget = candidate.reasoning_budget
			OR (existing.reasoning_budget IS NULL AND candidate.reasoning_budget IS NULL)
		)
		AND (
			existing.service_tier = candidate.service_tier
			OR (existing.service_tier IS NULL AND candidate.service_tier = 'default')
		)
);

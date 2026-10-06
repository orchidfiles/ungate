-- Migration 0008: add GPT-6 Astra OpenAI model mappings
-- Custom IDs avoid Cursor's registry rejection of gpt-6-astra for Chat Completions.
WITH candidates(id, label, provider, upstream_model, reasoning_budget, service_tier, sort_offset) AS (
	VALUES
		('ungate-astra-medium', 'GPT-6 Astra Medium', 'openai', 'gpt-6-astra', 'medium', 'default', 1),
		('ungate-astra-fast-medium', 'GPT-6 Astra Fast Medium', 'openai', 'gpt-6-astra', 'medium', 'priority', 2)
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

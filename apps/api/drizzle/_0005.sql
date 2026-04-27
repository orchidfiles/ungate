-- Migration 0005: add GPT-5.5 and Opus-4.7 model mappings
WITH candidates(id, label, provider, upstream_model, reasoning_budget, sort_offset) AS (
	VALUES
		('gpt-5.5', 'GPT-5.5', 'openai', 'gpt-5.5', NULL, 1),
		('gpt-5.5-low', 'GPT-5.5 Low', 'openai', 'gpt-5.5', 'low', 2),
		('gpt-5.5-medium', 'GPT-5.5 Medium', 'openai', 'gpt-5.5', 'medium', 3),
		('gpt-5.5-high', 'GPT-5.5 High', 'openai', 'gpt-5.5', 'high', 4),
		('gpt-5.5-xhigh', 'GPT-5.5 XHigh', 'openai', 'gpt-5.5', 'xhigh', 5),
		('opus-4.7', 'Opus 4.7', 'claude', 'claude-opus-4-7', NULL, 6),
		('opus-4.7-low', 'Opus 4.7 Low', 'claude', 'claude-opus-4-7', 'low', 7),
		('opus-4.7-medium', 'Opus 4.7 Medium', 'claude', 'claude-opus-4-7', 'medium', 8),
		('opus-4.7-high', 'Opus 4.7 High', 'claude', 'claude-opus-4-7', 'high', 9),
		('opus-4.7-xhigh', 'Opus 4.7 XHigh', 'claude', 'claude-opus-4-7', 'xhigh', 10)
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
		candidate.reasoning_budget
	FROM candidates AS candidate
)
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, sort_order, reasoning_budget)
SELECT candidate.id, candidate.label, candidate.provider, candidate.upstream_model, candidate.sort_order, candidate.reasoning_budget
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
);

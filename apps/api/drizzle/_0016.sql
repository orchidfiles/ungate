-- Migration 0016: pre-seed Gemini 4 Carbon (base, medium, high) on the Gemini Code Assist provider.
-- Ids use the `ungate-` prefix (see _0015: Cursor rejects ids it recognizes as built-in slugs).
-- All three share upstream `gemini-4-carbon`; the tier is sent as thinkingConfig.thinkingLevel.
-- Skipped per tier when an equivalent Gemini row already exists, e.g. one added from the dashboard.
WITH candidates(id, label, upstream_model, reasoning_budget, sort_offset) AS (
	VALUES
		('ungate-gemini-4-carbon', 'Gemini 4 Carbon', 'gemini-4-carbon', NULL, 1),
		('ungate-gemini-4-carbon-medium', 'Gemini 4 Carbon Medium', 'gemini-4-carbon', 'medium', 2),
		('ungate-gemini-4-carbon-high', 'Gemini 4 Carbon High', 'gemini-4-carbon', 'high', 3)
),
base_sort_order(value) AS (
	SELECT COALESCE(MAX(sort_order), -1)
	FROM model_mappings
)
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, sort_order, reasoning_budget)
SELECT
	candidate.id,
	candidate.label,
	'gemini',
	candidate.upstream_model,
	(SELECT value FROM base_sort_order) + candidate.sort_offset,
	candidate.reasoning_budget
FROM candidates AS candidate
WHERE NOT EXISTS (
	SELECT 1
	FROM model_mappings AS existing
	WHERE existing.provider = 'gemini'
		AND lower(existing.upstream_model) = candidate.upstream_model
		AND existing.reasoning_budget IS candidate.reasoning_budget
);

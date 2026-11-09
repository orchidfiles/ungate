-- Migration 0014: pre-seed Cursor Grok 4.7 (medium, high).
-- Cursor's model ids carry the tier (`grok-4.7-medium`), so it stays in upstream_model. The
-- reasoning_budget matches the id suffix so a request whose suffix Cursor stripped
-- (`cursor-grok-4.7`) still resolves. Skipped when an equivalent Cursor row already exists,
-- e.g. one imported from the dashboard.
WITH candidates(id, label, upstream_model, reasoning_budget, sort_offset) AS (
	VALUES
		('cursor-grok-4.7-medium', 'Grok 4.7 Medium (Cursor)', 'grok-4.7-medium', 'medium', 1),
		('cursor-grok-4.7-high', 'Grok 4.7 High (Cursor)', 'grok-4.7-high', 'high', 2)
),
base_sort_order(value) AS (
	SELECT COALESCE(MAX(sort_order), -1)
	FROM model_mappings
)
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, sort_order, reasoning_budget)
SELECT
	candidate.id,
	candidate.label,
	'cursor',
	candidate.upstream_model,
	(SELECT value FROM base_sort_order) + candidate.sort_offset,
	candidate.reasoning_budget
FROM candidates AS candidate
WHERE NOT EXISTS (
	SELECT 1
	FROM model_mappings AS existing
	WHERE existing.provider = 'cursor'
		AND lower(existing.upstream_model) = candidate.upstream_model
);

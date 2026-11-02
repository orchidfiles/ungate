-- Migration 0010: Opus 5.5 uses Anthropic's hyphenated id.
-- claude-opus-5.5 is rejected with "Did you mean claude-opus-5-5?"
UPDATE model_mappings
SET upstream_model = 'claude-opus-5-5'
WHERE upstream_model = 'claude-opus-5.5';
--> statement-breakpoint
UPDATE model_mappings
SET reasoning_budget = CASE
	WHEN id LIKE '%-xhigh' THEN 'xhigh'
	WHEN id LIKE '%-high' THEN 'high'
	WHEN id LIKE '%-medium' THEN 'medium'
	WHEN id LIKE '%-low' THEN 'low'
	ELSE reasoning_budget
END
WHERE upstream_model = 'claude-opus-5-5'
	AND reasoning_budget IS NULL
	AND (
		id LIKE '%-xhigh'
		OR id LIKE '%-high'
		OR id LIKE '%-medium'
		OR id LIKE '%-low'
	);
--> statement-breakpoint
WITH candidates(id, label, provider, upstream_model, reasoning_budget, sort_offset) AS (
	VALUES
		('unopus-5.5', 'Opus 5.5', 'claude', 'claude-opus-5-5', NULL, 1),
		('unopus-5.5-low', 'Opus 5.5 Low', 'claude', 'claude-opus-5-5', 'low', 2),
		('unopus-5.5-medium', 'Opus 5.5 Medium', 'claude', 'claude-opus-5-5', 'medium', 3),
		('unopus-5.5-high', 'Opus 5.5 High', 'claude', 'claude-opus-5-5', 'high', 4),
		('unopus-5.5-xhigh', 'Opus 5.5 XHigh', 'claude', 'claude-opus-5-5', 'xhigh', 5),
		('opus-5.5', 'Opus 5.5', 'claude', 'claude-opus-5-5', NULL, 6),
		('opus-5.5-low', 'Opus 5.5 Low', 'claude', 'claude-opus-5-5', 'low', 7),
		('opus-5.5-medium', 'Opus 5.5 Medium', 'claude', 'claude-opus-5-5', 'medium', 8),
		('opus-5.5-high', 'Opus 5.5 High', 'claude', 'claude-opus-5-5', 'high', 9),
		('opus-5.5-xhigh', 'Opus 5.5 XHigh', 'claude', 'claude-opus-5-5', 'xhigh', 10)
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
FROM resolved_candidates AS candidate;

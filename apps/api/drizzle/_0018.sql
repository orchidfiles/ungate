-- Migration 0018: seed the custom slugs Cursor saves for models it will not accept by their upstream name.
-- The picker sends these ids. Claude tiers share one upstream model; Astra High is the missing
-- GPT-6 Astra tier (medium and fast-medium are _0008). Skipped when that provider, upstream
-- model, and reasoning budget already exist, including a row added from the dashboard.
WITH claude_candidates(id, label, upstream_model, reasoning_budget, sort_offset) AS (
	VALUES
		('sonnet-5.5-medium', 'Sonnet 5.5 Medium', 'claude-sonnet-5-5', 'medium', 1),
		('sonnet-5.5-high', 'Sonnet 5.5 High', 'claude-sonnet-5-5', 'high', 2),
		('haiku-5.5-medium', 'Haiku 5.5 Medium', 'claude-haiku-5-5', 'medium', 3),
		('haiku-5.5-high', 'Haiku 5.5 High', 'claude-haiku-5-5', 'high', 4),
		('fable-5.2-medium', 'Fable 5.2 Medium', 'claude-fable-5-2', 'medium', 5)
),
claude_base(value) AS (
	SELECT COALESCE(MAX(sort_order), -1) FROM model_mappings
)
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, sort_order, reasoning_budget)
SELECT
	candidate.id,
	candidate.label,
	'claude',
	candidate.upstream_model,
	(SELECT value FROM claude_base) + candidate.sort_offset,
	candidate.reasoning_budget
FROM claude_candidates AS candidate
WHERE NOT EXISTS (
	SELECT 1
	FROM model_mappings AS existing
	WHERE existing.provider = 'claude'
		AND existing.upstream_model = candidate.upstream_model
		AND existing.reasoning_budget = candidate.reasoning_budget
);
--> statement-breakpoint
WITH astra_candidates(id, label, upstream_model, reasoning_budget, service_tier, sort_offset) AS (
	VALUES
		('ungate-astra-high', 'GPT-6 Astra High', 'gpt-6-astra', 'high', 'default', 1)
),
astra_base(value) AS (
	SELECT COALESCE(MAX(sort_order), -1) FROM model_mappings
)
INSERT OR IGNORE INTO model_mappings (id, label, provider, upstream_model, sort_order, reasoning_budget, service_tier)
SELECT
	candidate.id,
	candidate.label,
	'openai',
	candidate.upstream_model,
	(SELECT value FROM astra_base) + candidate.sort_offset,
	candidate.reasoning_budget,
	candidate.service_tier
FROM astra_candidates AS candidate
WHERE NOT EXISTS (
	SELECT 1
	FROM model_mappings AS existing
	WHERE existing.provider = 'openai'
		AND existing.upstream_model = candidate.upstream_model
		AND existing.reasoning_budget = candidate.reasoning_budget
		AND (
			existing.service_tier = candidate.service_tier
			OR (existing.service_tier IS NULL AND candidate.service_tier = 'default')
		)
);

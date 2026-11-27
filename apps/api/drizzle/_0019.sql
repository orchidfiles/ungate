-- Migration 0019: one slug per Opus 5.5 tier.
-- _0010 inserted unopus-5.5-* beside opus-5.5-* for the same upstream model.
-- A saved id "opus-5.5 high" is that high tier with a space. Keep opus-5.5-*.
UPDATE OR IGNORE model_mappings
SET id = 'opus-5.5' || substr(id, length('unopus-5.5') + 1)
WHERE id = 'unopus-5.5'
	OR id LIKE 'unopus-5.5-%';
--> statement-breakpoint
DELETE FROM model_mappings
WHERE id = 'unopus-5.5'
	OR id LIKE 'unopus-5.5-%';
--> statement-breakpoint
UPDATE OR IGNORE model_mappings
SET id = 'opus-5.5-high',
	reasoning_budget = COALESCE(reasoning_budget, 'high')
WHERE id = 'opus-5.5 high';
--> statement-breakpoint
DELETE FROM model_mappings
WHERE id = 'opus-5.5 high';
--> statement-breakpoint
UPDATE model_mappings
SET label = 'Opus 5.5 High'
WHERE id = 'opus-5.5-high'
	AND label = 'Opus 5.5';

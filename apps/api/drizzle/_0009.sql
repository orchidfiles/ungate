-- Migration 0009: add Amazon Bedrock GPT-6 Astra mapping
INSERT OR IGNORE INTO model_mappings (
	id,
	label,
	provider,
	upstream_model,
	sort_order,
	reasoning_budget,
	service_tier
)
VALUES (
	'us.openai.gpt-6-astra',
	'GPT-6 Astra · Bedrock',
	'bedrock',
	'us.openai.gpt-6-astra',
	(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM model_mappings),
	'medium',
	NULL
);

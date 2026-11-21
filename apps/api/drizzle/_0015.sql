-- Migration 0015: rename Cursor model ids from `cursor-*` to `ungate-*`.
-- Cursor's backend treats `cursor-grok-*` as legacy slugs of its built-in Grok and rejects them
-- with "This model does not support custom API keys" before the request reaches Ungate.
-- OR IGNORE keeps a row unchanged when its `ungate-*` id is already taken.
UPDATE OR IGNORE model_mappings
SET id = 'ungate-' || substr(id, length('cursor-') + 1)
WHERE provider = 'cursor'
	AND id LIKE 'cursor-%';

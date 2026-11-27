/**
 * SQL predicate over a `requests` row (optionally aliased) that is true when its price is unknown:
 * Cursor requests, and failed requests whose model is routed to Cursor. Failures are stored with
 * `source = 'error'`, so the model mapping is the only record of which provider they belong to.
 */
export function unknownCostCondition(alias?: string): string {
	const column = (name: string) => (alias ? `${alias}.${name}` : name);

	return `(${column('source')} = 'cursor' OR (${column('source')} = 'error' AND ${column('model')} IN (SELECT id FROM model_mappings WHERE provider = 'cursor')))`;
}

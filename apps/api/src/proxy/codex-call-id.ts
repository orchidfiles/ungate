import { createHash } from 'node:crypto';

const CALL_ITEM_TYPES = new Set(['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output']);

export function normalizeCodexCallId(id: string): string {
	if (id.length <= 64) {
		return id;
	}

	return `${id.slice(0, 47)}_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

// Upstream constrains call_id to 1-64 characters with no character-set rule. An empty id is
// dropped rather than synthesized: every empty id would hash to the same value and cross-pair
// unrelated calls, and an unpaired output is already discarded downstream.
export function remapCodexCallIds(items: Record<string, unknown>[]): Record<string, unknown>[] {
	const remapped: Record<string, unknown>[] = [];

	for (const item of items) {
		if (typeof item.type !== 'string' || !CALL_ITEM_TYPES.has(item.type)) {
			remapped.push(item);
			continue;
		}

		if (typeof item.call_id !== 'string') {
			remapped.push(item);
			continue;
		}

		if (item.call_id === '') {
			continue;
		}

		remapped.push({ ...item, call_id: normalizeCodexCallId(item.call_id) });
	}

	return remapped;
}

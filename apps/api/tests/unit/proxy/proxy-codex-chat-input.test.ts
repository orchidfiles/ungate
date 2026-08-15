import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CodexInputUtils } from 'src/proxy/codex-input-utils';
import { ResponsesInputShape } from 'src/proxy/responses-input-normalizer/input-shape';

describe('proxy-codex-chat-input', () => {
	it('converts mixed openai messages into codex input preserving order with developer first', () => {
		const input = CodexInputUtils.buildFromMessages([
			{ role: 'user', content: 'u1' },
			{ role: 'system', content: 'sys' },
			{ role: 'assistant', content: 'a1' },
			{ role: 'tool', tool_call_id: 'call_1', content: 'result' },
			{
				role: 'assistant',
				content: 'a2',
				tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }]
			}
		]);

		expect(input[0]).toMatchObject({ type: 'message', role: 'developer' });
		expect(input.some((item) => item.type === 'function_call')).toBe(true);
		expect(input.some((item) => item.type === 'function_call_output')).toBe(true);
	});

	it('normalizes assistant text blocks into output_text', () => {
		const normalized = CodexInputUtils.normalizeAssistantText([
			{
				type: 'message',
				role: 'assistant',
				content: [{ type: 'input_text', text: 'hello' }, { type: 'text', text: 'world' }]
			}
		]);

		const content = normalized[0].content as Array<Record<string, unknown>>;
		expect(content[0].type).toBe('output_text');
		expect(content[1].type).toBe('output_text');
	});

	it('expands mixed body.input items and coerces chat shape', () => {
		const expanded = CodexInputUtils.expandInput([
			{ role: 'system', content: 's' },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u' }] },
			{ type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }
		]);

		expect(expanded).toBeTruthy();
		expect(expanded?.[0]).toMatchObject({ type: 'message', role: 'developer' });
		expect(expanded?.at(-1)).toMatchObject({ type: 'function_call' });

		const coerced = CodexInputUtils.coerceMessages({
			input: [{ role: 'user', content: 'hi' }]
		});
		expect(coerced).toHaveLength(1);
		expect(coerced[0].role).toBe('user');
	});

	it('maps a long chat call/output pair to the same 64-char id and keeps it through orphan filtering', () => {
		const longId = `call_${'a'.repeat(80)}`;
		const expectedId = expectedNormalizedCallId(longId);
		const input = CodexInputUtils.buildFromMessages([
			{
				role: 'assistant',
				content: null,
				tool_calls: [{ id: longId, type: 'function', function: { name: 'Read', arguments: '{}' } }]
			},
			{ role: 'tool', tool_call_id: longId, content: 'result' },
			{ role: 'function', name: longId, content: 'legacy-result' }
		]);
		const call = input.find((item) => item.type === 'function_call');
		const outputs = input.filter((item) => item.type === 'function_call_output');

		expect(expectedId).toHaveLength(64);
		expect(call?.call_id).toBe(expectedId);
		expect(outputs.map((item) => item.call_id)).toEqual([expectedId, expectedId]);
		expect(ResponsesInputShape.filterOrphans(input)).toEqual(input);
	});

	it('keeps two long ids that share a prefix distinct', () => {
		const prefix = 'x'.repeat(47);
		const firstId = `${prefix}first-unique-suffix-aaaaaaaaaaaaaaaa`;
		const secondId = `${prefix}second-unique-suffix-bbbbbbbbbbbbbbb`;
		const input = CodexInputUtils.buildFromMessages([
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{ id: firstId, type: 'function', function: { name: 'Read', arguments: '{}' } },
					{ id: secondId, type: 'function', function: { name: 'Write', arguments: '{}' } }
				]
			}
		]);
		const callIds = input.filter((item) => item.type === 'function_call').map((item) => item.call_id);

		expect(firstId.slice(0, 47)).toBe(secondId.slice(0, 47));
		expect(callIds).toEqual([expectedNormalizedCallId(firstId), expectedNormalizedCallId(secondId)]);
		expect(callIds[0]).not.toBe(callIds[1]);
		expect(callIds.every((id) => typeof id === 'string' && id.length === 64)).toBe(true);
	});

	it('maps Responses-shaped call/output pairs to the same 64-char id', () => {
		const longId = `call_${'b'.repeat(80)}`;
		const expectedId = expectedNormalizedCallId(longId);
		const expanded = CodexInputUtils.expandInput([
			{ type: 'function_call', call_id: longId, name: 'Read', arguments: '{}' },
			{ type: 'function_call_output', call_id: longId, output: 'ok' },
			{ type: 'custom_tool_call', call_id: longId, name: 'Custom' },
			{ type: 'custom_tool_call_output', call_id: longId, output: 'custom-ok' }
		]);

		expect(expanded?.map((item) => item.call_id)).toEqual([expectedId, expectedId, expectedId, expectedId]);
		expect(ResponsesInputShape.filterOrphans(expanded ?? [])).toEqual(expanded);
	});

	it('passes through call ids that are already 64 characters or shorter', () => {
		const shortId = 'call_short';
		const exactId = 'c'.repeat(64);
		const input = CodexInputUtils.buildFromMessages([
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{ id: shortId, type: 'function', function: { name: 'Read', arguments: '{}' } },
					{ id: exactId, type: 'function', function: { name: 'Write', arguments: '{}' } }
				]
			},
			{ role: 'tool', tool_call_id: shortId, content: 'short' },
			{ role: 'tool', tool_call_id: exactId, content: 'exact' }
		]);
		const expanded = CodexInputUtils.expandInput([
			{ type: 'function_call', call_id: shortId, name: 'Read', arguments: '{}' },
			{ type: 'function_call_output', call_id: exactId, output: 'exact' }
		]);

		expect(input.find((item) => item.type === 'function_call' && item.name === 'Read')?.call_id).toBe(shortId);
		expect(input.find((item) => item.type === 'function_call' && item.name === 'Write')?.call_id).toBe(exactId);
		expect(input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id)).toEqual([shortId, exactId]);
		expect(expanded?.[0].call_id).toBe(shortId);
		expect(expanded?.[1].call_id).toBe(exactId);
	});

	it('is idempotent for an already-normalized call id', () => {
		const longId = `call_${'d'.repeat(80)}`;
		const normalizedId = expectedNormalizedCallId(longId);
		const input = CodexInputUtils.buildFromMessages([
			{
				role: 'assistant',
				content: null,
				tool_calls: [{ id: normalizedId, type: 'function', function: { name: 'Read', arguments: '{}' } }]
			},
			{ role: 'tool', tool_call_id: normalizedId, content: 'result' }
		]);
		const expanded = CodexInputUtils.expandInput([
			{ type: 'function_call', call_id: normalizedId, name: 'Read', arguments: '{}' },
			{ type: 'function_call_output', call_id: normalizedId, output: 'result' }
		]);

		expect(normalizedId).toHaveLength(64);
		expect(input.find((item) => item.type === 'function_call')?.call_id).toBe(normalizedId);
		expect(input.find((item) => item.type === 'function_call_output')?.call_id).toBe(normalizedId);
		expect(expanded?.map((item) => item.call_id)).toEqual([normalizedId, normalizedId]);
	});
});

function expectedNormalizedCallId(id: string): string {
	if (id.length <= 64) {
		return id;
	}

	return `${id.slice(0, 47)}_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

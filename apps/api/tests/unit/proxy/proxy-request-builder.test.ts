import { describe, expect, it, vi } from 'vitest';

vi.mock('src/database/app-settings', () => ({
	Settings: {
		get: vi.fn(() => ({ extraInstruction: 'extra instruction from settings' }))
	}
}));

import { RequestBuilder } from 'src/proxy/request-builder';

describe('proxy-request-builder', () => {
	it('prepares claude code body: strips reasoning budget and ttl cache fields', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-sonnet-4-6',
			max_tokens: 1024,
			reasoning_budget: 'high',
			system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: 20 } }],
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: 'u', cache_control: { type: 'ephemeral', ttl: 10 } }]
				}
			]
		});

		expect(prepared.reasoning_budget).toBeUndefined();
		expect(Array.isArray(prepared.system)).toBe(true);
		const system = prepared.system as { type: string; text?: string; cache_control?: { ttl?: number } }[];
		expect(system.some((block) => block.text === 'extra instruction from settings')).toBe(true);
		expect(system.find((block) => block.text === 'sys')?.cache_control?.ttl).toBeUndefined();
		const userBlock = (prepared.messages[0].content as { cache_control?: { ttl?: number } }[])[0];
		expect(userBlock.cache_control?.ttl).toBeUndefined();
	});

	it('converts string system prompt into system blocks', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-sonnet-4-6',
			max_tokens: 512,
			system: 'custom system',
			messages: [{ role: 'user', content: 'hello' }]
		});

		const system = prepared.system as { type: string; text?: string }[];
		expect(Array.isArray(system)).toBe(true);
		expect(system.some((block) => block.text === 'custom system')).toBe(true);
		expect(system.some((block) => block.text === 'extra instruction from settings')).toBe(true);
	});
});

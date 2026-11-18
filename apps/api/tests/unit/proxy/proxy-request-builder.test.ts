import { describe, expect, it, vi } from 'vitest';

vi.mock('src/database/app-settings', () => ({
	Settings: {
		get: vi.fn(() => ({
			extraInstruction: 'extra instruction from settings',
			claudeCliVersionMode: 'latest',
			claudeCliVersionCustom: null
		}))
	}
}));

import { CLAUDE_CODE_OPUS_PACKET } from 'src/proxy/claude-code-packet';
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
		expect(prepared.thinking).toEqual(CLAUDE_CODE_OPUS_PACKET.thinking);
		expect(prepared.output_config).toEqual({ effort: 'high' });
		expect(prepared.context_management).toEqual(CLAUDE_CODE_OPUS_PACKET.contextManagement);
		expect(Array.isArray(prepared.system)).toBe(true);
		const system = prepared.system as { type: string; text?: string; cache_control?: { ttl?: number } }[];
		expect(system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_OPUS_PACKET.identity });
		expect(system.some((block) => block.text === 'extra instruction from settings')).toBe(true);
		expect(system.find((block) => block.text === 'sys')?.cache_control?.ttl).toBeUndefined();
		const userBlock = (prepared.messages[0].content as { cache_control?: { ttl?: number } }[])[0];
		expect(userBlock.cache_control?.ttl).toBeUndefined();
	});

	it('passes each reasoning tier through verbatim as the effort level', () => {
		for (const tier of ['low', 'medium', 'high', 'xhigh'] as const) {
			const prepared = RequestBuilder.prepareClaudeCodeBody({
				model: 'claude-opus-4-8',
				max_tokens: 1024,
				reasoning_budget: tier,
				messages: [{ role: 'user', content: 'hello' }]
			});

			expect(prepared.reasoning_budget).toBeUndefined();
			expect(prepared.thinking).toEqual(CLAUDE_CODE_OPUS_PACKET.thinking);
			expect(prepared.output_config).toEqual({ effort: tier });
			expect(prepared.context_management).toEqual(CLAUDE_CODE_OPUS_PACKET.contextManagement);
		}
	});

	it('requests thinking updates so they can be shown while Claude works', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-opus-5-5',
			max_tokens: 32000,
			reasoning_budget: 'xhigh',
			messages: [{ role: 'user', content: 'hello' }]
		});

		expect(prepared.thinking?.display).toBe('updates');
		expect(prepared.output_config).toEqual({ effort: 'xhigh' });
	});

	it('ignores a non-tier reasoning budget without enabling thinking', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-opus-4-8',
			max_tokens: 1024,
			reasoning_budget: 10000,
			messages: [{ role: 'user', content: 'hello' }]
		});

		expect(prepared.reasoning_budget).toBeUndefined();
		expect(prepared.thinking).toBeUndefined();
		expect(prepared.output_config).toBeUndefined();
		expect(prepared.context_management).toBeUndefined();
	});

	it('does not set thinking when no reasoning budget is provided', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-opus-4-8',
			max_tokens: 1024,
			messages: [{ role: 'user', content: 'hello' }]
		});

		expect(prepared.thinking).toBeUndefined();
		expect(prepared.output_config).toBeUndefined();
		expect(prepared.context_management).toBeUndefined();
	});

	it('matches the Claude Code Opus packet for a medium reasoning body', () => {
		const prepared = RequestBuilder.prepareClaudeCodeBody({
			model: 'claude-opus-5-5',
			max_tokens: 128000,
			reasoning_budget: 'medium',
			tools: [{ name: 'Shell', description: 'Run a command', input_schema: { type: 'object', properties: {} } }],
			messages: [{ role: 'user', content: 'hello' }]
		});

		expect(prepared.max_tokens).toBe(128000);
		expect(prepared.thinking).toEqual(CLAUDE_CODE_OPUS_PACKET.thinking);
		expect(prepared.output_config).toEqual({ effort: 'medium' });
		expect(prepared.context_management).toEqual(CLAUDE_CODE_OPUS_PACKET.contextManagement);
		expect((prepared.system as { text?: string }[])[0]?.text).toBe(CLAUDE_CODE_OPUS_PACKET.identity);
		expect(prepared.tools?.map((tool) => tool.name)).toEqual(['Shell']);
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
		expect(system[0]).toEqual({ type: 'text', text: CLAUDE_CODE_OPUS_PACKET.identity });
		expect(system.some((block) => block.text === 'custom system')).toBe(true);
		expect(system.some((block) => block.text === 'extra instruction from settings')).toBe(true);
	});

	it('builds Claude OAuth User-Agent from app settings', () => {
		expect(RequestBuilder.getClaudeOAuthUserAgent()).toBe(CLAUDE_CODE_OPUS_PACKET.userAgent);
	});

	it('sends the Claude Code beta list with the bearer redacted from the fingerprint comparison', () => {
		const headers = RequestBuilder.getClaudeOAuthHeaders('secret-token');
		const comparable: Record<string, string> = { ...headers, Authorization: '[redacted]' };

		expect(comparable.Authorization).toBe('[redacted]');
		expect(comparable['anthropic-beta']).toBe(CLAUDE_CODE_OPUS_PACKET.betas.join(','));
		expect(comparable['User-Agent']).toBe(CLAUDE_CODE_OPUS_PACKET.userAgent);
		expect(JSON.stringify(comparable)).not.toContain('secret-token');
	});
});

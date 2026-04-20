import { describe, expect, it } from 'vitest';

import { CompletionModelRouting } from 'src/orchestration/openai';

import type { ModelMappingConfig } from '@ungate/shared';

function mapping(partial: Partial<ModelMappingConfig> & Pick<ModelMappingConfig, 'provider' | 'upstreamModel'>): ModelMappingConfig {
	return {
		id: partial.id ?? 'id',
		label: partial.label ?? 'label',
		provider: partial.provider,
		upstreamModel: partial.upstreamModel,
		sortOrder: partial.sortOrder ?? 0,
		reasoningBudget: partial.reasoningBudget ?? null
	};
}

describe('CompletionModelRouting', () => {
	it('detects minimax model prefixes case-insensitively', () => {
		expect(CompletionModelRouting.isMiniMaxModel('MiniMax-x')).toBe(true);
		expect(CompletionModelRouting.isMiniMaxModel('  mini-max-1  ')).toBe(true);
		expect(CompletionModelRouting.isMiniMaxModel('gpt-4')).toBe(false);
	});

	it('routes minimax when mapping says minimax or model prefix matches', () => {
		expect(CompletionModelRouting.shouldRouteMiniMax(mapping({ provider: 'minimax', upstreamModel: 'u' }), 'x')).toBe(true);
		expect(CompletionModelRouting.shouldRouteMiniMax(null, 'minimax-pro')).toBe(true);
		expect(CompletionModelRouting.shouldRouteMiniMax(null, 'claude')).toBe(false);
	});

	it('builds minimax body only when mapping provider is minimax', () => {
		const body = { model: 'alias', messages: [], stream: false } as const;
		const mm = mapping({ provider: 'minimax', upstreamModel: 'upstream-mm' });

		expect(CompletionModelRouting.buildMiniMaxBody(body as never, mm).model).toBe('upstream-mm');
		expect(CompletionModelRouting.buildMiniMaxBody(body as never, null).model).toBe('alias');
	});

	it('narrows openai mapping with isOpenAiMapped', () => {
		const openai = mapping({ provider: 'openai', upstreamModel: 'gpt-up' });

		expect(CompletionModelRouting.isOpenAiMapped(openai)).toBe(true);
		expect(CompletionModelRouting.isOpenAiMapped(null)).toBe(false);
		expect(CompletionModelRouting.isOpenAiMapped(mapping({ provider: 'claude', upstreamModel: 'c' }))).toBe(false);
	});

	it('builds openai upstream body with optional reasoning effort', () => {
		const body = { model: 'alias', messages: [], stream: false } as const;
		const openai = mapping({ provider: 'openai', upstreamModel: 'gpt-real', reasoningBudget: 'high' });
		const upstream = CompletionModelRouting.buildOpenAiUpstreamBody(body as never, openai);

		expect(upstream.model).toBe('gpt-real');
		expect(upstream.reasoning).toEqual({ effort: 'high' });

		const noBudget = mapping({ provider: 'openai', upstreamModel: 'gpt-2', reasoningBudget: null });
		const plain = CompletionModelRouting.buildOpenAiUpstreamBody(body as never, noBudget);

		expect(plain.model).toBe('gpt-2');
		expect('reasoning' in plain).toBe(false);
	});
});

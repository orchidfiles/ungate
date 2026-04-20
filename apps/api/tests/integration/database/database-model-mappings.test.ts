import { describe, expect, it } from 'vitest';

import { ModelMappings } from 'src/database/model-mappings';

describe('database-model-mappings', () => {
	it('sanitizes invalid and trims valid rows', () => {
		const sanitized = ModelMappings.sanitize([
			{
				id: ' a ',
				label: ' A ',
				provider: 'openai',
				upstreamModel: ' gpt-5.4 ',
				sortOrder: 0,
				reasoningBudget: 'high'
			},
			{
				id: ' ',
				label: 'skip',
				provider: 'claude',
				upstreamModel: 'x',
				sortOrder: 1,
				reasoningBudget: null
			}
		]);

		expect(sanitized).toHaveLength(1);
		expect(sanitized[0]).toEqual({
			id: 'a',
			label: 'A',
			provider: 'openai',
			upstreamModel: 'gpt-5.4',
			sortOrder: 0,
			reasoningBudget: 'high'
		});
	});

	it('resolves by id/upstream/case-insensitive', () => {
		ModelMappings.replace([
			{
				id: 'sonnet-4.6',
				label: 'Sonnet',
				provider: 'claude',
				upstreamModel: 'claude-sonnet-4-6',
				sortOrder: 2,
				reasoningBudget: null
			},
			{
				id: 'second',
				label: 'Second',
				provider: 'claude',
				upstreamModel: 'claude-second',
				sortOrder: 3,
				reasoningBudget: null
			}
		]);

		expect(ModelMappings.resolveForChatCompletion('sonnet-4.6')?.upstreamModel).toBe('claude-sonnet-4-6');
		expect(ModelMappings.resolveForChatCompletion('CLAUDE-SONNET-4-6')?.id).toBe('sonnet-4.6');
		expect(ModelMappings.resolveForChatCompletion('second')?.upstreamModel).toBe('claude-second');
	});
});

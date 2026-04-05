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
				enabled: 1 as unknown as boolean,
				sortOrder: 0,
				reasoningBudget: 'high'
			},
			{
				id: ' ',
				label: 'skip',
				provider: 'claude',
				upstreamModel: 'x',
				enabled: true,
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
			enabled: true,
			sortOrder: 0,
			reasoningBudget: 'high'
		});
	});

	it('resolves by id/upstream/case-insensitive among enabled models', () => {
		ModelMappings.replace([
			{
				id: 'sonnet-4.6',
				label: 'Sonnet',
				provider: 'claude',
				upstreamModel: 'claude-sonnet-4-6',
				enabled: true,
				sortOrder: 2,
				reasoningBudget: null
			},
			{
				id: 'disabled',
				label: 'Disabled',
				provider: 'claude',
				upstreamModel: 'claude-disabled',
				enabled: false,
				sortOrder: 3,
				reasoningBudget: null
			}
		]);

		expect(ModelMappings.resolveForChatCompletion('sonnet-4.6')?.upstreamModel).toBe('claude-sonnet-4-6');
		expect(ModelMappings.resolveForChatCompletion('CLAUDE-SONNET-4-6')?.id).toBe('sonnet-4.6');
		expect(ModelMappings.resolveForChatCompletion('disabled')).toBeNull();
	});
});

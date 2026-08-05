import { beforeEach, describe, expect, it } from 'vitest';

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
				reasoningBudget: 'max',
				serviceTier: 'priority'
			},
			{
				id: ' ',
				label: 'skip',
				provider: 'claude',
				upstreamModel: 'x',
				sortOrder: 1,
				reasoningBudget: null,
				serviceTier: null
			}
		]);

		expect(sanitized).toHaveLength(1);
		expect(sanitized[0]).toEqual({
			id: 'a',
			label: 'A',
			provider: 'openai',
			upstreamModel: 'gpt-5.4',
			sortOrder: 0,
			reasoningBudget: 'max',
			serviceTier: 'priority'
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
				reasoningBudget: null,
				serviceTier: null
			},
			{
				id: 'second',
				label: 'Second',
				provider: 'claude',
				upstreamModel: 'claude-second',
				sortOrder: 3,
				reasoningBudget: null,
				serviceTier: null
			}
		]);

		expect(ModelMappings.resolveForChatCompletion('sonnet-4.6')?.upstreamModel).toBe('claude-sonnet-4-6');
		expect(ModelMappings.resolveForChatCompletion('CLAUDE-SONNET-4-6')?.id).toBe('sonnet-4.6');
		expect(ModelMappings.resolveForChatCompletion('second')?.upstreamModel).toBe('claude-second');
	});

	describe('when Cursor drops the trailing reasoning tier from the model id', () => {
		beforeEach(() => {
			ModelMappings.replace([
				{
					id: 'gpt-5.6-sol-medium',
					label: 'GPT-5.6 Sol Medium',
					provider: 'openai',
					upstreamModel: 'gpt-5.6-sol',
					sortOrder: 0,
					reasoningBudget: 'medium',
					serviceTier: 'default'
				},
				{
					id: 'gpt-5.6-sol-fast-medium',
					label: 'GPT-5.6 Sol Fast Medium',
					provider: 'openai',
					upstreamModel: 'gpt-5.6-sol',
					sortOrder: 1,
					reasoningBudget: 'medium',
					serviceTier: 'priority'
				}
			]);
		});

		it('resolves the priority-tier mapping instead of falling through to Claude', () => {
			const resolved = ModelMappings.resolveForChatCompletion('gpt-5.6-sol-fast');

			expect(resolved?.id).toBe('gpt-5.6-sol-fast-medium');
			expect(resolved?.serviceTier).toBe('priority');
		});

		it('resolves the default-tier mapping for the non-fast variant', () => {
			const resolved = ModelMappings.resolveForChatCompletion('gpt-5.6-sol');

			expect(resolved?.id).toBe('gpt-5.6-sol-medium');
			expect(resolved?.serviceTier).toBe('default');
		});

		it('prefers an exact id match over re-attaching a suffix', () => {
			ModelMappings.replace([
				{
					id: 'gpt-5.6-sol',
					label: 'GPT-5.6 Sol',
					provider: 'openai',
					upstreamModel: 'gpt-5.6-sol',
					sortOrder: 0,
					reasoningBudget: null,
					serviceTier: 'default'
				},
				{
					id: 'gpt-5.6-sol-high',
					label: 'GPT-5.6 Sol High',
					provider: 'openai',
					upstreamModel: 'gpt-5.6-sol',
					sortOrder: 1,
					reasoningBudget: 'high',
					serviceTier: 'default'
				}
			]);

			expect(ModelMappings.resolveForChatCompletion('gpt-5.6-sol')?.id).toBe('gpt-5.6-sol');
		});

		it('ignores a suffix that does not match the mapping budget', () => {
			ModelMappings.replace([
				{
					id: 'custom-max',
					label: 'Custom Max',
					provider: 'openai',
					upstreamModel: 'custom-upstream',
					sortOrder: 0,
					reasoningBudget: null,
					serviceTier: null
				}
			]);

			expect(ModelMappings.resolveForChatCompletion('custom')).toBeNull();
		});
	});
});

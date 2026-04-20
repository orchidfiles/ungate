import { describe, expect, it } from 'vitest';

import { Settings } from 'src/database/app-settings';
import { ModelMappings } from 'src/database/model-mappings';
import { getDb, schema } from 'src/database';

describe('database-app-settings', () => {
	it('creates defaults when row is missing', () => {
		const expectedModels = [
			{
				id: 'test-default-model',
				label: 'Test Default Model',
				provider: 'claude' as const,
				upstreamModel: 'claude-test-default-model',
				sortOrder: 0,
				reasoningBudget: null
			}
		];
		ModelMappings.replace(expectedModels);
		const settings = Settings.get();

		expect(settings.port).toBe(47821);
		expect(settings.apiKey).toBeTypeOf('string');
		expect(settings.models).toEqual(expectedModels);
	});

	it('updates subset of fields and model mappings', () => {
		Settings.get();
		const model = {
			id: 'm',
			label: 'M',
			provider: 'claude' as const,
			upstreamModel: 'u',
			sortOrder: 0,
			reasoningBudget: null
		};

		Settings.update({
			quiet: true,
			extraInstruction: 'extra',
			models: [model]
		});

		const settings = Settings.get();
		expect(settings.quiet).toBe(true);
		expect(settings.extraInstruction).toBe('extra');
		expect(settings.models).toEqual([model]);
	});
});

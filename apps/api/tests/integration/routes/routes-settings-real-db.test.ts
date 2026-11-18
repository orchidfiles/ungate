import { describe, expect, it } from 'vitest';

import settingsPlugin from 'src/routes/settings';

import { withPlugin } from '../test-harness';

describe('routes: settings (real database)', () => {
	it('strips unknown fields and saves model to database', async () => {
		const app = await withPlugin(settingsPlugin);

		const postRes = await app.inject({
			method: 'POST',
			url: '/settings',
			payload: {
				quiet: false,
				models: [
					{
						id: 'my-custom-model',
						label: 'My Custom Model',
						provider: 'claude',
						upstreamModel: 'claude-sonnet-4-7',
						sortOrder: 0,
						reasoningBudget: null,
						serviceTier: null,
						enabled: true
					}
				]
			}
		});
		expect(postRes.statusCode).toBe(200);

		const getRes = await app.inject({ method: 'GET', url: '/settings' });
		expect(getRes.statusCode).toBe(200);

		const body = getRes.json<{ models: { id: string }[] }>();
		const saved = body.models.find((m) => m.id === 'my-custom-model');

		expect(saved).toBeDefined();
		expect(saved).not.toHaveProperty('enabled');

		await app.close();
	});

	it('saves a renamed model id and label', async () => {
		const app = await withPlugin(settingsPlugin);
		const model = {
			provider: 'claude',
			upstreamModel: 'claude-opus-5-5',
			sortOrder: 0,
			reasoningBudget: 'xhigh',
			serviceTier: null
		};

		const created = await app.inject({
			method: 'POST',
			url: '/settings',
			payload: {
				models: [{ ...model, id: 'opus-5.5', label: 'Opus 5.5' }]
			}
		});
		expect(created.statusCode).toBe(200);

		const renamed = await app.inject({
			method: 'POST',
			url: '/settings',
			payload: {
				models: [{ ...model, id: 'opus-5.5-xhigh', label: 'Opus 5.5 XHigh' }]
			}
		});
		expect(renamed.statusCode).toBe(200);

		const saved = await app.inject({ method: 'GET', url: '/settings' });
		const body = saved.json<{
			models: { id: string; label: string; reasoningBudget: string | null }[];
		}>();

		expect(body.models).toEqual([
			expect.objectContaining({ id: 'opus-5.5-xhigh', label: 'Opus 5.5 XHigh', reasoningBudget: 'xhigh' })
		]);

		await app.close();
	});

	it('rejects a repeated model id without replacing the saved models', async () => {
		const app = await withPlugin(settingsPlugin);

		const postRes = await app.inject({
			method: 'POST',
			url: '/settings',
			payload: {
				models: [
					{
						id: 'opus-5.5',
						label: 'Opus 5.5',
						provider: 'claude',
						upstreamModel: 'claude-opus-5-5',
						sortOrder: 0,
						reasoningBudget: null,
						serviceTier: null
					},
					{
						id: 'Opus-5.5',
						label: 'Opus 5.5 renamed',
						provider: 'claude',
						upstreamModel: 'claude-opus-5-5',
						sortOrder: 1,
						reasoningBudget: 'xhigh',
						serviceTier: null
					}
				]
			}
		});

		expect(postRes.statusCode).toBe(400);
		expect(postRes.json()).toEqual({ ok: false, error: 'Model ID "Opus-5.5" is used more than once' });

		const getRes = await app.inject({ method: 'GET', url: '/settings' });
		const body = getRes.json<{ models: { id: string }[] }>();

		expect(body.models.find((model) => model.id.toLowerCase() === 'opus-5.5')).toBeUndefined();

		await app.close();
	});
});

import { describe, expect, it } from 'vitest';

import settingsPlugin from 'src/routes/settings';

import { ADMIN_HEADERS, TEST_ADMIN_KEY, withPlugin } from '../test-harness';

describe('routes: settings (real database)', () => {
	it('strips unknown fields and saves model to database', async () => {
		const app = await withPlugin(settingsPlugin);

		const postRes = await app.inject({
			method: 'POST',
			url: '/settings',
			headers: ADMIN_HEADERS,
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

		const getRes = await app.inject({ method: 'GET', url: '/settings', headers: ADMIN_HEADERS });
		expect(getRes.statusCode).toBe(200);

		const body = getRes.json();
		const saved = body.models.find((m: { id: string }) => m.id === 'my-custom-model');

		expect(saved).toBeDefined();
		expect(saved).not.toHaveProperty('enabled');

		// The admin key lives in the environment only; it must never travel back through settings.
		expect(body).not.toHaveProperty('adminApiKey');
		expect(getRes.body).not.toContain(TEST_ADMIN_KEY);

		await app.close();
	});
});

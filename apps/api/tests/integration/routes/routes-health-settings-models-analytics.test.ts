import { afterEach, describe, expect, it, vi } from 'vitest';

import analyticsPlugin from 'src/routes/analytics';
import healthPlugin from 'src/routes/health';
import modelsPlugin from 'src/routes/models';
import settingsPlugin from 'src/routes/settings';

import { withPlugin } from '../test-harness';

const settingsGetMock = vi.fn();
const settingsUpdateMock = vi.fn();
const analyticsSummaryMock = vi.fn();
const analyticsRecentMock = vi.fn();
const analyticsResetMock = vi.fn();

vi.mock('src/database/app-settings', () => ({
	Settings: {
		get: (...args: unknown[]) => settingsGetMock(...args),
		update: (...args: unknown[]) => settingsUpdateMock(...args)
	}
}));

vi.mock('src/database/analytics', () => ({
	Analytics: {
		getSummary: (...args: unknown[]) => analyticsSummaryMock(...args),
		getRecent: (...args: unknown[]) => analyticsRecentMock(...args),
		reset: (...args: unknown[]) => analyticsResetMock(...args)
	}
}));

describe('routes: health/settings/models/analytics', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('health returns ok', async () => {
		const app = await withPlugin(healthPlugin);
		const response = await app.inject({ method: 'GET', url: '/health' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ status: 'ok' });
		await app.close();
	});

	it('settings get and post delegate to Settings', async () => {
		settingsGetMock.mockReturnValueOnce({
			port: 4783,
			apiKey: 'k',
			quiet: false,
			extraInstruction: '',
			models: []
		});

		const app = await withPlugin(settingsPlugin);
		const getRes = await app.inject({ method: 'GET', url: '/settings' });
		expect(getRes.statusCode).toBe(200);
		expect(getRes.json().port).toBe(4783);

		const postRes = await app.inject({
			method: 'POST',
			url: '/settings',
			payload: { quiet: true }
		});
		expect(postRes.statusCode).toBe(200);
		expect(postRes.json()).toEqual({ ok: true });
		expect(settingsUpdateMock).toHaveBeenCalledWith({ quiet: true });
		await app.close();
	});

	it('models returns all mappings', async () => {
		settingsGetMock.mockReturnValueOnce({
			models: [
				{ id: 'm1', provider: 'claude' },
				{ id: 'm2', provider: 'openai' }
			]
		});

		const app = await withPlugin(modelsPlugin);
		const response = await app.inject({ method: 'GET', url: '/v1/models' });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			object: 'list',
			data: [
				{ id: 'm1', object: 'model', created: 1700000000, owned_by: 'claude' },
				{ id: 'm2', object: 'model', created: 1700000000, owned_by: 'openai' }
			]
		});
		await app.close();
	});

	it('analytics supports period, limit clamp and reset', async () => {
		analyticsSummaryMock.mockReturnValueOnce({
			totalRequests: 1,
			claudeRequests: 1,
			minimaxRequests: 0,
			openaiRequests: 0,
			errorRequests: 0,
			totalInputTokens: 10,
			totalOutputTokens: 20,
			periodStart: 0,
			periodEnd: 0
		});
		analyticsRecentMock.mockReturnValueOnce([{ id: 1 }]);
		analyticsResetMock.mockReturnValueOnce({ deletedCount: 4 });

		const app = await withPlugin(analyticsPlugin);

		const summary = await app.inject({ method: 'GET', url: '/analytics?period=all' });
		expect(summary.statusCode).toBe(200);
		expect(summary.json().period).toBe('all');
		expect(summary.json().note).toContain('Costs are estimates');

		await app.inject({ method: 'GET', url: '/analytics/requests?limit=9999' });
		expect(analyticsRecentMock).toHaveBeenCalledWith(1000);

		const reset = await app.inject({ method: 'POST', url: '/analytics/reset' });
		expect(reset.json()).toEqual({ success: true, deletedCount: 4 });
		await app.close();
	});
});

import cors from '@fastify/cors';
import { describe, expect, it } from 'vitest';

import authPlugin from 'src/routes/auth';
import { CORS_OPTIONS } from 'src/server';

import { createTestApp } from '../test-harness';

import type { FastifyInstance } from 'fastify';

/** Same CORS registration as `startServer`, so the dashboard webview's cross-origin preflights are covered. */
async function appWithCors(): Promise<FastifyInstance> {
	const app = createTestApp();
	await app.register(cors, CORS_OPTIONS);
	await app.register(authPlugin);
	await app.ready();

	return app;
}

function allowedMethods(header: string | string[] | number | undefined): string[] {
	return String(header ?? '')
		.split(',')
		.map((method) => method.trim().toUpperCase())
		.filter(Boolean);
}

describe('CORS for account routes', () => {
	it.each([
		['PATCH', '/auth/claude/accounts/some-id'],
		['PATCH', '/auth/openai/policy'],
		['DELETE', '/auth/openai/accounts/some-id'],
		['POST', '/auth/claude/accounts/some-id/select']
	])('allows a %s preflight to %s from the dashboard origin', async (method, url) => {
		const app = await appWithCors();
		try {
			const response = await app.inject({
				method: 'OPTIONS',
				url,
				headers: {
					origin: 'vscode-webview://dashboard',
					'access-control-request-method': method,
					'access-control-request-headers': 'content-type'
				}
			});

			expect(response.statusCode).toBe(204);
			expect(response.headers['access-control-allow-origin']).toBe('*');
			const methods = allowedMethods(response.headers['access-control-allow-methods']);
			expect(methods).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH', 'DELETE']));
		} finally {
			await app.close();
		}
	});

	it('adds the allow-origin header to actual cross-origin account responses', async () => {
		const app = await appWithCors();
		try {
			const response = await app.inject({
				method: 'GET',
				url: '/auth/claude/accounts',
				headers: { origin: 'vscode-webview://dashboard' }
			});

			expect(response.statusCode).toBe(200);
			expect(response.headers['access-control-allow-origin']).toBe('*');
		} finally {
			await app.close();
		}
	});
});

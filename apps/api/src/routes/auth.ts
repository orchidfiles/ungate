import { OAuth } from '../auth/oauth';
import { OpenAIOAuthService } from '../auth/openai/openai-oauth-service';
import { config } from '../config';
import { ProviderSettings } from '../database/provider-settings';

import type { FastifyPluginCallback } from 'fastify';

const plugin: FastifyPluginCallback = (app) => {
	app.post('/auth/claude/start', async (_request, reply) => {
		const result = await OAuth.startLogin();

		return reply.send(result);
	});

	app.post('/auth/claude/complete', async (request, reply) => {
		const { code, sessionId } = request.body as { code: string; sessionId: string };

		if (!code || !sessionId) {
			return reply.code(400).send({ ok: false, error: 'Missing code or sessionId' });
		}

		const result = await OAuth.completeLogin(code, sessionId);

		return reply.send(result);
	});

	app.get('/auth/claude/status', (_request, reply) => {
		return reply.send(OAuth.getAuthStatus());
	});

	app.post('/auth/claude/logout', (_request, reply) => {
		OAuth.logout();

		return reply.send({ ok: true });
	});

	app.get('/auth/minimax/status', (_request, reply) => {
		const creds = ProviderSettings.get('minimax');

		return reply.send({
			authenticated: !!creds?.accessToken,
			baseUrl: creds?.baseUrl ?? config.minimax.baseUrlGlobal
		});
	});

	app.post('/auth/minimax/login', async (request, reply) => {
		const { apiKey, baseUrl } = request.body as { apiKey: string; baseUrl?: string };

		if (!apiKey?.trim()) {
			return reply.code(400).send({ ok: false, error: 'API key is required' });
		}

		ProviderSettings.upsertApiKey('minimax', apiKey.trim(), baseUrl?.trim());

		return reply.send({ ok: true });
	});

	app.post('/auth/minimax/base-url', async (request, reply) => {
		const { baseUrl } = request.body as { baseUrl?: string };
		const trimmedBaseUrl = baseUrl?.trim();

		if (!trimmedBaseUrl) {
			return reply.code(400).send({ ok: false, error: 'Base URL is required' });
		}

		const updated = ProviderSettings.updateBaseUrl('minimax', trimmedBaseUrl);

		if (!updated) {
			return reply.code(400).send({ ok: false, error: 'MiniMax is not configured yet' });
		}

		return reply.send({ ok: true });
	});

	app.post('/auth/minimax/logout', (_request, reply) => {
		ProviderSettings.remove('minimax');

		return reply.send({ ok: true });
	});

	app.get('/auth/openai/start', async (_request, reply) => {
		const result = await OpenAIOAuthService.startLogin();

		return reply.send(result);
	});

	app.get('/auth/openai/callback', async (request, reply) => {
		const { code, state: sessionId } = request.query as { code?: string; state?: string };
		if (!code || !sessionId) {
			return reply
				.type('text/html')
				.send('<html><body><h1>Missing code or session</h1><p>Please close this window and try again.</p></body></html>');
		}
		const result = await OpenAIOAuthService.completeLogin(code, sessionId);
		if (result.ok) {
			return reply
				.type('text/html')
				.send('<html><body><h1>Connected!</h1><p>You can close this window.</p><script>window.close()</script></body></html>');
		}

		return reply.type('text/html').send(`<html><body><h1>Error</h1><p>${result.error ?? 'Unknown error'}</p></body></html>`);
	});

	app.get('/auth/openai/status', (_request, reply) => {
		return reply.send(OpenAIOAuthService.getAuthStatus());
	});

	app.post('/auth/openai/logout', (_request, reply) => {
		OpenAIOAuthService.logout();

		return reply.send({ ok: true });
	});
};

export default plugin;

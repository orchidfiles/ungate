import { OAuth } from '../auth/oauth';
import { config } from '../config';
import { ProviderSettings } from '../database/settings';

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

	app.post('/auth/minimax/logout', (_request, reply) => {
		ProviderSettings.remove('minimax');

		return reply.send({ ok: true });
	});
};

export default plugin;

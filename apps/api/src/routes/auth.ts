import { z } from 'zod';

import { logger } from 'src/utils/logger';

import { AccountNotFoundError, LoginConflictError } from '../auth/account-login-sessions';
import { GeminiOAuthNotConfiguredError } from '../auth/gemini/gemini-oauth-client';
import { GeminiOAuthService } from '../auth/gemini/gemini-oauth-service';
import { GeminiOAuthUtils } from '../auth/gemini/gemini-oauth-utils';
import { OAuth } from '../auth/oauth';
import { OpenAIOAuthService } from '../auth/openai/openai-oauth-service';
import { OpenAIOAuthUtils } from '../auth/openai/openai-oauth-utils';
import { config } from '../config';
import { OAuthAccounts } from '../database/oauth-accounts';
import { ProviderSettings } from '../database/provider-settings';
import { UsageFetcher } from '../usage/usage-fetcher';

import type { AccountErrorCode, AccountErrorResponse, SubscriptionProvider } from '@ungate/shared';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

const idSchema = z.string().min(1).max(200);
const startSchema = z.object({ accountId: idSchema.optional() });
const completeSchema = z.object({ code: z.string().trim().min(1).max(16384), sessionId: idSchema });
const renameSchema = z.object({ label: z.string().trim().min(1).max(100) });
const selectSchema = z.object({ revision: z.number().int().nonnegative().optional() });
const usageRefreshSchema = z.object({ accountId: idSchema.optional() });
const policySchema = z.object({ autoSwitch: z.boolean(), revision: z.number().int().nonnegative().optional() });

interface IdParams {
	Params: { id: string };
}
interface SessionParams {
	Params: { sessionId: string };
}

function fail(
	reply: FastifyReply,
	status: number,
	code: AccountErrorCode,
	error: string,
	extra: Partial<AccountErrorResponse> = {}
) {
	const body: AccountErrorResponse = { error, code, ...extra };

	return reply.code(status).send(body);
}

const services = { claude: OAuth, openai: OpenAIOAuthService, gemini: GeminiOAuthService } as const;

async function startLogin(provider: SubscriptionProvider, input: unknown, reply: FastifyReply) {
	const parsed = startSchema.safeParse(input ?? {});
	if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Invalid login request');
	try {
		const result = await services[provider].startLogin(parsed.data.accountId);

		return reply.send(result);
	} catch (error) {
		if (error instanceof AccountNotFoundError) return fail(reply, 404, 'account_not_found', 'Account not found');
		if (error instanceof GeminiOAuthNotConfiguredError) return fail(reply, 503, 'login_not_configured', error.message);
		if (error instanceof LoginConflictError) {
			return fail(reply, 409, 'login_pending', 'Another login is already pending; cancel it first', {
				pendingSessionId: error.pendingSessionId || undefined
			});
		}
		logger.error(`Failed to start ${provider} login: ${error instanceof Error ? error.message : String(error)}`);

		return fail(reply, 503, 'login_start_failed', 'Cannot start login; the OAuth callback port may be in use');
	}
}

const plugin: FastifyPluginCallback = (app) => {
	for (const provider of ['claude', 'openai', 'gemini'] as const) {
		const service = services[provider];
		const base = `/auth/${provider}`;

		app.post(`${base}/start`, (request, reply) => startLogin(provider, request.body, reply));

		app.get(`${base}/accounts`, (_request, reply) => reply.send(OAuthAccounts.view(provider)));

		app.patch<IdParams>(`${base}/accounts/:id`, (request, reply) => {
			const parsed = renameSchema.safeParse(request.body);
			if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Label must contain 1–100 characters');
			if (!OAuthAccounts.rename(provider, request.params.id, parsed.data.label))
				return fail(reply, 404, 'account_not_found', 'Account not found');

			return reply.send(OAuthAccounts.view(provider));
		});

		app.post<IdParams>(`${base}/accounts/:id/select`, (request, reply) => {
			const parsed = selectSchema.safeParse(request.body ?? {});
			if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Invalid revision');
			const account = OAuthAccounts.get(request.params.id, provider);
			if (!account) return fail(reply, 404, 'account_not_found', 'Account not found');
			if (!OAuthAccounts.isEligible(account)) {
				return fail(
					reply,
					409,
					'account_unavailable',
					account.needsLogin ? 'Account needs to be reconnected' : 'Account is cooling down'
				);
			}
			if (!OAuthAccounts.select(provider, account.id, parsed.data.revision))
				return fail(reply, 409, 'revision_conflict', 'Account selection changed; reload and try again');

			return reply.send(OAuthAccounts.view(provider));
		});

		app.delete<IdParams>(`${base}/accounts/:id`, (request, reply) => {
			if (!OAuthAccounts.remove(provider, request.params.id)) return fail(reply, 404, 'account_not_found', 'Account not found');

			return reply.send(OAuthAccounts.view(provider));
		});

		app.post(`${base}/usage/refresh`, async (request, reply) => {
			const parsed = usageRefreshSchema.safeParse(request.body ?? {});
			if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Invalid usage refresh request');
			const { accountId } = parsed.data;
			if (accountId && !OAuthAccounts.get(accountId, provider)) return fail(reply, 404, 'account_not_found', 'Account not found');
			await UsageFetcher.refresh(provider, accountId);

			return reply.send(OAuthAccounts.view(provider));
		});

		app.post<IdParams>(`${base}/accounts/:id/clear-cooldown`, (request, reply) => {
			const account = OAuthAccounts.get(request.params.id, provider);
			if (!account) return fail(reply, 404, 'account_not_found', 'Account not found');
			if (OAuthAccounts.clearCooldown(account.id, undefined, provider)) {
				logger.log(`[accounts] ${provider} account ${account.id} cooldown cleared manually`);
			}

			return reply.send(OAuthAccounts.view(provider));
		});

		app.patch(`${base}/policy`, (request, reply) => {
			const parsed = policySchema.safeParse(request.body);
			if (!parsed.success) return fail(reply, 400, 'invalid_request', 'Invalid policy');
			if (!OAuthAccounts.setAutoSwitch(provider, parsed.data.autoSwitch, parsed.data.revision))
				return fail(reply, 409, 'revision_conflict', 'Account policy changed; reload and try again');

			return reply.send(OAuthAccounts.view(provider));
		});

		app.get<SessionParams>(`${base}/sessions/:sessionId`, (request, reply) => {
			const session = service.getSession(request.params.sessionId);

			return session ? reply.send(session) : fail(reply, 404, 'session_not_found', 'Session not found');
		});

		app.post<SessionParams>(`${base}/sessions/:sessionId/cancel`, async (request, reply) => {
			const cancelled = await service.cancelLogin(request.params.sessionId);
			const session = service.getSession(request.params.sessionId);

			return cancelled && session ? reply.send(session) : fail(reply, 404, 'session_not_found', 'Session not found');
		});
	}

	app.post('/auth/claude/complete', async (request, reply) => {
		const parsed = completeSchema.safeParse(request.body);
		if (!parsed.success) return reply.code(400).send({ ok: false, error: 'Missing code or sessionId' });
		const result = await OAuth.completeLogin(parsed.data.code, parsed.data.sessionId);

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

	// Legacy GET form used by the current dashboard; same semantics as POST /auth/openai/start.
	app.get('/auth/openai/start', (request, reply) => startLogin('openai', request.query, reply));

	app.get('/auth/openai/callback', async (request, reply) => {
		const { code, state: sessionId } = request.query as { code?: string; state?: string };
		if (!code || !sessionId) {
			return reply
				.type('text/html')
				.send('<html><body><h1>Missing code or session</h1><p>Please close this window and try again.</p></body></html>');
		}
		const result = await OpenAIOAuthService.completeLogin(code, sessionId);

		return reply.type('text/html').send(OpenAIOAuthUtils.callbackPage(result.ok, result.error));
	});

	app.get('/auth/openai/status', (_request, reply) => {
		return reply.send(OpenAIOAuthService.getAuthStatus());
	});

	app.post('/auth/openai/logout', (_request, reply) => {
		OpenAIOAuthService.logout();

		return reply.send({ ok: true });
	});

	// Normal Gemini logins finish on the loopback listener; this completes a callback forwarded to the API.
	app.get('/auth/gemini/callback', async (request, reply) => {
		const { code, state: sessionId } = request.query as { code?: string; state?: string };
		if (!code || !sessionId) {
			return reply
				.type('text/html')
				.send('<html><body><h1>Missing code or session</h1><p>Please close this window and try again.</p></body></html>');
		}
		const result = await GeminiOAuthService.completeLogin(code, sessionId);
		if (result.ok) return reply.redirect(GeminiOAuthUtils.successRedirect());

		return reply.code(400).type('text/html').send(GeminiOAuthUtils.callbackPage(false, result.error));
	});

	app.get('/auth/gemini/status', (_request, reply) => {
		return reply.send(GeminiOAuthService.getAuthStatus());
	});

	app.post('/auth/gemini/logout', (_request, reply) => {
		GeminiOAuthService.logout();

		return reply.send({ ok: true });
	});
};

export default plugin;

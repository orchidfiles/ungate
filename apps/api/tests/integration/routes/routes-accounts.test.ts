import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountLoginSessions } from 'src/auth/account-login-sessions';
import { OpenAICallbackServer } from 'src/auth/openai/callback-server';
import { OAuthAccounts } from 'src/database/oauth-accounts';
import authPlugin from 'src/routes/auth';

import { withPlugin } from '../test-harness';

import type { AccountErrorResponse, AccountListResponse, AccountLoginSession, AccountLoginStartResponse } from '@ungate/shared';
import type { LightMyRequestResponse } from 'fastify';

const save = (provider: 'claude' | 'openai', user: string) =>
	OAuthAccounts.saveLogin(
		provider,
		{ accessToken: `private-access-${user}`, refreshToken: `private-refresh-${user}` },
		{ providerUserId: user, email: `${user}@example.com` },
		OAuthAccounts.list(provider)
	);

const asJson = <T>(response: LightMyRequestResponse): T => response.json<T>();

beforeEach(() => {
	AccountLoginSessions.reset();
	vi.spyOn(OpenAICallbackServer, 'start').mockResolvedValue();
	vi.spyOn(OpenAICallbackServer, 'stop').mockResolvedValue();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('account routes', () => {
	it('validates mutations, uses revisions, and returns only safe DTOs', async () => {
		const row = save('claude', 'user');
		const other = save('claude', 'other');
		const app = await withPlugin(authPlugin);
		try {
			const list = await app.inject({ method: 'GET', url: '/auth/claude/accounts' });
			expect(list.statusCode).toBe(200);
			expect(list.body).not.toMatch(/private-|accessToken|refreshToken|credentialVersion/);
			const listed = asJson<AccountListResponse>(list);
			expect(listed.accounts.map((account) => [account.id, account.active])).toEqual([
				[row.id, true],
				[other.id, false]
			]);
			const revision = listed.policy.revision;

			const invalid = await app.inject({ method: 'PATCH', url: `/auth/claude/accounts/${row.id}`, payload: { label: ' ' } });
			expect(invalid.statusCode).toBe(400);
			expect(asJson<AccountErrorResponse>(invalid).code).toBe('invalid_request');
			const renamed = await app.inject({ method: 'PATCH', url: `/auth/claude/accounts/${row.id}`, payload: { label: ' Work ' } });
			expect(asJson<AccountListResponse>(renamed).accounts[0].label).toBe('Work');

			const policy = await app.inject({ method: 'PATCH', url: '/auth/claude/policy', payload: { autoSwitch: false, revision } });
			expect(asJson<AccountListResponse>(policy).policy.autoSwitch).toBe(false);
			const stale = await app.inject({ method: 'POST', url: `/auth/claude/accounts/${other.id}/select`, payload: { revision } });
			expect(stale.statusCode).toBe(409);
			expect(asJson<AccountErrorResponse>(stale).code).toBe('revision_conflict');
			const selected = await app.inject({ method: 'POST', url: `/auth/claude/accounts/${other.id}/select`, payload: {} });
			expect(asJson<AccountListResponse>(selected).policy).toMatchObject({
				activeAccountId: other.id,
				lastSwitchReason: 'manual'
			});

			OAuthAccounts.markCooldown(row.id, Date.now() + 60_000, 'usage_limit', true);
			const cooling = await app.inject({ method: 'POST', url: `/auth/claude/accounts/${row.id}/select` });
			expect(cooling.statusCode).toBe(409);
			expect(asJson<AccountErrorResponse>(cooling).code).toBe('account_unavailable');

			const crossProvider = await app.inject({ method: 'DELETE', url: `/auth/openai/accounts/${row.id}` });
			expect(crossProvider.statusCode).toBe(404);
			const removed = await app.inject({ method: 'DELETE', url: `/auth/claude/accounts/${other.id}` });
			const afterRemoval = asJson<AccountListResponse>(removed);
			// Only remaining account is cooling down → nothing eligible to activate.
			expect(afterRemoval.policy.activeAccountId).toBeNull();
			expect(afterRemoval.accounts).toHaveLength(1);
		} finally {
			await app.close();
		}
	});

	it('runs session status and cancel endpoints without leaking PKCE material', async () => {
		const row = save('claude', 'user');
		const app = await withPlugin(authPlugin);
		try {
			const missing = await app.inject({ method: 'POST', url: '/auth/claude/start', payload: { accountId: 'nope' } });
			expect(missing.statusCode).toBe(404);
			const start = await app.inject({ method: 'POST', url: '/auth/claude/start', payload: { accountId: row.id } });
			const { sessionId, authUrl } = asJson<AccountLoginStartResponse>(start);
			expect(authUrl).toContain(`state=${sessionId}`);
			const status = await app.inject({ method: 'GET', url: `/auth/claude/sessions/${sessionId}` });
			expect(status.json()).toMatchObject({ status: 'pending', provider: 'claude', reconnectAccountId: row.id });
			expect(status.body).not.toMatch(/verifier|snapshot|private-/);
			const wrongProvider = await app.inject({ method: 'GET', url: `/auth/openai/sessions/${sessionId}` });
			expect(wrongProvider.statusCode).toBe(404);
			const cancel = await app.inject({ method: 'POST', url: `/auth/claude/sessions/${sessionId}/cancel` });
			expect(asJson<AccountLoginSession>(cancel).status).toBe('cancelled');
			const unknown = await app.inject({ method: 'POST', url: '/auth/claude/sessions/unknown/cancel' });
			expect(unknown.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	it('reports overlapping OpenAI logins as 409 with the pending session id; legacy logout keeps the pool', async () => {
		const a = save('openai', 'a');
		const b = save('openai', 'b');
		const app = await withPlugin(authPlugin);
		try {
			const first = await app.inject({ method: 'POST', url: '/auth/openai/start', payload: {} });
			expect(first.statusCode).toBe(200);
			const firstSessionId = asJson<AccountLoginStartResponse>(first).sessionId;
			const second = await app.inject({ method: 'GET', url: '/auth/openai/start' });
			expect(second.statusCode).toBe(409);
			expect(second.json()).toMatchObject({ code: 'login_pending', pendingSessionId: firstSessionId });
			await app.inject({ method: 'POST', url: `/auth/openai/sessions/${firstSessionId}/cancel` });

			vi.spyOn(OpenAICallbackServer, 'start').mockRejectedValueOnce(new Error('EADDRINUSE'));
			const portBusy = await app.inject({ method: 'POST', url: '/auth/openai/start', payload: {} });
			expect(portBusy.statusCode).toBe(503);
			expect(AccountLoginSessions.hasPending('openai')).toBe(false);

			await app.inject({ method: 'POST', url: '/auth/openai/logout' });
			expect(OAuthAccounts.get(a.id)).toBeUndefined();
			expect(OAuthAccounts.active('openai')?.id).toBe(b.id);
			const status = await app.inject({ method: 'GET', url: '/auth/openai/status' });
			expect(status.json()).toEqual({ authenticated: true, email: 'b@example.com' });
		} finally {
			await app.close();
		}
	});
});

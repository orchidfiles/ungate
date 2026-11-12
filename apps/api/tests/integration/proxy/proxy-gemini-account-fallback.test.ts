import { afterEach, describe, expect, it, vi } from 'vitest';

import { OAuthAccounts, type OAuthAccountRow } from 'src/database/oauth-accounts';
import { GeminiClient } from 'src/proxy/gemini-client';

import type { ModelMappingConfig } from '@ungate/shared';

const mapping: ModelMappingConfig = {
	id: 'ungate-gemini-4-carbon-medium',
	label: 'Gemini 4 Carbon (medium)',
	provider: 'gemini',
	upstreamModel: 'gemini-4-carbon',
	sortOrder: 0,
	reasoningBudget: 'medium',
	serviceTier: null
};

const body = (stream = false) =>
	({ model: 'ungate-gemini-4-carbon-medium', messages: [{ role: 'user', content: 'hi' }], stream }) as never;

function add(user: string, project: string | null = `project-${user}`): OAuthAccountRow {
	return OAuthAccounts.saveLogin(
		'gemini',
		{ accessToken: `token-${user}`, refreshToken: `refresh-${user}`, expiresAt: Date.now() + 3_600_000 },
		{ providerUserId: user, providerAccountId: project, email: `${user}@example.com` },
		OAuthAccounts.list('gemini')
	);
}

const quotaExhausted = (retryDelay = '3600s') =>
	new Response(
		JSON.stringify({
			error: {
				code: 429,
				status: 'RESOURCE_EXHAUSTED',
				message: 'You have exhausted your capacity on this model.',
				details: [
					{
						'@type': 'type.googleapis.com/google.rpc.ErrorInfo',
						reason: 'QUOTA_EXHAUSTED',
						domain: 'cloudcode-pa.googleapis.com'
					},
					{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }
				]
			}
		}),
		{ status: 429, headers: { 'content-type': 'application/json' } }
	);

const geminiSse = (text: string) =>
	new Response(
		`data: ${JSON.stringify({
			response: {
				candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
				usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 }
			}
		})}\n\n`,
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);

interface Sent {
	auth: string;
	envelope: { model: string; project: string; user_prompt_id: string; request: Record<string, unknown> };
}

function stubUpstream(responses: (() => Response)[]): Sent[] {
	const sent: Sent[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init?: RequestInit) => {
			expect(url).toBe('https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
			sent.push({
				auth: (init?.headers as Record<string, string>).Authorization,
				envelope: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['envelope']
			});

			return Promise.resolve(responses[sent.length - 1]());
		})
	);

	return sent;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Gemini account fallback (GeminiClient.proxy)', () => {
	it('sends the Code Assist envelope pinned to the account project', async () => {
		add('a');
		const sent = stubUpstream([() => geminiSse('hello')]);

		const result = await GeminiClient.proxy(body(), mapping);

		expect(result.response.status).toBe(200);
		const json: unknown = await result.response.json();
		expect(json).toMatchObject({ choices: [{ message: { content: 'hello' } }] });
		expect(sent[0].auth).toBe('Bearer token-a');
		expect(sent[0].envelope).toMatchObject({
			model: 'gemini-4-carbon',
			project: 'project-a',
			request: { generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'medium' } } }
		});
		expect(sent[0].envelope.user_prompt_id).toBeTruthy();
		expect(result.context).toMatchObject({ source: 'gemini', inputTokens: 3, outputTokens: 2 });
	});

	it('429 QUOTA_EXHAUSTED on A rotates to B, which becomes active while A cools down until the RetryInfo reset', async () => {
		const a = add('a');
		const b = add('b');
		OAuthAccounts.select('gemini', a.id);
		const sent = stubUpstream([() => quotaExhausted('3600s'), () => geminiSse('from b')]);
		const before = Date.now();

		const result = await GeminiClient.proxy(body(), mapping);

		expect(result.response.status).toBe(200);
		const json: unknown = await result.response.json();
		expect(json).toMatchObject({ choices: [{ message: { content: 'from b' } }] });
		expect(sent.map((call) => [call.auth, call.envelope.project])).toEqual([
			['Bearer token-a', 'project-a'],
			['Bearer token-b', 'project-b']
		]);
		expect(sent[0].envelope.user_prompt_id).toBe(sent[1].envelope.user_prompt_id);
		const policy = OAuthAccounts.policy('gemini');
		expect(policy.activeAccountId).toBe(b.id);
		expect(policy.lastSwitchReason).toBe('gemini_quota_exhausted');
		const cooled = OAuthAccounts.get(a.id)!;
		expect(cooled.cooldownReason).toBe('gemini_quota_exhausted');
		expect(cooled.cooldownEstimated).toBe(false);
		expect(cooled.cooldownUntil).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(result.context.telemetry).toMatchObject({ accountId: b.id, attempts: 2, rotationReason: 'gemini_quota_exhausted' });
	});

	it('returns a 429 usage_limit_reached when every account is exhausted', async () => {
		add('a');
		add('b');
		stubUpstream([() => quotaExhausted('600s'), () => quotaExhausted('1200s')]);

		const result = await GeminiClient.proxy(body(), mapping);

		expect(result.response.status).toBe(429);
		const json: { error: { type: string; message: string } } = await result.response.json();
		expect(json.error.type).toBe('usage_limit_reached');
		expect(json.error.message).toContain('Gemini');
	});

	it('does not rotate on MODEL_CAPACITY_EXHAUSTED (Google-side capacity)', async () => {
		const a = add('a');
		add('b');
		OAuthAccounts.select('gemini', a.id);
		const sent = stubUpstream([
			() =>
				new Response(
					JSON.stringify({
						error: {
							code: 429,
							status: 'RESOURCE_EXHAUSTED',
							message: 'No capacity available for model gemini-4-carbon',
							details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_CAPACITY_EXHAUSTED' }]
						}
					}),
					{ status: 429, headers: { 'content-type': 'application/json' } }
				)
		]);

		const result = await GeminiClient.proxy(body(), mapping);

		expect(sent).toHaveLength(1);
		expect(result.response.status).toBe(429);
		const json: unknown = await result.response.json();
		expect(json).toMatchObject({ error: { type: 'rate_limit_error', code: 'resource_exhausted' } });
		expect(OAuthAccounts.get(a.id)?.cooldownUntil).toBeNull();
	});

	it('asks for sign-in when no account is usable, and for a reconnect when the account has no project', async () => {
		stubUpstream([]);
		const none = await GeminiClient.proxy(body(), mapping);
		expect(none.response.status).toBe(401);
		const noneJson: unknown = await none.response.json();
		expect(noneJson).toMatchObject({ error: { message: expect.stringContaining('Sign in') } });

		add('a', null);
		const noProject = await GeminiClient.proxy(body(), mapping);
		expect(noProject.response.status).toBe(401);
		const noProjectJson: unknown = await noProject.response.json();
		expect(noProjectJson).toMatchObject({ error: { message: expect.stringContaining('Code Assist project') } });
	});
});

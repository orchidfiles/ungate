import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSqlite } from 'src/database';
import { OAuthAccounts, type OAuthAccountRow } from 'src/database/oauth-accounts';
import { Requests } from 'src/database/requests';
import responsesPlugin from 'src/routes/responses';

import { withPlugin } from '../test-harness';

const encoder = new TextEncoder();
const event = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`;

function add(user: string): OAuthAccountRow {
	return OAuthAccounts.saveLogin(
		'openai',
		{ accessToken: `token-${user}`, refreshToken: `refresh-${user}`, expiresAt: Date.now() + 3_600_000 },
		{ providerUserId: user, providerAccountId: `ws-${user}`, email: `${user}@example.com` },
		OAuthAccounts.list('openai')
	);
}

function sse(chunks: string[]): Response {
	let index = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
			else controller.close();
		}
	});

	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const completed = [
	event({ type: 'response.created', response: { id: 'resp_1' } }),
	event({
		type: 'response.output_item.added',
		output_index: 0,
		item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'shell' }
	}),
	event({
		type: 'response.output_item.done',
		output_index: 0,
		item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'shell', arguments: '{}' }
	}),
	event({
		type: 'response.completed',
		response: {
			id: 'resp_1',
			usage: {
				input_tokens: 120,
				input_tokens_details: { cached_tokens: 100 },
				output_tokens: 30,
				output_tokens_details: { reasoning_tokens: 12 }
			}
		}
	})
];

const codexRequest = {
	model: 'gpt-5.5',
	instructions: 'be brief',
	input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
	tools: [{ type: 'function', name: 'shell', parameters: {} }],
	stream: true
};

function lastRow() {
	return getSqlite().prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('routes-responses', () => {
	it('sends the Codex body to the pool as is and forwards the stream byte for byte, recording usage', async () => {
		const account = add('a');
		const sent: { url: string; init: RequestInit }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init: RequestInit) => {
				sent.push({ url, init });

				return Promise.resolve(sse(completed));
			})
		);

		const app = await withPlugin(responsesPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: {
				authorization: 'Bearer secret',
				'session-id': 'sess-1',
				'thread-id': 'thread-1',
				originator: 'codex_exec',
				'x-codex-turn-metadata': 't'
			},
			payload: codexRequest
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toBe(completed.join(''));

		expect(sent).toHaveLength(1);
		expect(sent[0].url).toMatch(/\/codex\/responses$/);
		expect(JSON.parse(sent[0].init.body as string)).toEqual(codexRequest);
		const headers = sent[0].init.headers as Record<string, string>;
		expect(headers.authorization).toBe('Bearer token-a');
		expect(headers['chatgpt-account-id']).toBe('ws-a');
		expect(headers['session-id']).toBe('sess-1');
		expect(headers['thread-id']).toBe('thread-1');
		expect(headers.originator).toBe('codex_exec');
		expect(headers['x-codex-turn-metadata']).toBe('t');

		const row = lastRow();
		expect(row).toMatchObject({
			model: 'gpt-5.5',
			source: 'openai',
			account_id: account.id,
			stream: 1,
			input_tokens: 120,
			output_tokens: 30,
			cache_read_tokens: 100,
			reasoning_tokens: 12,
			stop_reason: 'tool_use',
			error: null
		});
		expect(JSON.parse(row.tool_names as string)).toEqual(['shell']);
		expect(row.session_key).toEqual(expect.any(String));
		await app.close();
	});

	it('rotates to the next account on an early usage limit before forwarding anything', async () => {
		add('a');
		const b = add('b');
		const seen: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((_url: string, init: RequestInit) => {
				seen.push((init.headers as Record<string, string>).authorization);

				return Promise.resolve(
					seen.length === 1
						? sse([
								event({ type: 'response.created', response: { id: 'resp_a' } }),
								event({
									type: 'response.failed',
									response: { error: { code: 'usage_limit_reached', message: 'Usage limit reached' } }
								})
							])
						: sse(completed)
				);
			})
		);

		const app = await withPlugin(responsesPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: { authorization: 'Bearer secret' },
			payload: codexRequest
		});

		expect(seen).toEqual(['Bearer token-a', 'Bearer token-b']);
		expect(response.body).toBe(completed.join(''));
		expect(lastRow()).toMatchObject({ account_id: b.id, attempts: 2, error: null });
		await app.close();
	});

	it('records a stream that fails after output as an error', async () => {
		add('a');
		const failed = [
			event({ type: 'response.created', response: { id: 'resp_1' } }),
			event({ type: 'response.output_text.delta', output_index: 0, delta: 'x'.repeat(5000) }),
			event({ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } })
		];
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(sse(failed)))
		);

		const app = await withPlugin(responsesPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: { authorization: 'Bearer secret' },
			payload: codexRequest
		});

		expect(response.body).toBe(failed.join(''));
		expect(lastRow()).toMatchObject({ source: 'error', stop_reason: 'error', error: 'boom' });
		await app.close();
	});

	it('answers 401 and records it when no ChatGPT account is signed in', async () => {
		const record = vi.spyOn(Requests, 'record');
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const app = await withPlugin(responsesPlugin, { apiKey: 'secret' });
		const response = await app.inject({
			method: 'POST',
			url: '/v1/responses',
			headers: { authorization: 'Bearer secret' },
			payload: codexRequest
		});

		expect(response.statusCode).toBe(401);
		expect(response.json().error.type).toBe('authentication_error');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(record).toHaveBeenCalledWith(expect.objectContaining({ stopReason: 'error', stream: false }));
		await app.close();
	});

	it('refuses a request without a key', async () => {
		const app = await withPlugin(responsesPlugin, { apiKey: 'secret' });
		const response = await app.inject({ method: 'POST', url: '/v1/responses', payload: codexRequest });

		expect(response.statusCode).toBe(403);
		await app.close();
	});
});

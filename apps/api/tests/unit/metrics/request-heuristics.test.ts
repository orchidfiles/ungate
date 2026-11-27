import { describe, expect, it } from 'vitest';

import { RequestHeuristics } from 'src/metrics/request-heuristics';

import type { OpenAIChatRequest } from 'src/types/openai';

const FIRST = '<user_info>OS linux</user_info>\n<user_query>Refactor the auth module</user_query>';

function chat(messages: { role: string; content: unknown }[], extra: Partial<OpenAIChatRequest> = {}): OpenAIChatRequest {
	return { model: 'opus-4.8', messages, ...extra } as OpenAIChatRequest;
}

describe('RequestHeuristics.compute', () => {
	it('keeps the session key stable as the conversation grows and counts turns', () => {
		const first = RequestHeuristics.compute({
			body: chat([
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: FIRST }
			])
		});
		const later = RequestHeuristics.compute({
			body: chat([
				{ role: 'system', content: 'different system prompt' },
				{ role: 'user', content: [{ type: 'text', text: FIRST }] },
				{ role: 'assistant', content: 'working' },
				{ role: 'tool', content: 'result' },
				{ role: 'assistant', content: 'more' },
				{ role: 'user', content: 'thanks' }
			])
		});

		expect(first.sessionKey).toMatch(/^[0-9a-f]{24}$/);
		expect(later.sessionKey).toBe(first.sessionKey);
		expect(first.turnIndex).toBe(0);
		expect(later.turnIndex).toBe(2);
		expect(later.messageCount).toBe(6);
		expect(later.continuation).toBe(false);
	});

	it('separates chats that share Cursor preamble but differ in the prompt', () => {
		const a = RequestHeuristics.compute({ body: chat([{ role: 'user', content: FIRST }]) });
		const b = RequestHeuristics.compute({
			body: chat([{ role: 'user', content: FIRST.replace('auth module', 'billing page') }])
		});

		expect(a.sessionKey).not.toBe(b.sessionKey);
	});

	it('ignores whitespace differences in the first message', () => {
		const a = RequestHeuristics.sessionKey('hello   world\n');
		const b = RequestHeuristics.sessionKey(' hello world');

		expect(a).toBe(b);
	});

	it('returns a null session for requests without a user message', () => {
		const result = RequestHeuristics.compute({ body: chat([{ role: 'system', content: 'sys' }]) });

		expect(result.sessionKey).toBeNull();
		expect(result.turnIndex).toBe(0);
	});

	it('flags a short "continue" nudge after the first turn', () => {
		const result = RequestHeuristics.compute({
			body: chat([
				{ role: 'user', content: FIRST },
				{ role: 'assistant', content: 'partial' },
				{ role: 'user', content: '<user_query>continue</user_query>' }
			])
		});

		expect(result.continuation).toBe(true);
	});

	it('does not flag a nudge on the first turn', () => {
		const result = RequestHeuristics.compute({ body: chat([{ role: 'user', content: 'continue' }]) });

		expect(result.continuation).toBe(false);
	});

	it('flags continuation when the previous request in the session was interrupted', () => {
		const body = chat([
			{ role: 'user', content: FIRST },
			{ role: 'assistant', content: 'partial' },
			{ role: 'user', content: 'Now also update the tests' }
		]);
		const lookups: string[] = [];

		for (const previous of ['max_tokens', 'error', 'aborted']) {
			const result = RequestHeuristics.compute({
				body,
				previousStopReason: (key) => {
					lookups.push(key);

					return previous;
				}
			});
			expect(result.continuation).toBe(true);
		}

		expect(RequestHeuristics.compute({ body, previousStopReason: () => 'end_turn' }).continuation).toBe(false);
		expect(RequestHeuristics.compute({ body, previousStopReason: () => null }).continuation).toBe(false);
		expect(new Set(lookups).size).toBe(1);
	});

	it('takes the mapped reasoning tier over the client effort and drops "none"', () => {
		expect(RequestHeuristics.compute({ body: chat([], { reasoning_effort: 'low' }), reasoningTier: 'high' }).reasoningTier).toBe(
			'high'
		);
		expect(RequestHeuristics.compute({ body: chat([], { reasoning_effort: 'medium' }) }).reasoningTier).toBe('medium');
		expect(RequestHeuristics.compute({ body: chat([], { reasoning_effort: 'none' }) }).reasoningTier).toBeNull();
		expect(RequestHeuristics.compute({ body: chat([]) }).reasoningTier).toBeNull();
	});

	it('reads Responses-style input arrays', () => {
		const result = RequestHeuristics.compute({
			body: {
				model: 'gpt-6',
				input: [
					{ role: 'user', content: [{ type: 'input_text', text: FIRST }] },
					{ type: 'function_call', name: 'Shell' },
					{ role: 'assistant', content: 'ok' },
					{ role: 'user', content: 'keep going' }
				]
			} as unknown as OpenAIChatRequest
		});

		expect(result.sessionKey).toBe(RequestHeuristics.sessionKey(FIRST));
		expect(result.turnIndex).toBe(1);
		expect(result.continuation).toBe(true);
	});
});

describe('RequestHeuristics.isContinueNudge', () => {
	it.each(['continue', 'Please continue', '  keep going!', 'go on', 'Resume from where you stopped', 'proceed', 'carry on'])(
		'matches %j',
		(text) => {
			expect(RequestHeuristics.isContinueNudge(text)).toBe(true);
		}
	);

	it.each(['', 'continued fraction', 'Why did you continue?', `continue ${'x'.repeat(250)}`, 'Let us continue'])(
		'rejects %j',
		(text) => {
			expect(RequestHeuristics.isContinueNudge(text)).toBe(false);
		}
	);
});

describe('RequestHeuristics.normalizeStopReason', () => {
	it.each([
		['end_turn', 'end_turn'],
		['stop', 'end_turn'],
		['completed', 'end_turn'],
		['tool_use', 'tool_use'],
		['tool_calls', 'tool_use'],
		['max_tokens', 'max_tokens'],
		['length', 'max_tokens'],
		['max_output_tokens', 'max_tokens'],
		['stop_sequence', 'stop_sequence'],
		['refusal', 'error'],
		['failed', 'error'],
		['cancelled', 'aborted'],
		['something_new', 'unknown'],
		[null, 'unknown'],
		[undefined, 'unknown']
	])('%s → %s', (raw, expected) => {
		expect(RequestHeuristics.normalizeStopReason(raw)).toBe(expected);
	});
});

import type { IncomingHttpHeaders } from 'node:http';

/**
 * Who sent an Anthropic request, decided once at the route.
 *
 * - `translated`: Cursor traffic (converted from `/v1/chat/completions`) or any other non-Claude Code
 *   caller. Its body is rewritten into a Claude Code packet: identity system prompt, tool renaming,
 *   Ungate's Claude Code headers.
 * - `claude-code`: the Claude Code CLI itself. Its body and its own Claude Code headers are already
 *   the real packet, so they are forwarded unchanged; only the pool credential is swapped in.
 */
export type AnthropicCaller =
	| { kind: 'translated' }
	| {
			kind: 'claude-code';
			/** The CLI's own request headers, minus credentials and hop-by-hop headers. */
			headers: Record<string, string>;
			/** `x-claude-code-session-id`: one id per CLI session. */
			sessionId: string | null;
	  };

export const TRANSLATED_CALLER: AnthropicCaller = { kind: 'translated' };

/** Claude Code identifies itself as `claude-cli/<version> (external, <entrypoint>)`. */
const CLAUDE_CODE_USER_AGENT = /^claude-cli\/\d/;

/**
 * Headers forwarded for a Claude Code caller. Credentials (`authorization`, `x-api-key`) are the
 * caller's Ungate client key and never go upstream; transport headers are Node's to set.
 */
const FORWARDED = /^(anthropic-|x-stainless-|x-claude-code-|x-app$|user-agent$)/;

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value.join(', ') : value;
}

export function anthropicCaller(headers: IncomingHttpHeaders): AnthropicCaller {
	const userAgent = headerValue(headers['user-agent']) ?? '';
	if (!CLAUDE_CODE_USER_AGENT.test(userAgent)) return TRANSLATED_CALLER;

	const forwarded: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const text = headerValue(value);
		if (text !== undefined && FORWARDED.test(name.toLowerCase())) forwarded[name.toLowerCase()] = text;
	}

	return { kind: 'claude-code', headers: forwarded, sessionId: forwarded['x-claude-code-session-id'] ?? null };
}

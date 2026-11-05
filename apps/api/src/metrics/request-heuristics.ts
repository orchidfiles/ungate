import { createHash } from 'node:crypto';

import type { RequestTelemetry, StopReason } from '@ungate/shared';
import type { OpenAIChatRequest, OpenAIMessage } from 'src/types/openai';

/** Short user nudges that resume work the agent stopped on (truncation, error, cancel). */
const CONTINUE_PATTERN = /^\s*(?:please\s+)?(continue|keep going|go on|resume|proceed|carry on)\b/i;
const CONTINUE_MAX_LENGTH = 200;

/** Previous outcomes in a session after which the next request is resuming interrupted work. */
const INTERRUPTED_STOPS: ReadonlySet<string> = new Set<StopReason>(['max_tokens', 'error', 'aborted']);

interface ChatLikeMessage {
	role: string;
	content: unknown;
}

export interface RequestHeuristicsInput {
	body: OpenAIChatRequest;
	reasoningTier?: string | null;
	/** Stop reason of the latest earlier request in the same session (null when none). */
	previousStopReason?: (sessionKey: string) => string | null;
}

/**
 * Request-side usage heuristics. Cursor resends the whole conversation on every agent step, so the
 * first user message identifies an agent chat for its lifetime (until Cursor summarizes it). All
 * values are estimates and are labelled as such in the dashboard.
 */
export class RequestHeuristics {
	static compute(input: RequestHeuristicsInput): RequestTelemetry {
		const messages = this.messages(input.body);
		const firstUser = messages.find((message) => message.role === 'user');
		const firstUserText = firstUser ? this.text(firstUser.content) : '';
		const sessionKey = firstUserText ? this.sessionKey(firstUserText) : null;
		const turnIndex = messages.filter((message) => message.role === 'assistant').length;
		const last = messages.at(-1);
		const nudged = last?.role === 'user' && turnIndex > 0 && this.isContinueNudge(this.text(last.content));
		const previous = sessionKey && turnIndex > 0 ? (input.previousStopReason?.(sessionKey) ?? null) : null;
		const resumedAfterStop = previous !== null && INTERRUPTED_STOPS.has(previous);

		return {
			sessionKey,
			turnIndex,
			messageCount: messages.length,
			continuation: nudged || resumedAfterStop,
			reasoningTier: this.reasoningTier(input.body, input.reasoningTier)
		};
	}

	/**
	 * Hashes the whole first user message: Cursor prepends a long shared preamble (rules,
	 * `<user_info>`) to it, so a prefix alone would collide across unrelated chats. Model is left out
	 * so switching models mid-chat stays one session.
	 */
	static sessionKey(firstUserText: string): string {
		const normalized = firstUserText.replace(/\s+/g, ' ').trim();

		return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
	}

	static isContinueNudge(text: string): boolean {
		const trimmed = this.stripCursorWrappers(text).trim();

		return trimmed.length > 0 && trimmed.length < CONTINUE_MAX_LENGTH && CONTINUE_PATTERN.test(trimmed);
	}

	/** Configured tier from the model mapping, else the client's reasoning effort. */
	static reasoningTier(body: OpenAIChatRequest, mapped?: string | null): string | null {
		const tier = mapped ?? body.reasoning_effort ?? body.reasoning?.effort ?? null;

		return tier && tier !== 'none' ? tier : null;
	}

	/** Normalizes Anthropic `stop_reason`, Codex terminal status and OpenAI `finish_reason`. */
	static normalizeStopReason(raw: string | null | undefined): StopReason {
		switch (raw) {
			case 'end_turn':
			case 'stop':
			case 'completed':
			case 'pause_turn':
				return 'end_turn';
			case 'tool_use':
			case 'tool_calls':
			case 'function_call':
				return 'tool_use';
			case 'max_tokens':
			case 'length':
			case 'max_output_tokens':
			case 'model_context_window_exceeded':
			case 'incomplete':
				return 'max_tokens';
			case 'stop_sequence':
				return 'stop_sequence';
			case 'error':
			case 'failed':
			case 'refusal':
			case 'content_filter':
				return 'error';
			case 'aborted':
			case 'cancelled':
				return 'aborted';
			default:
				return 'unknown';
		}
	}

	private static messages(body: OpenAIChatRequest): ChatLikeMessage[] {
		if (Array.isArray(body.messages) && body.messages.length > 0) {
			return body.messages.map((message: OpenAIMessage) => ({ role: message.role, content: message.content }));
		}

		if (!Array.isArray(body.input)) return [];

		return (body.input as unknown[]).flatMap((item) => {
			if (!item || typeof item !== 'object') return [];
			const record = item as Record<string, unknown>;
			if (typeof record.role !== 'string') return [];

			return [{ role: record.role, content: record.content }];
		});
	}

	private static text(content: unknown): string {
		if (typeof content === 'string') return content;
		if (!Array.isArray(content)) return '';

		return content
			.map((part) => {
				if (!part || typeof part !== 'object') return '';
				const record = part as Record<string, unknown>;

				return typeof record.text === 'string' ? record.text : '';
			})
			.join('\n');
	}

	/** Cursor wraps the typed prompt in `<user_query>`; judge only what the user typed. */
	private static stripCursorWrappers(text: string): string {
		const match = /<user_query>([\s\S]*?)<\/user_query>/i.exec(text);

		return match?.[1] ?? text;
	}
}

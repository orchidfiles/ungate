import { logger } from 'src/utils/logger';

import type { StreamState } from './stream-state';
import type { RequestTelemetry, StopReason } from '@ungate/shared';

export class StreamDiagnostics {
	static bumpOutputItem(map: Map<string, number>, item: Record<string, unknown>): void {
		let t = '?';

		if (typeof item.type === 'string' && item.type.length > 0) {
			t = item.type;
		}

		map.set(t, (map.get(t) ?? 0) + 1);
	}

	static noteKind(state: StreamState, kind: string | undefined): void {
		let k = '(no-type)';

		if (kind != null) {
			k = kind;
		}

		state.sseKindCounts.set(k, (state.sseKindCounts.get(k) ?? 0) + 1);
	}

	/**
	 * Responses usage → OpenAI chat usage. Keeps `cached_tokens` (`input_tokens_details`) and
	 * `reasoning_tokens` (`output_tokens_details`) as flat `cached_tokens` / `reasoning_tokens`
	 * fields; downstream clients ignore unknown usage keys.
	 */
	static mapUsage(usage: Record<string, unknown> | undefined): Record<string, number> | undefined {
		if (!usage) {
			return undefined;
		}

		const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
		const details = (value: unknown): Record<string, unknown> | undefined =>
			value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

		const mappedUsage: Record<string, number> = {
			prompt_tokens: num(usage.input_tokens) ?? num(usage.prompt_tokens) ?? 0,
			completion_tokens: num(usage.output_tokens) ?? num(usage.completion_tokens) ?? 0,
			total_tokens: num(usage.total_tokens) ?? 0
		};
		const cached =
			num(details(usage.input_tokens_details)?.cached_tokens) ?? num(details(usage.prompt_tokens_details)?.cached_tokens);
		const reasoning =
			num(details(usage.output_tokens_details)?.reasoning_tokens) ??
			num(details(usage.completion_tokens_details)?.reasoning_tokens);

		if (cached !== undefined) mappedUsage.cached_tokens = cached;
		if (reasoning !== undefined) mappedUsage.reasoning_tokens = reasoning;

		return mappedUsage;
	}

	/** Analytics fields for a finished (or abandoned) Codex stream. */
	static telemetry(state: StreamState, override?: 'failed' | 'aborted'): RequestTelemetry {
		let stopReason: StopReason;

		if (override === 'aborted') stopReason = 'aborted';
		else if (override === 'failed' || state.terminal === 'failed' || !state.terminal) stopReason = 'error';
		else if (state.terminal === 'incomplete') stopReason = state.incompleteReason === 'content_filter' ? 'error' : 'max_tokens';
		else stopReason = state.toolCallsSeen ? 'tool_use' : 'end_turn';

		const usage = state.usage;

		return {
			stopReason,
			toolCallCount: state.toolNames.length,
			toolNames: state.toolNames,
			cacheReadTokens: usage?.cached_tokens ?? null,
			// Codex has no separate cache-write count; uncached input is billed as regular input.
			cacheCreationTokens: usage ? 0 : null,
			reasoningTokens: usage?.reasoning_tokens ?? null
		};
	}

	static logFinished(state: StreamState, how: 'stream' | 'buffer'): void {
		const entries = [...state.sseKindCounts.entries()].sort((a, b) => b[1] - a[1]);
		const top = entries
			.slice(0, 24)
			.map(([t, n]) => `${t}:${n}`)
			.join(' ');
		let summary = top;

		if (top.length > 900) {
			summary = `${top.slice(0, 900)}…`;
		}

		const addedTypes = [...state.outputItemTypeAdded.entries()].map(([t, n]) => `${t}:${n}`).join(',');
		const doneTypes = [...state.outputItemTypeDone.entries()].map(([t, n]) => `${t}:${n}`).join(',');
		let added = addedTypes;

		if (!added) {
			added = '-';
		}

		let done = doneTypes;

		if (!done) {
			done = '-';
		}

		let summaryOrPlaceholder = summary;

		if (!summaryOrPlaceholder) {
			summaryOrPlaceholder = 'NO_SSE_PARSED';
		}

		logger.log(
			`[Codex stream] ${how} done toolCallsSeen=${state.toolCallsSeen} toolCallIndex=${state.toolCallIndex} text=${state.sawTextDelta} kinds=${state.sseKindCounts.size} output_item.added[${added}] output_item.done[${done}] ${summaryOrPlaceholder}`
		);
	}
}

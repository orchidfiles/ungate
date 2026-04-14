import { logger } from 'src/utils/logger';

import type { StreamState } from './stream-state';

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

	static mapUsage(usage: Record<string, number> | undefined): Record<string, number> | undefined {
		if (!usage) {
			return undefined;
		}

		const mappedUsage: Record<string, number> = {
			prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
			completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
			total_tokens: usage.total_tokens ?? 0
		};

		return mappedUsage;
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

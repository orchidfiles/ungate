import type { StreamProcessResult, StreamState } from './stream-state';

const TOOL_ARGS_STREAM_CHUNK = 96;

export class StreamChunkMapper {
	static chunk(
		state: StreamState,
		delta: Record<string, unknown>,
		finishReason: string | null,
		usage?: Record<string, number>
	): Record<string, unknown> {
		const chunk: Record<string, unknown> = {
			id: state.id,
			object: 'chat.completion.chunk',
			created: state.created,
			model: state.model,
			choices: [{ index: 0, delta, finish_reason: finishReason }]
		};

		if (usage) {
			chunk.usage = usage;
		}

		return chunk;
	}

	static outputIndex(payload: Record<string, unknown>): number | undefined {
		for (const key of ['output_index', 'item_index'] as const) {
			const v = payload[key];

			if (typeof v === 'number' && Number.isFinite(v)) {
				return v;
			}

			if (typeof v === 'string' && /^\d+$/.test(v)) {
				return parseInt(v, 10);
			}
		}

		return undefined;
	}

	static toolName(item: Record<string, unknown>): string {
		if (typeof item.name === 'string' && item.name.trim().length > 0) {
			return item.name.trim();
		}

		const custom = item.custom;

		if (custom && typeof custom === 'object') {
			const nm = (custom as Record<string, unknown>).name;

			if (typeof nm === 'string' && nm.trim().length > 0) {
				return nm.trim();
			}
		}

		return '';
	}

	static toolArgs(item: Record<string, unknown>): string {
		if (item.arguments != null) {
			if (typeof item.arguments === 'string') {
				return item.arguments;
			}

			return JSON.stringify(item.arguments);
		}

		if (item.input != null) {
			if (typeof item.input === 'string') {
				return item.input;
			}

			return JSON.stringify(item.input);
		}

		return '';
	}

	static emitToolCalls(state: StreamState, item: Record<string, unknown>, results: StreamProcessResult[]): void {
		state.toolCallsSeen = true;
		const toolCallId =
			(typeof item.call_id === 'string' && item.call_id) ||
			(typeof item.id === 'string' && item.id) ||
			`call_${state.toolCallIndex}`;
		const argsStr = this.toolArgs(item);
		const index = state.toolCallIndex;
		state.toolCallIndex += 1;
		const rawName = this.toolName(item);
		let name = rawName;

		if (!name) {
			name = 'unknown';
		}

		const firstDelta: Record<string, unknown> = {
			tool_calls: [
				{
					index,
					id: toolCallId,
					type: 'function',
					function: { name, arguments: '' }
				}
			]
		};

		if (!state.roleSent) {
			firstDelta.role = 'assistant';
			state.roleSent = true;
		}

		results.push({ type: 'chunk', data: this.chunk(state, firstDelta, null) });

		for (let i = 0; i < argsStr.length; i += TOOL_ARGS_STREAM_CHUNK) {
			const frag = argsStr.slice(i, i + TOOL_ARGS_STREAM_CHUNK);

			results.push({
				type: 'chunk',
				data: this.chunk(state, { tool_calls: [{ index, function: { arguments: frag } }] }, null)
			});
		}
	}
}

import { logger } from 'src/utils/logger';

const TOOL_ARGS_STREAM_CHUNK = 96;

interface PendingFunctionCallState {
	callId: string;
	openAiIndex: number;
	argsBuffer: string;
	deferred: boolean;
}

interface StreamState {
	buffer: string;
	id: string;
	model: string;
	created: number;
	roleSent: boolean;
	sawTextDelta: boolean;
	toolCallsSeen: boolean;
	toolCallIndex: number;
	processedItemIds: Set<string>;
	pendingFunctionCalls: Map<number, PendingFunctionCallState>;
	sseKindCounts: Map<string, number>;
	outputItemTypeAdded: Map<string, number>;
	outputItemTypeDone: Map<string, number>;
}

export interface StreamProcessResult {
	type: 'chunk' | 'done';
	data?: Record<string, unknown>;
}

function readNumericOutputIndex(payload: Record<string, unknown>): number | undefined {
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

function extractCodexStreamToolItemName(item: Record<string, unknown>): string {
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

function toolArgumentsStringFromItem(item: Record<string, unknown>): string {
	if (item.arguments != null) {
		return typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
	}

	if (item.input != null) {
		return typeof item.input === 'string' ? item.input : JSON.stringify(item.input);
	}

	return '';
}

function createChunk(
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

function coalesceResponsesTextDelta(payload: Record<string, unknown>): string | null {
	const d = payload.delta;

	if (typeof d === 'string' && d.length > 0) {
		return d;
	}

	if (d && typeof d === 'object') {
		const text = (d as Record<string, unknown>).text;

		if (typeof text === 'string' && text.length > 0) {
			return text;
		}
	}

	return null;
}

function extractAssistantTextFromResponseOutput(resp: Record<string, unknown> | undefined): string | null {
	if (!resp) {
		return null;
	}

	const output = resp.output;

	if (!Array.isArray(output)) {
		return null;
	}

	const parts: string[] = [];

	for (const item of output) {
		if (!item || typeof item !== 'object') {
			continue;
		}

		const rec = item as Record<string, unknown>;

		if (rec.type !== 'message' || rec.role !== 'assistant') {
			continue;
		}

		const content = rec.content;

		if (!Array.isArray(content)) {
			continue;
		}

		for (const block of content) {
			if (!block || typeof block !== 'object') {
				continue;
			}

			const b = block as Record<string, unknown>;

			if (b.type === 'output_text' && typeof b.text === 'string') {
				parts.push(b.text);
			}
		}
	}

	const joined = parts.join('');

	if (joined.length === 0) {
		return null;
	}

	return joined;
}

function emitOpenAIToolCallStreamChunks(state: StreamState, item: Record<string, unknown>, results: StreamProcessResult[]): void {
	state.toolCallsSeen = true;
	const toolCallId =
		(typeof item.call_id === 'string' && item.call_id) ||
		(typeof item.id === 'string' && item.id) ||
		`call_${state.toolCallIndex}`;
	const argsStr = toolArgumentsStringFromItem(item);
	const index = state.toolCallIndex;
	state.toolCallIndex += 1;
	const name = extractCodexStreamToolItemName(item) || 'unknown';

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

	results.push({ type: 'chunk', data: createChunk(state, firstDelta, null) });

	const argChunks = argsStr.length > 0 ? Math.ceil(argsStr.length / TOOL_ARGS_STREAM_CHUNK) : 0;
	void argChunks;

	for (let i = 0; i < argsStr.length; i += TOOL_ARGS_STREAM_CHUNK) {
		const frag = argsStr.slice(i, i + TOOL_ARGS_STREAM_CHUNK);

		results.push({
			type: 'chunk',
			data: createChunk(state, { tool_calls: [{ index, function: { arguments: frag } }] }, null)
		});
	}
}

function bumpOutputItemType(map: Map<string, number>, item: Record<string, unknown>): void {
	const t = typeof item.type === 'string' && item.type.length > 0 ? item.type : '?';
	map.set(t, (map.get(t) ?? 0) + 1);
}

function noteCodexSseKind(state: StreamState, kind: string | undefined): void {
	const k = kind ?? '(no-type)';
	state.sseKindCounts.set(k, (state.sseKindCounts.get(k) ?? 0) + 1);
}

export function createResponsesStreamState(model: string): StreamState {
	return {
		buffer: '',
		id: `chatcmpl-${Date.now().toString(36)}`,
		model,
		created: Math.floor(Date.now() / 1000),
		roleSent: false,
		sawTextDelta: false,
		toolCallsSeen: false,
		toolCallIndex: 0,
		processedItemIds: new Set(),
		pendingFunctionCalls: new Map(),
		sseKindCounts: new Map(),
		outputItemTypeAdded: new Map(),
		outputItemTypeDone: new Map()
	};
}

export function processResponsesChunk(state: StreamState, chunk: string): StreamProcessResult[] {
	state.buffer += chunk;
	const results: StreamProcessResult[] = [];
	const parts = state.buffer.split('\n\n');
	state.buffer = parts.pop() ?? '';

	for (const part of parts) {
		const lines = part.split('\n');

		for (const line of lines) {
			if (!line.startsWith('data:')) {
				continue;
			}

			const data = line.slice(5).trim();

			if (!data || data === '[DONE]') {
				continue;
			}

			let payload: Record<string, unknown>;

			try {
				payload = JSON.parse(data);
			} catch {
				continue;
			}

			const kind = payload?.type as string | undefined;
			noteCodexSseKind(state, kind);

			if (kind === 'response.created' && (payload.response as Record<string, unknown>)?.id) {
				state.id = `chatcmpl-${String((payload.response as Record<string, unknown>).id).replace(/^resp_/, '')}`;
				continue;
			}

			if (kind === 'response.output_item.added' && payload.item && typeof payload.item === 'object') {
				const addedItem = payload.item as Record<string, unknown>;
				bumpOutputItemType(state.outputItemTypeAdded, addedItem);

				if (addedItem.type === 'function_call' || addedItem.type === 'custom_tool_call') {
					const outputIndex = readNumericOutputIndex(payload) ?? state.toolCallIndex;
					const nameRaw = extractCodexStreamToolItemName(addedItem);
					const callId =
						(typeof addedItem.call_id === 'string' && addedItem.call_id) ||
						(typeof addedItem.id === 'string' && addedItem.id) ||
						`call_${Date.now()}_${outputIndex}`;

					state.pendingFunctionCalls.set(outputIndex, {
						callId,
						openAiIndex: outputIndex,
						argsBuffer: '',
						deferred: !nameRaw
					});
					state.toolCallsSeen = true;

					if (nameRaw) {
						const delta: Record<string, unknown> = {
							tool_calls: [
								{
									index: outputIndex,
									id: callId,
									type: 'function',
									function: { name: nameRaw, arguments: '' }
								}
							]
						};

						if (!state.roleSent) {
							delta.role = 'assistant';
							state.roleSent = true;
						}

						results.push({ type: 'chunk', data: createChunk(state, delta, null) });
					}
				}

				continue;
			}

			if (kind === 'response.function_call_arguments.delta' || kind === 'response.custom_tool_call_input.delta') {
				const outIdx = readNumericOutputIndex(payload);

				if (outIdx === undefined) {
					logger.warn(`[Codex tool] ${kind} missing output_index/item_index keys=`, Object.keys(payload).join(','));
					continue;
				}

				const rawArgDelta = payload.delta;
				let deltaStr = '';

				if (typeof rawArgDelta === 'string') {
					deltaStr = rawArgDelta;
				} else if (typeof rawArgDelta === 'number' || typeof rawArgDelta === 'boolean') {
					deltaStr = String(rawArgDelta);
				} else if (rawArgDelta != null && typeof rawArgDelta === 'object') {
					const o = rawArgDelta as Record<string, unknown>;
					const nested = o.text ?? o.input ?? o.delta;

					if (typeof nested === 'string') {
						deltaStr = nested;
					}
				}

				if (!deltaStr) {
					continue;
				}

				const pending = state.pendingFunctionCalls.get(outIdx);

				if (!pending) {
					logger.warn(`[Codex tool] arguments.delta outIdx=${outIdx} but no matching output_item.added (index mismatch?)`);
					continue;
				}

				pending.argsBuffer += deltaStr;

				if (pending.deferred) {
					continue;
				}

				const argDelta: Record<string, unknown> = {
					tool_calls: [{ index: pending.openAiIndex, function: { arguments: deltaStr } }]
				};

				if (!state.roleSent) {
					argDelta.role = 'assistant';
					state.roleSent = true;
				}

				results.push({ type: 'chunk', data: createChunk(state, argDelta, null) });

				continue;
			}

			if (kind === 'response.output_text.delta') {
				const text = coalesceResponsesTextDelta(payload);

				if (text) {
					const delta: Record<string, unknown> = { content: text };

					if (!state.roleSent) {
						delta.role = 'assistant';
						state.roleSent = true;
					}

					state.sawTextDelta = true;
					results.push({ type: 'chunk', data: createChunk(state, delta, null) });
				}

				continue;
			}

			if (kind === 'response.output_text.done' && typeof payload.text === 'string' && payload.text.length > 0) {
				if (!state.sawTextDelta) {
					const delta: Record<string, unknown> = { content: payload.text };

					if (!state.roleSent) {
						delta.role = 'assistant';
						state.roleSent = true;
					}

					state.sawTextDelta = true;
					results.push({ type: 'chunk', data: createChunk(state, delta, null) });
				}

				continue;
			}

			if (kind === 'response.output_item.done' && payload.item && typeof payload.item === 'object') {
				const item = payload.item as Record<string, unknown>;
				bumpOutputItemType(state.outputItemTypeDone, item);
				const itemId =
					(typeof item.id === 'string' && item.id) ||
					(typeof item.call_id === 'string' && item.call_id) ||
					`${String(item.type)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

				if (state.processedItemIds.has(itemId)) {
					continue;
				}

				state.processedItemIds.add(itemId);

				if (item.type === 'message' && item.role === 'assistant' && !state.sawTextDelta) {
					const blocks = Array.isArray(item.content) ? item.content : [];
					const textParts: string[] = [];

					for (const b of blocks) {
						if (!b || typeof b !== 'object') {
							continue;
						}

						const block = b as Record<string, unknown>;

						if (block.type === 'output_text' && typeof block.text === 'string') {
							textParts.push(block.text);
						}
					}

					const text = textParts.join('');

					if (text) {
						const delta: Record<string, unknown> = { content: text };

						if (!state.roleSent) {
							delta.role = 'assistant';
							state.roleSent = true;
						}

						state.sawTextDelta = true;
						results.push({ type: 'chunk', data: createChunk(state, delta, null) });
					}
				} else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
					const outputIndex = readNumericOutputIndex(payload) ?? state.toolCallIndex;
					const pending = state.pendingFunctionCalls.get(outputIndex);
					const callId =
						(typeof item.call_id === 'string' && item.call_id.length > 0 && item.call_id) ||
						(typeof item.id === 'string' && item.id.length > 0 && item.id) ||
						(pending?.callId ?? `call_${state.toolCallIndex}`);
					const doneName = extractCodexStreamToolItemName(item);
					const argsStr = toolArgumentsStringFromItem(item);

					if (pending) {
						state.pendingFunctionCalls.delete(outputIndex);
						state.toolCallsSeen = true;
						const openIdx = pending.openAiIndex;
						const buffered = pending.argsBuffer;

						if (pending.deferred) {
							const fnName = doneName || 'unknown';
							const combinedArgs = argsStr || buffered;
							const fcDelta: Record<string, unknown> = {
								tool_calls: [
									{
										index: openIdx,
										id: callId,
										type: 'function',
										function: { name: fnName, arguments: combinedArgs }
									}
								]
							};

							if (!state.roleSent) {
								fcDelta.role = 'assistant';
								state.roleSent = true;
							}

							results.push({ type: 'chunk', data: createChunk(state, fcDelta, null) });
							state.toolCallIndex = Math.max(state.toolCallIndex, openIdx + 1);
						} else {
							state.toolCallIndex = Math.max(state.toolCallIndex, openIdx + 1);

							if (argsStr.length > 0 && buffered.length === 0) {
								results.push({
									type: 'chunk',
									data: createChunk(
										state,
										{
											tool_calls: [{ index: openIdx, function: { arguments: argsStr } }]
										},
										null
									)
								});
							}
						}
					} else {
						emitOpenAIToolCallStreamChunks(state, item, results);
					}
				}

				continue;
			}

			if (kind === 'response.completed') {
				const resp = payload.response as Record<string, unknown> | undefined;

				if (!state.sawTextDelta && !state.toolCallsSeen) {
					const fallbackText = extractAssistantTextFromResponseOutput(resp);

					if (fallbackText) {
						const delta: Record<string, unknown> = { content: fallbackText };

						if (!state.roleSent) {
							delta.role = 'assistant';
							state.roleSent = true;
						}

						state.sawTextDelta = true;
						results.push({ type: 'chunk', data: createChunk(state, delta, null) });
					}
				}

				const usage = resp?.usage as Record<string, number> | undefined;
				const finish = state.toolCallsSeen ? 'tool_calls' : 'stop';
				const mappedUsage = usage
					? {
							prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
							completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
							total_tokens: usage.total_tokens ?? 0
						}
					: undefined;

				results.push({ type: 'chunk', data: createChunk(state, {}, finish, mappedUsage) });
				results.push({ type: 'done' });
			}
		}
	}

	return results;
}

export function logResponsesStreamFinished(state: StreamState, how: 'stream' | 'buffer'): void {
	const entries = [...state.sseKindCounts.entries()].sort((a, b) => b[1] - a[1]);
	const top = entries
		.slice(0, 24)
		.map(([t, n]) => `${t}:${n}`)
		.join(' ');
	const summary = top.length > 900 ? `${top.slice(0, 900)}…` : top;
	const addedTypes = [...state.outputItemTypeAdded.entries()].map(([t, n]) => `${t}:${n}`).join(',');
	const doneTypes = [...state.outputItemTypeDone.entries()].map(([t, n]) => `${t}:${n}`).join(',');

	logger.log(
		`[Codex stream] ${how} done toolCallsSeen=${state.toolCallsSeen} toolCallIndex=${state.toolCallIndex} text=${state.sawTextDelta} kinds=${state.sseKindCounts.size} output_item.added[${addedTypes || '-'}] output_item.done[${doneTypes || '-'}] ${summary || 'NO_SSE_PARSED'}`
	);
}

import { logger } from 'src/utils/logger';

import { AssistantTextExtractor } from './stream-assistant-text';
import { StreamDiagnostics } from './stream-diagnostics';
import { StreamChunkMapper } from './stream-openai-chunks';

import type { StreamProcessResult, StreamState } from './stream-state';

export class ResponsesEventRouter {
	static route(state: StreamState, payload: Record<string, unknown>, results: StreamProcessResult[]): void {
		const kind = payload?.type as string | undefined;
		StreamDiagnostics.noteKind(state, kind);

		// A terminal event ends the logical response: anything after it is ignored.
		if (state.terminal) {
			return;
		}

		if (this.handleFailureEvent(state, payload, kind, results)) {
			return;
		}

		if (this.handleCreatedEvent(state, payload, kind)) {
			return;
		}

		if (this.handleOutputItemAddedEvent(state, payload, kind, results)) {
			return;
		}

		if (this.handleArgumentsDeltaEvent(state, payload, kind, results)) {
			return;
		}

		if (this.handleOutputTextDeltaEvent(state, payload, kind, results)) {
			return;
		}

		if (this.handleOutputTextDoneEvent(state, payload, kind, results)) {
			return;
		}

		if (this.handleOutputItemDoneEvent(state, payload, kind, results)) {
			return;
		}

		this.handleCompletedEvent(state, payload, kind, results);
	}

	/**
	 * Upstream failures must never look like a successful completion:
	 * - `response.failed` (`response.error: { code, message, resets_at?, ... }`) and the bare `error`
	 *   event (`{ code, message }` or `{ error: { type, code, message, resets_at, resets_in_seconds } }`)
	 *   emit an `error` result and no `[DONE]`;
	 * - `response.incomplete` finishes with `length` (`max_output_tokens`) / `content_filter`, never
	 *   a plain `stop`.
	 * Matches openai/codex `codex-rs/codex-api/src/sse/responses.rs`, which turns these into errors.
	 */
	private static handleFailureEvent(
		state: StreamState,
		payload: Record<string, unknown>,
		kind: string | undefined,
		results: StreamProcessResult[]
	): boolean {
		if (kind === 'response.incomplete') {
			const resp = this.record(payload.response);
			const reason = this.record(resp?.incomplete_details)?.reason;
			const finish = reason === 'content_filter' ? 'content_filter' : 'length';
			state.terminal = 'incomplete';
			state.usage = StreamDiagnostics.mapUsage(resp?.usage as Record<string, number> | undefined);
			logger.warn(`[Codex] response.incomplete reason=${typeof reason === 'string' ? reason : 'unknown'}`);
			results.push({ type: 'chunk', data: StreamChunkMapper.chunk(state, {}, finish, state.usage) });
			results.push({ type: 'done' });

			return true;
		}

		if (kind !== 'response.failed' && kind !== 'error') {
			return false;
		}

		const upstream =
			kind === 'response.failed'
				? this.record(this.record(payload.response)?.error)
				: (this.record(payload.error) ?? this.withoutType(payload));
		const code = this.firstString(upstream?.code, upstream?.type);
		const type = this.firstString(upstream?.type, upstream?.code) ?? 'api_error';
		const message = this.firstString(upstream?.message) ?? `ChatGPT stream failed (${kind})`;

		state.terminal = 'failed';
		state.failure = code ? { message, type, code, upstream } : { message, type, upstream };
		logger.warn(`[Codex] ${kind} type=${type}${code ? ` code=${code}` : ''}`);
		results.push({
			type: 'error',
			data: { error: code ? { message, type, code } : { message, type } },
			upstreamError: upstream
		});

		return true;
	}

	private static record(value: unknown): Record<string, unknown> | undefined {
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	}

	private static withoutType(payload: Record<string, unknown>): Record<string, unknown> {
		const rest: Record<string, unknown> = { ...payload };
		delete rest.type;

		return rest;
	}

	private static firstString(...values: unknown[]): string | undefined {
		return values.find((value): value is string => typeof value === 'string' && value.length > 0);
	}

	private static handleCreatedEvent(state: StreamState, payload: Record<string, unknown>, kind: string | undefined): boolean {
		if (kind !== 'response.created') {
			return false;
		}

		const response = payload.response as Record<string, unknown> | undefined;

		if (typeof response?.id !== 'string' || response.id.length === 0) {
			return true;
		}

		state.id = `chatcmpl-${response.id.replace(/^resp_/, '')}`;

		return true;
	}

	private static handleOutputItemAddedEvent(
		state: StreamState,
		payload: Record<string, unknown>,
		kind: string | undefined,
		results: StreamProcessResult[]
	): boolean {
		if (kind !== 'response.output_item.added') {
			return false;
		}

		if (!payload.item || typeof payload.item !== 'object') {
			return true;
		}

		const addedItem = payload.item as Record<string, unknown>;
		StreamDiagnostics.bumpOutputItem(state.outputItemTypeAdded, addedItem);

		if (addedItem.type === 'function_call' || addedItem.type === 'custom_tool_call') {
			const outputIndex = StreamChunkMapper.outputIndex(payload) ?? state.toolCallIndex;
			const nameRaw = StreamChunkMapper.toolName(addedItem);
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

				this.pushAssistantChunk(state, results, delta);
			}
		}

		return true;
	}

	private static handleArgumentsDeltaEvent(
		state: StreamState,
		payload: Record<string, unknown>,
		kind: string | undefined,
		results: StreamProcessResult[]
	): boolean {
		if (kind !== 'response.function_call_arguments.delta' && kind !== 'response.custom_tool_call_input.delta') {
			return false;
		}

		const outIdx = StreamChunkMapper.outputIndex(payload);

		if (outIdx === undefined) {
			logger.warn(`[Codex tool] ${kind} missing output_index/item_index keys=`, Object.keys(payload).join(','));

			return true;
		}

		const deltaStr = this.readArgumentsDelta(payload.delta);

		if (!deltaStr) {
			return true;
		}

		const pending = state.pendingFunctionCalls.get(outIdx);

		if (!pending) {
			logger.warn(`[Codex tool] arguments.delta outIdx=${outIdx} but no matching output_item.added (index mismatch?)`);

			return true;
		}

		pending.argsBuffer += deltaStr;

		if (pending.deferred) {
			return true;
		}

		const argDelta: Record<string, unknown> = {
			tool_calls: [{ index: pending.openAiIndex, function: { arguments: deltaStr } }]
		};

		this.pushAssistantChunk(state, results, argDelta);

		return true;
	}

	private static handleOutputTextDeltaEvent(
		state: StreamState,
		payload: Record<string, unknown>,
		kind: string | undefined,
		results: StreamProcessResult[]
	): boolean {
		if (kind !== 'response.output_text.delta') {
			return false;
		}

		const text = AssistantTextExtractor.fromDelta(payload);

		if (text) {
			state.sawTextDelta = true;
			this.pushAssistantChunk(state, results, { content: text });
		}

		return true;
	}

	private static handleOutputTextDoneEvent(
		state: StreamState,
		payload: Record<string, unknown>,
		kind: string | undefined,
		results: StreamProcessResult[]
	): boolean {
		if (kind !== 'response.output_text.done') {
			return false;
		}

		if (typeof payload.text === 'string' && payload.text.length > 0 && !state.sawTextDelta) {
			state.sawTextDelta = true;
			this.pushAssistantChunk(state, results, { content: payload.text });
		}

		return true;
	}

	private static handleOutputItemDoneEvent(
		state: StreamState,
		payload: Record<string, unknown>,
		kind: string | undefined,
		results: StreamProcessResult[]
	): boolean {
		if (kind !== 'response.output_item.done') {
			return false;
		}

		if (!payload.item || typeof payload.item !== 'object') {
			return true;
		}

		const item = payload.item as Record<string, unknown>;
		StreamDiagnostics.bumpOutputItem(state.outputItemTypeDone, item);

		const itemId =
			(typeof item.id === 'string' && item.id) ||
			(typeof item.call_id === 'string' && item.call_id) ||
			`${String(item.type)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		if (state.processedItemIds.has(itemId)) {
			return true;
		}

		state.processedItemIds.add(itemId);

		if (item.type === 'message' && item.role === 'assistant' && !state.sawTextDelta) {
			const text = AssistantTextExtractor.fromOutputItem(item);

			if (text) {
				state.sawTextDelta = true;
				this.pushAssistantChunk(state, results, { content: text });
			}

			return true;
		}

		if (item.type === 'function_call' || item.type === 'custom_tool_call') {
			this.handleDoneToolCall(state, payload, item, results);
		}

		return true;
	}

	private static handleDoneToolCall(
		state: StreamState,
		payload: Record<string, unknown>,
		item: Record<string, unknown>,
		results: StreamProcessResult[]
	): void {
		const outputIndex = StreamChunkMapper.outputIndex(payload) ?? state.toolCallIndex;
		const pending = state.pendingFunctionCalls.get(outputIndex);
		const callId =
			(typeof item.call_id === 'string' && item.call_id.length > 0 && item.call_id) ||
			(typeof item.id === 'string' && item.id.length > 0 && item.id) ||
			(pending?.callId ?? `call_${state.toolCallIndex}`);
		const doneName = StreamChunkMapper.toolName(item);
		const argsStr = StreamChunkMapper.toolArgs(item);

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

				this.pushAssistantChunk(state, results, fcDelta);
				state.toolCallIndex = Math.max(state.toolCallIndex, openIdx + 1);
			} else {
				state.toolCallIndex = Math.max(state.toolCallIndex, openIdx + 1);

				if (argsStr.length > 0 && buffered.length === 0) {
					const delta: Record<string, unknown> = {
						tool_calls: [{ index: openIdx, function: { arguments: argsStr } }]
					};
					results.push({ type: 'chunk', data: StreamChunkMapper.chunk(state, delta, null) });
				}
			}

			return;
		}

		StreamChunkMapper.emitToolCalls(state, item, results);
	}

	private static handleCompletedEvent(
		state: StreamState,
		payload: Record<string, unknown>,
		kind: string | undefined,
		results: StreamProcessResult[]
	): void {
		if (kind !== 'response.completed') {
			return;
		}

		const resp = payload.response as Record<string, unknown> | undefined;

		if (!state.sawTextDelta && !state.toolCallsSeen) {
			const fallbackText = AssistantTextExtractor.fromResponseOutput(resp);

			if (fallbackText) {
				state.sawTextDelta = true;
				this.pushAssistantChunk(state, results, { content: fallbackText });
			}
		}

		const usage = resp?.usage as Record<string, number> | undefined;
		let finish: 'tool_calls' | 'stop' = 'stop';

		if (state.toolCallsSeen) {
			finish = 'tool_calls';
		}

		const mappedUsage = StreamDiagnostics.mapUsage(usage);
		state.terminal = 'completed';
		state.usage = mappedUsage;

		results.push({ type: 'chunk', data: StreamChunkMapper.chunk(state, {}, finish, mappedUsage) });
		results.push({ type: 'done' });
	}

	private static readArgumentsDelta(rawArgDelta: unknown): string {
		if (typeof rawArgDelta === 'string') {
			return rawArgDelta;
		}

		if (typeof rawArgDelta === 'number' || typeof rawArgDelta === 'boolean') {
			return String(rawArgDelta);
		}

		if (rawArgDelta != null && typeof rawArgDelta === 'object') {
			const o = rawArgDelta as Record<string, unknown>;
			const nested = o.text ?? o.input ?? o.delta;

			if (typeof nested === 'string') {
				return nested;
			}
		}

		return '';
	}

	private static pushAssistantChunk(state: StreamState, results: StreamProcessResult[], delta: Record<string, unknown>): void {
		if (!state.roleSent) {
			delta.role = 'assistant';
			state.roleSent = true;
		}

		results.push({ type: 'chunk', data: StreamChunkMapper.chunk(state, delta, null) });
	}
}

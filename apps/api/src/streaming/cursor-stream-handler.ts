import {
	checkToolCallArguments,
	findInvalidToolCalls,
	type InvalidToolCall,
	type ToolCallCheckInput
} from 'src/adapter/cursor-tool-capability';
import { Requests } from 'src/database/requests';
import { RequestHeuristics } from 'src/metrics/request-heuristics';
import { logger } from 'src/utils/logger';

import type { CursorBridgeError, CursorBridgeEventBody, CursorUsage, RequestTelemetry, StopReason } from '@ungate/shared';
import type { OpenAIChatResponse, OpenAITool, OpenAIToolCall } from 'src/types/openai';
import type { StreamResult } from 'src/types/proxy';

export type CursorFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface ToolSlot {
	index: number;
	id: string;
	name: string;
	args: string;
	announced: boolean;
	complete: boolean;
}

function addUsage(prior: CursorUsage | null, next: CursorUsage): CursorUsage {
	if (!prior) return next;

	return {
		inputTokens: prior.inputTokens + next.inputTokens,
		outputTokens: prior.outputTokens + next.outputTokens,
		cacheReadTokens: prior.cacheReadTokens + next.cacheReadTokens,
		cacheWriteTokens: prior.cacheWriteTokens + next.cacheWriteTokens,
		reasoningTokens:
			prior.reasoningTokens === null && next.reasoningTokens === null
				? null
				: (prior.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0)
	};
}

/** An OpenAI `delta` produced from one bridge event. */
export type CursorDelta =
	| { content: string }
	| { reasoning_content: string }
	| { tool_calls: { index: number; id?: string; type?: 'function'; function: { name?: string; arguments?: string } }[] };

/**
 * Folds bridge events into OpenAI deltas and the final result. Grok sends each tool call as one
 * complete part; Composer streams argument chunks and then a complete part. Both are reduced
 * to OpenAI `tool_calls[index]` deltas, never re-sending argument bytes already emitted.
 */
export class CursorResponseAccumulator {
	text = '';
	reasoningChars = 0;
	usage: CursorUsage | null = null;
	error: CursorBridgeError | null = null;
	ended = false;
	firstTokenAt: number | null = null;
	/** Set once a tool-argument repair round was started for this response. */
	repaired = false;
	private slots: ToolSlot[] = [];
	private byKey = new Map<string, ToolSlot>();
	/** Usage of finished rounds; the current round's usage is added on top. */
	private priorUsage: CursorUsage | null = null;
	private repairText = '';

	/**
	 * `holdToolCalls` (embedded tool mode): tool calls are not streamed as they arrive but kept
	 * until `releaseToolCalls`, so invalid arguments can be repaired before the client sees them.
	 */
	constructor(
		private readonly modelId: string,
		private readonly tools: OpenAITool[] | undefined,
		readonly holdToolCalls = false
	) {}

	/** Tool calls of the current round in argument-check form. */
	get pendingToolCalls(): ToolCallCheckInput[] {
		return this.slots.map((slot) => ({ id: slot.id, name: slot.name, args: slot.args }));
	}

	invalidToolCalls(): InvalidToolCall[] {
		return findInvalidToolCalls(this.tools, this.pendingToolCalls);
	}

	/** Characters of model output so far (bounds non-streaming collection). */
	get outputChars(): number {
		return this.text.length + this.reasoningChars + this.slots.reduce((sum, slot) => sum + slot.args.length, 0);
	}

	/**
	 * Starts a repair round: the held tool calls are dropped (returned so they can be restored if
	 * the repair fails), usage so far is kept, and the accumulator accepts a second invocation.
	 */
	beginRepairRound(): ToolSlot[] {
		const held = this.slots;
		this.repaired = true;
		this.priorUsage = this.usage;
		this.slots = [];
		this.byKey = new Map();
		this.ended = false;
		this.error = null;

		return held;
	}

	/**
	 * Ends a repair round. Repaired tool calls replace the held ones. If the repair failed or
	 * produced nothing, the original calls are restored (the client sees what it would have seen
	 * without repair). Repair-round text is emitted only when the model answered in plain text.
	 */
	settleRepairRound(held: ToolSlot[]): CursorDelta[] {
		const deltas: CursorDelta[] = [];
		const hasCalls = this.slots.length > 0;

		if (this.error?.kind === 'billing_blocked') {
			this.slots = [];
			this.byKey.clear();
			this.repairText = '';

			return deltas;
		}

		if (this.error || (!hasCalls && !this.repairText)) {
			if (this.error && this.error.kind !== 'cancelled') {
				logger.warn(`[cursor] ${this.modelId} tool argument repair failed (${this.error.kind}); sending the original calls`);
				this.error = null;
			}
			this.slots = held;
			this.byKey = new Map(held.map((slot) => [slot.id, slot]));
		} else if (!hasCalls) {
			this.text += this.repairText;
			deltas.push({ content: this.repairText });
		}
		this.repairText = '';

		return deltas;
	}

	/** Emits every held tool call as one complete delta each. */
	releaseToolCalls(): CursorDelta[] {
		const deltas: CursorDelta[] = [];

		for (const slot of this.slots) {
			if (slot.announced) continue;
			slot.announced = true;
			deltas.push({
				tool_calls: [
					{
						index: slot.index,
						id: slot.id,
						type: 'function',
						function: { name: slot.name || 'unknown', arguments: slot.args || '{}' }
					}
				]
			});
		}

		return deltas;
	}

	get toolCalls(): OpenAIToolCall[] {
		return this.slots.map((slot) => ({
			id: slot.id,
			type: 'function',
			function: { name: slot.name, arguments: slot.args || '{}' }
		}));
	}

	get toolNames(): string[] {
		return this.slots.map((slot) => slot.name);
	}

	finishReason(): CursorFinishReason {
		if (this.error?.kind === 'content_filter') return 'content_filter';
		if (this.slots.length > 0) return 'tool_calls';
		if (this.error?.code === 'INFERENCE_STREAM_ERROR_TYPE_OUTPUT_TOKEN_LIMIT') return 'length';

		return 'stop';
	}

	stopReason(aborted: boolean): StopReason {
		if (aborted) return 'aborted';
		if (this.error && this.finishReason() !== 'length') return 'error';

		return RequestHeuristics.normalizeStopReason(this.finishReason());
	}

	apply(event: CursorBridgeEventBody): CursorDelta[] {
		switch (event.kind) {
			case 'text':
				this.firstTokenAt ??= Date.now();
				if (this.repaired) {
					// Usually a restatement of the first round; only kept if the repair ends in plain text.
					this.repairText += event.text;

					return [];
				}
				this.text += event.text;

				return [{ content: event.text }];
			case 'thinking':
				this.firstTokenAt ??= Date.now();
				this.reasoningChars += event.text.length;

				return [{ reasoning_content: event.text }];
			case 'toolCall':
				this.firstTokenAt ??= Date.now();

				return this.applyToolCall(event);
			case 'usage':
				this.usage = addUsage(this.priorUsage, event.usage);

				return [];
			case 'end':
				this.ended = true;
				this.error = event.error;

				return this.holdToolCalls ? [] : this.flushIncompleteTools();
			default:
				return [];
		}
	}

	private slotFor(event: Extract<CursorBridgeEventBody, { kind: 'toolCall' }>): ToolSlot {
		const key = event.toolCallId || (event.toolIndex !== null ? `#${event.toolIndex}` : `#${this.slots.length}`);
		let slot = this.byKey.get(key);

		if (!slot) {
			slot = {
				index: this.slots.length,
				id: event.toolCallId || `call_${Math.random().toString(36).slice(2, 14)}`,
				name: event.toolName,
				args: '',
				announced: false,
				complete: false
			};
			this.slots.push(slot);
			this.byKey.set(key, slot);
		}

		if (!slot.name && event.toolName) slot.name = event.toolName;

		return slot;
	}

	private applyToolCall(event: Extract<CursorBridgeEventBody, { kind: 'toolCall' }>): CursorDelta[] {
		const slot = this.slotFor(event);
		if (slot.complete) return [];

		let appended = '';
		if (event.args) {
			if (event.args.startsWith(slot.args)) {
				// Cumulative (or final) arguments: only the new suffix is a delta.
				appended = event.args.slice(slot.args.length);
				slot.args = event.args;
			} else if (event.isComplete && slot.args) {
				logger.warn(`[cursor] ${this.modelId} final arguments for ${slot.name} diverged from streamed deltas`);
			} else {
				appended = event.args;
				slot.args += event.args;
			}
		}

		if (this.holdToolCalls) {
			if (event.isComplete) slot.complete = true;

			return [];
		}

		const deltas: CursorDelta[] = [];
		if (!slot.announced && slot.name) {
			slot.announced = true;
			deltas.push({
				tool_calls: [{ index: slot.index, id: slot.id, type: 'function', function: { name: slot.name, arguments: appended } }]
			});
		} else if (appended && slot.announced) {
			deltas.push({ tool_calls: [{ index: slot.index, function: { arguments: appended } }] });
		}

		if (event.isComplete) {
			slot.complete = true;
			checkToolCallArguments(this.tools, slot.name, slot.args, this.modelId);
		}

		return deltas;
	}

	private flushIncompleteTools(): CursorDelta[] {
		const deltas: CursorDelta[] = [];

		for (const slot of this.slots) {
			if (!slot.announced) {
				slot.announced = true;
				deltas.push({
					tool_calls: [
						{ index: slot.index, id: slot.id, type: 'function', function: { name: slot.name || 'unknown', arguments: slot.args } }
					]
				});
			}
		}

		return deltas;
	}
}

export interface CursorStreamOptions {
	events: AsyncIterable<CursorBridgeEventBody>;
	streamId: string;
	/** Model id reported to the client (Ungate mapping id). */
	modelName: string;
	upstreamModel: string;
	tools: OpenAITool[] | undefined;
	startTime: number;
	telemetry: RequestTelemetry;
	signal?: AbortSignal;
	/** Called once with the terminal error (before any output) so the handler can map it. */
	onError?: (error: CursorBridgeError) => void;
	/** Hold tool calls until the invocation ends (embedded tool mode); required for `repair`. */
	holdToolCalls?: boolean;
	/**
	 * Starts the single repair invocation for held tool calls with invalid arguments. Its events
	 * (from `ready` on) continue the same response.
	 */
	repair?: (round: RepairRound) => AsyncIterable<CursorBridgeEventBody>;
}

export interface RepairRound {
	text: string;
	calls: ToolCallCheckInput[];
	invalid: InvalidToolCall[];
}

export const TOOL_ARGS_REPAIR_REASON = 'tool_args_repair';

/** Applies events until the invocation ends or the consumer stops it. */
async function drain(
	iterator: AsyncIterator<CursorBridgeEventBody>,
	acc: CursorResponseAccumulator,
	emit: (delta: CursorDelta) => void,
	stopped: () => boolean
): Promise<void> {
	for (;;) {
		if (stopped()) return;
		const next = await iterator.next();
		if (next.done || stopped()) return;
		for (const delta of acc.apply(next.value)) emit(delta);
		if (acc.ended) return;
	}
}

/**
 * Runs the response to completion: the first invocation, at most one tool-argument repair
 * invocation, then releases held tool calls. Returns the iterator that was active last.
 */
async function runRounds(
	options: CursorStreamOptions,
	acc: CursorResponseAccumulator,
	emit: (delta: CursorDelta) => void,
	stopped: () => boolean,
	setActive: (iterator: AsyncIterator<CursorBridgeEventBody>) => void,
	first: AsyncIterator<CursorBridgeEventBody>
): Promise<void> {
	await drain(first, acc, emit, stopped);
	if (stopped()) return;

	const invalid = acc.holdToolCalls && options.repair && !acc.error ? acc.invalidToolCalls() : [];
	if (invalid.length > 0 && options.repair) {
		logger.warn(
			`[cursor] ${options.upstreamModel} repairing ${invalid.length} tool call(s) with invalid arguments: ${invalid
				.slice(0, 5)
				.map((call) => `${call.name} (${call.problems.slice(0, 3).join('; ')})`)
				.join(', ')}`
		);
		const round: RepairRound = { text: acc.text, calls: acc.pendingToolCalls, invalid };
		const held = acc.beginRepairRound();
		const repair = options.repair(round)[Symbol.asyncIterator]();
		setActive(repair);
		await drain(repair, acc, emit, stopped);
		if (stopped()) return;

		for (const delta of acc.settleRepairRound(held)) emit(delta);
		const stillInvalid = acc.invalidToolCalls();
		if (stillInvalid.length > 0) {
			logger.warn(
				`[cursor] ${options.upstreamModel} tool arguments still invalid after repair: ${stillInvalid
					.slice(0, 5)
					.map((call) => call.name)
					.join(', ')}`
			);
		}
	}

	for (const delta of acc.releaseToolCalls()) emit(delta);
}

function openAiUsage(
	usage: CursorUsage | null
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } & Record<string, unknown> {
	const input = usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0;
	const output = usage?.outputTokens ?? 0;

	return {
		prompt_tokens: input,
		completion_tokens: output,
		total_tokens: input + output,
		prompt_tokens_details: { cached_tokens: usage?.cacheReadTokens ?? 0 },
		completion_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 }
	};
}

function recordRow(options: CursorStreamOptions, acc: CursorResponseAccumulator, stream: boolean, aborted: boolean): void {
	const usage = acc.usage;

	try {
		Requests.record({
			...options.telemetry,
			...(acc.repaired ? { attempts: 2, rotationReason: TOOL_ARGS_REPAIR_REASON } : {}),
			model: options.modelName,
			source: 'cursor',
			inputTokens: usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0,
			outputTokens: usage?.outputTokens ?? 0,
			cacheReadTokens: usage ? usage.cacheReadTokens : null,
			cacheCreationTokens: usage ? usage.cacheWriteTokens : null,
			reasoningTokens: usage?.reasoningTokens ?? null,
			reasoningChars: acc.reasoningChars || null,
			stream,
			latencyMs: Date.now() - options.startTime,
			error: aborted ? null : (acc.error?.message ?? null),
			stopReason: acc.stopReason(aborted),
			toolCallCount: acc.toolNames.length,
			toolNames: acc.toolNames,
			firstTokenMs: acc.firstTokenAt ? acc.firstTokenAt - options.startTime : null
		});
	} catch (error) {
		logger.error(`[cursor] failed to record request: ${String(error)}`);
	}
}

export class CursorStreamHandler {
	static readonly headers: Record<string, string> = {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
		'openai-version': '2020-10-01'
	};

	/**
	 * SSE response for an already-started invocation (the caller consumed `ready`). Records exactly
	 * one analytics row when the stream ends, is cancelled by the client, or fails.
	 */
	static createStreamResponse(options: CursorStreamOptions): StreamResult {
		const acc = new CursorResponseAccumulator(options.upstreamModel, options.tools, options.holdToolCalls === true);
		const encoder = new TextEncoder();
		let iterator = options.events[Symbol.asyncIterator]();
		let cancelled = false;
		let recorded = false;

		const record = (aborted: boolean) => {
			if (recorded) return;
			recorded = true;
			recordRow(options, acc, true, aborted);
		};

		const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
			`data: ${JSON.stringify({
				id: `chatcmpl-${options.streamId}`,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model: options.modelName,
				choices: [{ index: 0, delta, finish_reason: finishReason }]
			})}\n\n`;

		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				const enqueue = (text: string) => {
					if (cancelled) return;
					try {
						controller.enqueue(encoder.encode(text));
					} catch {
						cancelled = true;
					}
				};

				enqueue(chunk({ role: 'assistant', content: '' }));

				try {
					await runRounds(
						options,
						acc,
						(delta) => enqueue(chunk(delta)),
						() => cancelled,
						(active) => (iterator = active),
						iterator
					);

					if (cancelled || options.signal?.aborted) {
						record(true);

						return;
					}

					if (acc.error && acc.error.kind !== 'cancelled' && acc.finishReason() !== 'length') {
						// Mid-stream failure: surface it in-band, then finish the turn.
						enqueue(
							`data: ${JSON.stringify({ error: { message: acc.error.message, type: 'api_error', code: acc.error.kind } })}\n\n`
						);
					}

					enqueue(chunk({}, acc.finishReason()));
					enqueue(
						`data: ${JSON.stringify({
							id: `chatcmpl-${options.streamId}`,
							object: 'chat.completion.chunk',
							created: Math.floor(Date.now() / 1000),
							model: options.modelName,
							choices: [],
							usage: openAiUsage(acc.usage)
						})}\n\n`
					);
					enqueue('data: [DONE]\n\n');
					record(acc.error?.kind === 'cancelled');
				} catch (error) {
					logger.error(`[cursor] stream failed: ${String(error)}`);
					acc.error ??= { kind: 'upstream', message: 'Cursor stream failed' };
					record(false);
				} finally {
					if (!acc.ended) void iterator.return?.(undefined);
					try {
						if (!cancelled) controller.close();
					} catch {
						// already closed
					}
				}
			},
			cancel() {
				cancelled = true;
				void iterator.return?.(undefined);
				record(true);
			}
		});

		return { stream, headers: { ...CursorStreamHandler.headers, 'x-request-id': `req_${options.streamId}` } };
	}

	/** Bounded collection for `stream: false`. */
	static async collect(
		options: CursorStreamOptions,
		maxChars = 4 * 1024 * 1024
	): Promise<{ response: OpenAIChatResponse | null; error: CursorBridgeError | null }> {
		const acc = new CursorResponseAccumulator(options.upstreamModel, options.tools, options.holdToolCalls === true);
		let iterator = options.events[Symbol.asyncIterator]();
		let tooLarge = false;

		try {
			await runRounds(
				options,
				acc,
				() => undefined,
				() => {
					tooLarge ||= acc.outputChars > maxChars;

					return tooLarge;
				},
				(active) => (iterator = active),
				iterator
			);
		} finally {
			if (!acc.ended || tooLarge) await iterator.return?.(undefined);
		}

		if (tooLarge) acc.error = { kind: 'upstream', message: 'Cursor response exceeded the non-streaming size limit' };

		const aborted = options.signal?.aborted === true || acc.error?.kind === 'cancelled';
		recordRow(options, acc, false, aborted);

		if (
			acc.error?.kind === 'billing_blocked' ||
			(acc.error && acc.finishReason() !== 'length' && !acc.text && acc.toolCalls.length === 0)
		) {
			return { response: null, error: acc.error };
		}

		const toolCalls = acc.toolCalls;
		const usage = openAiUsage(acc.usage);

		return {
			error: null,
			response: {
				id: `chatcmpl-${options.streamId}`,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: options.modelName,
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content: acc.text || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
						finish_reason: acc.finishReason()
					}
				],
				usage
			}
		};
	}
}

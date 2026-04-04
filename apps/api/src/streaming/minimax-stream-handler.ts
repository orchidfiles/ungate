import { logger } from 'src/utils/logger';

import { Requests } from '../database/requests';

import type { RequestContext, StreamResult } from '../types/proxy';

type MiniMaxStreamState = 'content' | 'thinking';

interface MiniMaxToolCallDelta {
	index: number;
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

interface MiniMaxStreamEvent {
	choices?: {
		delta?: {
			content?: string | null;
			role?: string;
			tool_calls?: MiniMaxToolCallDelta[];
		};
		finish_reason?: string | null;
	}[];
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

function buildChunk(
	streamId: string,
	modelName: string,
	delta: Record<string, unknown>,
	finishReason: string | null = null
): string {
	return `data: ${JSON.stringify({
		id: `chatcmpl-${streamId}`,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: modelName,
		choices: [{ index: 0, delta, finish_reason: finishReason }]
	})}\n\n`;
}

function buildUsageChunk(
	streamId: string,
	modelName: string,
	usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): string {
	return `data: ${JSON.stringify({
		id: `chatcmpl-${streamId}`,
		object: 'chat.completion.chunk',
		created: Math.floor(Date.now() / 1000),
		model: modelName,
		choices: [],
		usage
	})}\n\n`;
}

function getPartialTagSuffix(text: string): string {
	const candidates = [THINK_OPEN, THINK_CLOSE];

	for (let length = Math.min(text.length, THINK_CLOSE.length); length > 0; length--) {
		const suffix = text.slice(-length);
		if (candidates.some((tag) => tag.startsWith(suffix))) {
			return suffix;
		}
	}

	return '';
}

function parseMiniMaxDelta(
	text: string,
	state: MiniMaxStreamState,
	pendingTag: string
): {
	segments: { kind: 'content' | 'reasoning'; text: string }[];
	state: MiniMaxStreamState;
	pendingTag: string;
} {
	const segments: { kind: 'content' | 'reasoning'; text: string }[] = [];
	let buffer = pendingTag + text;
	let nextState = state;

	while (buffer.length > 0) {
		if (nextState === 'content') {
			const openIndex = buffer.indexOf(THINK_OPEN);

			if (openIndex === -1) {
				const pending = getPartialTagSuffix(buffer);
				const safeText = pending ? buffer.slice(0, -pending.length) : buffer;
				if (safeText) {
					segments.push({ kind: 'content', text: safeText });
				}

				return { segments, state: nextState, pendingTag: pending };
			}

			if (openIndex > 0) {
				segments.push({ kind: 'content', text: buffer.slice(0, openIndex) });
			}

			buffer = buffer.slice(openIndex + THINK_OPEN.length);
			nextState = 'thinking';
			continue;
		}

		const closeIndex = buffer.indexOf(THINK_CLOSE);

		if (closeIndex === -1) {
			const pending = getPartialTagSuffix(buffer);
			const safeText = pending ? buffer.slice(0, -pending.length) : buffer;
			if (safeText) {
				segments.push({ kind: 'reasoning', text: safeText });
			}

			return { segments, state: nextState, pendingTag: pending };
		}

		if (closeIndex > 0) {
			segments.push({ kind: 'reasoning', text: buffer.slice(0, closeIndex) });
		}

		buffer = buffer.slice(closeIndex + THINK_CLOSE.length);
		nextState = 'content';
	}

	return { segments, state: nextState, pendingTag: '' };
}

export class MiniMaxStreamHandler {
	static createStreamResponse(response: Response, streamId: string, modelName: string, context: RequestContext): StreamResult {
		const headers: Record<string, string> = {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
			'x-request-id': `req_${streamId}`,
			'openai-processing-ms': '0',
			'openai-version': '2020-10-01'
		};

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('No response body');
		}

		return {
			stream: this.createStream({ reader, streamId, modelName, context }),
			headers
		};
	}

	private static createStream(options: {
		reader: ReadableStreamDefaultReader<Uint8Array>;
		streamId: string;
		modelName: string;
		context: RequestContext;
	}): ReadableStream {
		const { reader, streamId, modelName, context } = options;
		let cancelled = false;

		return new ReadableStream({
			async start(controller) {
				const decoder = new TextDecoder();
				const encoder = new TextEncoder();
				let sseBuffer = '';
				let sentStart = false;
				let finishReason: 'stop' | 'length' | 'tool_calls' | null = null;
				let sawDone = false;
				let usage:
					| {
							prompt_tokens: number;
							completion_tokens: number;
							total_tokens: number;
					  }
					| undefined;
				let streamState: MiniMaxStreamState = 'content';
				let pendingTag = '';

				const safeEnqueue = (chunk: string) => {
					try {
						if (!cancelled) {
							controller.enqueue(encoder.encode(chunk));
						}
					} catch {
						cancelled = true;
					}
				};

				try {
					while (true) {
						if (cancelled) break;

						const { done, value } = await reader.read();
						if (cancelled) break;
						if (done) break;

						sseBuffer += decoder.decode(value, { stream: true });
						const lines = sseBuffer.split('\n');
						sseBuffer = lines.pop() ?? '';

						for (const line of lines) {
							if (cancelled || !line.startsWith('data: ')) continue;

							const data = line.slice(6);
							if (data === '[DONE]') {
								sawDone = true;
								continue;
							}

							try {
								const event = JSON.parse(data) as MiniMaxStreamEvent;
								const choice = event.choices?.[0];

								if (!sentStart) {
									safeEnqueue(buildChunk(streamId, modelName, { role: 'assistant' }));
									sentStart = true;
								}

								if (choice?.finish_reason) {
									finishReason = choice.finish_reason as 'stop' | 'length' | 'tool_calls';
								}

								if (event.usage?.completion_tokens !== undefined) {
									const promptTokens = event.usage.prompt_tokens ?? context.inputTokens ?? 0;
									const completionTokens = event.usage.completion_tokens;
									const totalTokens = event.usage.total_tokens ?? promptTokens + completionTokens;
									usage = {
										prompt_tokens: promptTokens,
										completion_tokens: completionTokens,
										total_tokens: totalTokens
									};
								}

								const toolCallDeltas = choice?.delta?.tool_calls;
								if (toolCallDeltas && toolCallDeltas.length > 0) {
									for (const tc of toolCallDeltas) {
										const toolCallChunk: Record<string, unknown> = { index: tc.index };
										const toolFunction: Record<string, string> = {};

										if (tc.id) {
											toolCallChunk.id = tc.id;
											toolCallChunk.type = tc.type ?? 'function';
										}

										if (tc.function?.name !== undefined) {
											toolFunction.name = tc.function.name;
										}

										if (tc.function?.arguments !== undefined) {
											toolFunction.arguments = tc.function.arguments;
										}

										if (Object.keys(toolFunction).length > 0) {
											toolCallChunk.function = toolFunction;
										}

										safeEnqueue(buildChunk(streamId, modelName, { tool_calls: [toolCallChunk] }));
									}
									continue;
								}

								const deltaText = choice?.delta?.content;
								if (!deltaText) {
									continue;
								}

								const parsed = parseMiniMaxDelta(deltaText, streamState, pendingTag);
								streamState = parsed.state;
								pendingTag = parsed.pendingTag;

								for (const segment of parsed.segments) {
									if (!segment.text) continue;

									if (segment.kind === 'reasoning') {
										safeEnqueue(buildChunk(streamId, modelName, { reasoning_content: segment.text }));
										continue;
									}

									safeEnqueue(buildChunk(streamId, modelName, { content: segment.text }));
								}
							} catch (error) {
								logger.error(`MiniMax stream parse error: ${String(error)}`);
							}
						}
					}

					if (pendingTag) {
						if (streamState === 'thinking') {
							safeEnqueue(buildChunk(streamId, modelName, { reasoning_content: pendingTag }));
						} else {
							safeEnqueue(buildChunk(streamId, modelName, { content: pendingTag }));
						}
					}

					safeEnqueue(buildChunk(streamId, modelName, {}, finishReason ?? 'stop'));

					if (usage) {
						safeEnqueue(buildUsageChunk(streamId, modelName, usage));
					}

					Requests.record({
						model: modelName,
						source: 'minimax',
						inputTokens: usage?.prompt_tokens ?? 0,
						outputTokens: usage?.completion_tokens ?? 0,
						stream: true,
						latencyMs: Date.now() - context.startTime
					});

					safeEnqueue('data: [DONE]\n\n');
				} catch (error) {
					if (!cancelled) {
						logger.error(`MiniMax stream processing failed: ${String(error)}`);
						try {
							controller.error(error);
						} catch {
							// Controller already closed
						}
					}
				} finally {
					if (!sawDone && !cancelled) {
						try {
							reader.cancel().catch(() => {});
						} catch {
							// Reader already released
						}
					}

					try {
						if (!cancelled) {
							controller.close();
						}
					} catch {
						// Controller already closed
					}
				}
			},
			cancel(reason) {
				cancelled = true;
				reader.cancel(reason).catch(() => {});
			}
		});
	}
}

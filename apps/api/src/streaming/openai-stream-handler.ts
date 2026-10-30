import { logger } from 'src/utils/logger';

import { AnthropicToOpenai } from '../adapter/anthropic-to-openai';
import { Requests } from '../database/requests';
import { ToolNormalizer } from '../tools/normalizer';
import { type ToolUseBlock, type StreamResult, type RequestContext } from '../types/proxy';

import type { AnthropicStopReason, AnthropicStreamEvent } from '../types/anthropic-stream';

interface StreamHandlerOptions {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	streamId: string;
	modelName: string;
	context: RequestContext;
}

interface ActiveToolCall {
	id: string;
	name: string;
	inputJson: string;
	blockIndex: number;
	outputIndex: number;
}

interface StreamUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

export class OpenAIStreamHandler {
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

		const stream = this.createStream({ reader, streamId, modelName, context });

		return { stream, headers };
	}

	private static createStream(options: StreamHandlerOptions): ReadableStream {
		const { reader, streamId, modelName, context } = options;

		let cancelled = false;
		const activeToolCalls = new Map<number, ActiveToolCall>();

		const describeOpenTools = (): string => {
			if (activeToolCalls.size === 0) {
				return 'tool=none';
			}

			return Array.from(activeToolCalls.values())
				.map((toolCall) => `tool=${toolCall.name} toolId=${toolCall.id} argsLength=${toolCall.inputJson.length}`)
				.join(' ');
		};

		return new ReadableStream({
			async start(controller) {
				const decoder = new TextDecoder();
				let buffer = '';
				let sentStart = false;
				let nextToolCallIndex = 0;
				let completedToolCallCount = 0;
				let finalized = false;
				let stopReason: AnthropicStopReason | null = null;
				let finalUsage: StreamUsage | null = null;
				let salvageFailed = false;

				const safeEnqueue = (data: Uint8Array) => {
					try {
						if (!cancelled) {
							controller.enqueue(data);
						}
					} catch {
						cancelled = true;
					}
				};

				const flushToolCall = (toolCall: ActiveToolCall, mode: 'complete' | 'salvage'): boolean => {
					if (mode === 'salvage' && !toolCall.inputJson) {
						logger.error(
							`Incomplete tool call tool=${toolCall.name} toolId=${toolCall.id} argsLength=${toolCall.inputJson.length}`
						);
						activeToolCalls.delete(toolCall.blockIndex);

						return false;
					}

					let finalJson = toolCall.inputJson || '{}';

					try {
						const parsedArgs = JSON.parse(finalJson);
						const toolUse: ToolUseBlock = {
							type: 'tool_use',
							id: toolCall.id,
							name: toolCall.name,
							input: parsedArgs
						};

						const normalized = ToolNormalizer.normalize(toolUse);
						if (ToolNormalizer.hasChanged(toolUse, normalized)) {
							finalJson = JSON.stringify(normalized.input);
						}
					} catch {
						logger.error(`Failed to parse tool args for ${toolCall.name}`);

						if (mode === 'salvage') {
							activeToolCalls.delete(toolCall.blockIndex);

							return false;
						}
					}

					safeEnqueue(
						new TextEncoder().encode(
							AnthropicToOpenai.toolCallChunk(streamId, modelName, toolCall.outputIndex, undefined, undefined, finalJson, null)
						)
					);

					completedToolCallCount++;
					activeToolCalls.delete(toolCall.blockIndex);

					return true;
				};

				const mapFinishReason = (unexpectedEof: boolean): 'stop' | 'length' | 'tool_calls' => {
					if (
						unexpectedEof ||
						salvageFailed ||
						activeToolCalls.size > 0 ||
						stopReason === 'max_tokens' ||
						stopReason === 'model_context_window_exceeded'
					) {
						return 'length';
					}

					if (completedToolCallCount > 0) {
						return 'tool_calls';
					}

					return 'stop';
				};

				const finalizeStream = (unexpectedEof: boolean) => {
					if (finalized || cancelled) {
						return;
					}

					finalized = true;

					logger.log(
						`Stream stop_reason=${stopReason ?? 'none'} unexpectedEof=${unexpectedEof} completedToolCalls=${completedToolCallCount}`
					);

					if (unexpectedEof && activeToolCalls.size > 0) {
						logger.error(`Unexpected EOF with open tool calls ${describeOpenTools()}`);
						activeToolCalls.clear();
					}

					const finishReason = mapFinishReason(unexpectedEof);

					safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamChunk(streamId, modelName, undefined, finishReason)));

					if (finalUsage) {
						safeEnqueue(
							new TextEncoder().encode(
								AnthropicToOpenai.streamChunk(streamId, modelName, undefined, undefined, {
									prompt_tokens: finalUsage.input_tokens,
									completion_tokens: finalUsage.output_tokens,
									total_tokens: finalUsage.input_tokens + finalUsage.output_tokens
								})
							)
						);

						Requests.record(
							{
								model: context.model,
								source: context.source,
								inputTokens: finalUsage.input_tokens,
								outputTokens: finalUsage.output_tokens,
								stream: true,
								latencyMs: Date.now() - context.startTime
							},
							finalUsage.cache_read_input_tokens,
							finalUsage.cache_creation_input_tokens
						);
					}

					safeEnqueue(new TextEncoder().encode('data: [DONE]\n\n'));
				};

				try {
					while (true) {
						if (cancelled) break;

						const { done, value } = await reader.read();

						if (cancelled) break;
						if (done) {
							finalizeStream(true);
							break;
						}

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						buffer = lines.pop() ?? '';

						for (const line of lines) {
							if (cancelled) break;
							if (!line.startsWith('data: ')) continue;

							const data = line.slice(6);
							if (data === '[DONE]') {
								finalizeStream(false);
								continue;
							}

							try {
								const event = JSON.parse(data) as AnthropicStreamEvent;

								if (event.type === 'message_start' && !sentStart) {
									safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamStart(streamId, modelName)));
									sentStart = true;
								}

								if (event.type === 'content_block_start') {
									if (!sentStart) {
										safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamStart(streamId, modelName)));
										sentStart = true;
									}

									const block = event.content_block;

									if (block?.type === 'tool_use') {
										const originalName = context.reverseToolMapping[block.name] ?? block.name;
										const toolCall: ActiveToolCall = {
											id: block.id,
											name: originalName,
											inputJson: '',
											blockIndex: event.index,
											outputIndex: nextToolCallIndex++
										};

										activeToolCalls.set(event.index, toolCall);

										safeEnqueue(
											new TextEncoder().encode(
												AnthropicToOpenai.toolCallChunk(
													streamId,
													modelName,
													toolCall.outputIndex,
													block.id,
													originalName,
													undefined,
													null
												)
											)
										);
									}
								}

								if (event.type === 'content_block_stop') {
									const toolCall = activeToolCalls.get(event.index);
									if (toolCall) {
										flushToolCall(toolCall, 'complete');
									}
								}

								if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
									const toolCall = activeToolCalls.get(event.index);
									if (toolCall) {
										toolCall.inputJson += event.delta.partial_json ?? '';
										continue;
									}
								}

								if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
									if (!sentStart) {
										safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamStart(streamId, modelName)));
										sentStart = true;
									}

									safeEnqueue(new TextEncoder().encode(AnthropicToOpenai.streamChunk(streamId, modelName, event.delta.text)));
								}

								if (event.type === 'message_start' && event.message?.usage) {
									const usage = event.message.usage;
									const cacheRead = usage.cache_read_input_tokens ?? 0;
									const cacheCreate = usage.cache_creation_input_tokens ?? 0;
									const regularInput = usage.input_tokens ?? 0;

									finalUsage = {
										input_tokens: regularInput + cacheCreate + cacheRead,
										output_tokens: usage.output_tokens ?? 0,
										cache_read_input_tokens: cacheRead,
										cache_creation_input_tokens: cacheCreate
									};
								}

								if (event.type === 'message_delta') {
									if (event.delta?.stop_reason) {
										stopReason = event.delta.stop_reason;
									}

									if (event.usage && finalUsage) {
										finalUsage.output_tokens = event.usage.output_tokens ?? 0;
									}
								}

								if (event.type === 'message_stop') {
									if (stopReason === 'tool_use') {
										for (const toolCall of activeToolCalls.values()) {
											if (!flushToolCall(toolCall, 'salvage')) {
												salvageFailed = true;
											}
										}
									} else if (activeToolCalls.size > 0) {
										logger.error(`Open tool calls at message_stop stop_reason=${stopReason ?? 'none'} ${describeOpenTools()}`);
									}

									finalizeStream(false);
								}
							} catch (parseError) {
								if (!cancelled) {
									logger.error(`Failed to parse stream event: ${String(parseError)}`);
								}
							}
						}
					}
				} catch (streamError) {
					if (!cancelled) {
						logger.error(`Stream processing failed: ${String(streamError)}`);

						const errorStr = String(streamError);
						if (errorStr.includes('illegal') || errorStr.includes('invalid') || errorStr.includes('argument')) {
							logger.rareError(`Stream error: ${errorStr}`, {
								error: streamError,
								streamId: options.streamId,
								model: options.modelName
							});
						}

						try {
							controller.error(streamError);
						} catch {
							// Controller already closed
						}
					}
				} finally {
					try {
						if (!cancelled) reader.cancel().catch(() => {});
					} catch {
						// Reader already released
					}

					try {
						if (!cancelled) controller.close();
					} catch {
						// Controller already closed
					}
				}
			},
			cancel(reason) {
				cancelled = true;
				logger.error(`Downstream cancelled stream id=${streamId} reason=${String(reason)} ${describeOpenTools()}`);
				reader.cancel(reason).catch(() => {});
			}
		});
	}
}

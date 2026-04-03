import { logger } from 'src/utils/logger';

import { AnthropicToOpenai } from '../adapter/anthropic-to-openai';
import { Requests } from '../database/requests';
import { ToolNormalizer } from '../tools/normalizer';
import { type ToolUseBlock, type StreamResult, type RequestContext } from '../types/proxy';

import type { AnthropicStreamEvent } from '../types/anthropic-stream';

interface StreamHandlerOptions {
	reader: ReadableStreamDefaultReader<Uint8Array>;
	streamId: string;
	modelName: string;
	context: RequestContext;
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

		return new ReadableStream({
			async start(controller) {
				const decoder = new TextDecoder();
				let buffer = '';
				let sentStart = false;
				let toolCallIndex = 0;
				let currentToolCall: {
					id: string;
					name: string;
					inputJson: string;
				} | null = null;

				let finalUsage: {
					input_tokens: number;
					output_tokens: number;
					cache_read_input_tokens: number;
					cache_creation_input_tokens: number;
				} | null = null;

				const safeEnqueue = (data: Uint8Array) => {
					try {
						if (!cancelled) {
							controller.enqueue(data);
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

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						buffer = lines.pop() ?? '';

						for (const line of lines) {
							if (cancelled) break;
							if (!line.startsWith('data: ')) continue;

							const data = line.slice(6);
							if (data === '[DONE]') {
								safeEnqueue(new TextEncoder().encode('data: [DONE]\n\n'));
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

										currentToolCall = { id: block.id, name: originalName, inputJson: '' };

										safeEnqueue(
											new TextEncoder().encode(
												AnthropicToOpenai.toolCallChunk(
													streamId,
													modelName,
													toolCallIndex,
													block.id,
													originalName,
													undefined,
													null
												)
											)
										);
									}
								}

								if (event.type === 'content_block_stop' && currentToolCall) {
									let finalJson = currentToolCall.inputJson || '{}';

									try {
										const parsedArgs = JSON.parse(finalJson);
										const toolUse: ToolUseBlock = {
											type: 'tool_use',
											id: currentToolCall.id,
											name: currentToolCall.name,
											input: parsedArgs
										};

										const normalized = ToolNormalizer.normalize(toolUse);
										if (ToolNormalizer.hasChanged(toolUse, normalized)) {
											finalJson = JSON.stringify(normalized.input);
										}
									} catch {
										logger.error(`Failed to parse tool args for ${currentToolCall.name}`);
									}

									safeEnqueue(
										new TextEncoder().encode(
											AnthropicToOpenai.toolCallChunk(streamId, modelName, toolCallIndex, undefined, undefined, finalJson, null)
										)
									);

									toolCallIndex++;
									currentToolCall = null;
								}

								if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && currentToolCall) {
									currentToolCall.inputJson += event.delta.partial_json ?? '';
									continue;
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

								if (event.type === 'message_delta' && event.usage && finalUsage) {
									finalUsage.output_tokens = event.usage.output_tokens ?? 0;
								}

								if (event.type === 'message_stop') {
									const finishReason = toolCallIndex > 0 ? 'tool_calls' : 'stop';

									safeEnqueue(
										new TextEncoder().encode(AnthropicToOpenai.streamChunk(streamId, modelName, undefined, finishReason))
									);

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
				reader.cancel(reason).catch(() => {});
			}
		});
	}
}

import { logger } from 'src/utils/logger';

import { ToolTranslator } from '../tools/translator';

import type { ContentBlock, AnthropicResponse } from '../types';
import type { OpenAIChatResponse, OpenAIStreamChunkToolCall, OpenAIStreamChunk } from '../types/openai';

export class AnthropicToOpenai {
	static convert(anthropicResponse: AnthropicResponse, model: string): OpenAIChatResponse {
		let content =
			anthropicResponse.content
				?.map((block: ContentBlock) => {
					if (block.type === 'text') return block.text;
					if (block.type === 'tool_use') return `[Tool: ${block.name}]`;

					return '';
				})
				.join('') ?? '';

		if (ToolTranslator.needsTranslation(content)) {
			content = ToolTranslator.translate(content);
		}

		const stopReason = anthropicResponse.stop_reason;
		const finishReason =
			stopReason === 'end_turn' || stopReason === null ? 'stop' : stopReason === 'max_tokens' ? 'length' : 'stop';

		const result: OpenAIChatResponse = {
			id: `chatcmpl-${anthropicResponse.id ?? Date.now()}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
			usage: {
				prompt_tokens: anthropicResponse.usage?.input_tokens ?? 0,
				completion_tokens: anthropicResponse.usage?.output_tokens ?? 0,
				total_tokens: (anthropicResponse.usage?.input_tokens ?? 0) + (anthropicResponse.usage?.output_tokens ?? 0)
			}
		};

		return result;
	}

	static streamStart(id: string, model: string): string {
		const chunk: OpenAIStreamChunk = {
			id: `chatcmpl-${id}`,
			object: 'chat.completion.chunk',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
		};

		return `data: ${JSON.stringify(chunk)}\n\n`;
	}

	static streamChunk(
		id: string,
		model: string,
		content?: string,
		finishReason?: 'stop' | 'length' | 'tool_calls' | null,
		usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
	): string {
		const chunk: {
			id: string;
			object: string;
			created: number;
			model: string;
			choices: { index: number; delta: { content?: string }; finish_reason: string | null }[];
			usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
		} = {
			id: `chatcmpl-${id}`,
			object: 'chat.completion.chunk',
			created: Math.floor(Date.now() / 1000),
			model,
			choices:
				usage === undefined
					? [{ index: 0, delta: content !== undefined ? { content } : {}, finish_reason: finishReason ?? null }]
					: []
		};

		if (usage !== undefined) {
			chunk.usage = usage;
		}

		return `data: ${JSON.stringify(chunk)}\n\n`;
	}

	// OpenAI streams tool calls in multiple chunks:
	// First chunk: id, type="function", function.name, function.arguments=""
	// Subsequent: only function.arguments with fragments
	static toolCallChunk(
		id: string,
		model: string,
		toolCallIndex: number,
		toolCallId?: string,
		functionName?: string,
		functionArgs?: string,
		finishReason?: 'tool_calls' | null
	): string {
		const toolCall: OpenAIStreamChunkToolCall = { index: toolCallIndex };

		if (toolCallId) {
			toolCall.id = toolCallId;
			toolCall.type = 'function';
			toolCall.function = { name: functionName ?? '', arguments: '' };
		} else if (functionArgs !== undefined) {
			toolCall.function = { arguments: functionArgs };
		}

		const chunk: OpenAIStreamChunk = {
			id: `chatcmpl-${id}`,
			object: 'chat.completion.chunk',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: finishReason ?? null }]
		};

		logger.log(
			`[EMIT TOOL CALL CHUNK] index=${toolCallIndex}, id=${toolCallId ?? '-'}, name=${functionName ?? '-'}, args=${functionArgs ? functionArgs.slice(0, 200) : '-'}`
		);

		return `data: ${JSON.stringify(chunk)}\n\n`;
	}
}

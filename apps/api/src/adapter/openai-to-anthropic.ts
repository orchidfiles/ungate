import { logger } from 'src/utils/logger';

import type { AnthropicRequest, AnthropicMessage, ContentBlock } from '../types';
import type { OpenAIContentPart, OpenAIChatRequest } from '../types/openai';
import type { ReasoningBudgetTier } from '@ungate/shared';

// Legacy Cursor model names can include explicit budgets or the old "-thinking" suffix.
// e.g. "claude-4.6-opus-high" → "claude-opus-4-6" with reasoningBudget="high"
export function normalizeModelName(model: string): { model: string; reasoningBudget?: string } {
	const match46 = /^claude-4\.6-(opus|sonnet)(?:-(high|medium|low))?(?:-thinking)?$/.exec(model);
	if (match46) {
		return {
			model: `claude-${match46[1]}-4-6`,
			reasoningBudget: match46[2] || undefined
		};
	}

	const match = /^claude-4\.5-(opus|sonnet|haiku)(?:-(high|medium|low))?(?:-thinking)?$/.exec(model);
	if (match) {
		const modelType = match[1] as 'opus' | 'sonnet' | 'haiku';
		const budget = match[2];

		const modelMap = {
			opus: 'claude-opus-4-5-20251101',
			sonnet: 'claude-sonnet-4-5-20250929',
			haiku: 'claude-haiku-4-5-20251001'
		} as const;

		return { model: modelMap[modelType], reasoningBudget: budget || undefined };
	}

	return { model };
}

export interface AnthropicModelOverride {
	model: string;
	reasoningBudget?: ReasoningBudgetTier | null;
}

function convertContent(content: string | OpenAIContentPart[] | ContentBlock[]): string | ContentBlock[] {
	if (typeof content === 'string') {
		return content;
	}

	const blocks: ContentBlock[] = [];

	for (const part of content) {
		// Pass through Anthropic-format blocks directly (Cursor sends these)
		if ((part as ContentBlock).type === 'tool_use') {
			blocks.push(part as ContentBlock);
			continue;
		}

		if ((part as ContentBlock).type === 'tool_result') {
			blocks.push(part as ContentBlock);
			continue;
		}

		const openaiPart = part as OpenAIContentPart;
		if (openaiPart.type === 'text') {
			if (openaiPart.text && openaiPart.text.trim().length > 0) {
				blocks.push({ type: 'text', text: openaiPart.text });
			}
		} else if (openaiPart.type === 'image_url' && openaiPart.image_url) {
			const url = openaiPart.image_url.url;
			if (url.startsWith('data:')) {
				const match = /^data:([^;]+);base64,(.+)$/.exec(url);
				if (match) {
					blocks.push({
						type: 'image',
						source: {
							type: 'base64',
							media_type: match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
							data: match[2]
						}
					});
				}
			} else {
				blocks.push({ type: 'image', source: { type: 'url', url } });
			}
		} else if ((part as ContentBlock).type === 'image' && (part as ContentBlock).source) {
			blocks.push(part as ContentBlock);
		}
	}

	return blocks;
}

export function openaiToAnthropic(request: OpenAIChatRequest, override?: AnthropicModelOverride): AnthropicRequest {
	const messages: AnthropicMessage[] = [];
	let system: string | ContentBlock[] | undefined;

	for (const msg of request.messages) {
		if (msg.role === 'system') {
			const content = typeof msg.content === 'string' ? msg.content : (msg.content ?? []).map((p) => p.text ?? '').join('\n');
			if (system) {
				system = typeof system === 'string' ? `${system}\n${content}` : system;
			} else {
				system = content;
			}
		} else if (msg.role === 'assistant') {
			const contentBlocks: ContentBlock[] = [];

			if (msg.content) {
				const convertedContent = convertContent(msg.content);
				if (typeof convertedContent === 'string' && convertedContent.trim().length > 0) {
					contentBlocks.push({ type: 'text', text: convertedContent });
				} else if (Array.isArray(convertedContent)) {
					contentBlocks.push(...convertedContent);
				}
			}

			if (msg.tool_calls && msg.tool_calls.length > 0) {
				for (const toolCall of msg.tool_calls) {
					let input = {};
					try {
						input = JSON.parse(toolCall.function.arguments);
					} catch {
						input = { raw: toolCall.function.arguments };
					}
					contentBlocks.push({
						type: 'tool_use',
						id: toolCall.id,
						name: toolCall.function.name,
						input
					});
				}
			}

			if (contentBlocks.length > 0) {
				messages.push({ role: 'assistant', content: contentBlocks });
			}
		} else if (msg.role === 'tool') {
			const resultContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

			const toolResultContent: ContentBlock[] = [
				{
					type: 'tool_result',
					tool_use_id: msg.tool_call_id ?? '',
					content: resultContent
				}
			];

			const lastMsg = messages[messages.length - 1];
			if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
				lastMsg.content.push(...toolResultContent);
			} else {
				messages.push({ role: 'user', content: toolResultContent });
			}
		} else if (msg.role === 'user') {
			const convertedContent = convertContent(msg.content ?? '');

			if (typeof convertedContent === 'string') {
				if (convertedContent.trim().length === 0) continue;
			} else {
				if (convertedContent.length === 0) continue;
			}

			messages.push({ role: 'user', content: convertedContent });
		}
	}

	if (messages.length > 0 && messages[0].role !== 'user') {
		messages.unshift({ role: 'user', content: 'Continue.' });
	}

	let normalized: { model: string; reasoningBudget?: string };

	if (override) {
		normalized = { model: override.model };

		if (override.reasoningBudget) {
			normalized.reasoningBudget = override.reasoningBudget;
		}
	} else {
		normalized = normalizeModelName(request.model);
	}

	const maxTokens = request.max_tokens ?? request.max_completion_tokens ?? 4096;

	logger.log(
		`[OpenAI→Anthropic] "${request.model}" → "${normalized.model}"${normalized.reasoningBudget ? ` (reasoning_budget: ${normalized.reasoningBudget})` : ''} | max_tokens=${maxTokens}`
	);

	const result: AnthropicRequest = {
		model: normalized.model,
		messages,
		system,
		max_tokens: maxTokens,
		temperature: request.temperature,
		top_p: request.top_p,
		stream: request.stream,
		stop_sequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined
	};

	if (request.tools && request.tools.length > 0) {
		const firstTool = request.tools[0] as unknown as Record<string, unknown>;
		if (firstTool.type === 'function' && firstTool.function) {
			result.tools = request.tools.map((tool) => {
				const t = tool as {
					type: string;
					function: { name: string; description?: string; parameters?: Record<string, unknown> };
				};

				return {
					name: t.function.name,
					description: t.function.description ?? '',
					input_schema: t.function.parameters ?? { type: 'object', properties: {} }
				};
			});
		} else {
			result.tools = request.tools as unknown as typeof result.tools;
		}
	}

	if (request.tool_choice) {
		result.tool_choice = request.tool_choice as unknown as typeof result.tool_choice;
	}

	if (normalized.reasoningBudget) {
		result.reasoning_budget = normalized.reasoningBudget;
	}

	return result;
}

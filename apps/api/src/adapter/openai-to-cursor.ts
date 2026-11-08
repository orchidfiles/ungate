import { buildCursorTools, resolveCursorToolCapability } from './cursor-tool-capability';

import type {
	CursorInferenceContentPart,
	CursorInferenceMessage,
	CursorInferenceRequest,
	CursorInferenceToolCall,
	CursorToolCapability,
	CursorToolMode
} from '@ungate/shared';
import type { OpenAIChatRequest, OpenAIContentPart, OpenAIMessage } from 'src/types/openai';

/** Input Cursor's `RunInference` cannot represent; surfaced to the client as a 400. */
export class CursorRequestError extends Error {
	readonly status = 400;

	constructor(message: string) {
		super(message);
		this.name = 'CursorRequestError';
	}
}

export interface OpenAiToCursorOptions {
	upstreamModel: string;
	toolMode?: CursorToolMode | null;
}

export interface OpenAiToCursorResult {
	request: CursorInferenceRequest;
	capability: CursorToolCapability;
}

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s;

function contentText(content: OpenAIMessage['content']): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';

	return content
		.filter((part) => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text!)
		.join('\n');
}

function toContentParts(content: OpenAIContentPart[]): CursorInferenceContentPart[] {
	const parts: CursorInferenceContentPart[] = [];

	for (const part of content) {
		const type = (part as { type?: unknown })?.type;

		if (type === 'text') {
			if (typeof part.text === 'string' && part.text) parts.push({ text: { text: part.text } });
			continue;
		}

		if (type === 'image_url') {
			const url = part.image_url?.url ?? '';
			const match = DATA_URL.exec(url);
			if (!match) throw new CursorRequestError('Cursor models only accept inline base64 (data:) images');
			parts.push({ image: { data: match[2], mimeType: match[1] } });
			continue;
		}

		if (type === 'input_audio' || type === 'audio') throw new CursorRequestError('Cursor models do not accept audio input');
		throw new CursorRequestError(`Unsupported content part type for Cursor models: ${String(type)}`);
	}

	return parts;
}

function parseArguments(raw: string): Record<string, unknown> {
	if (!raw?.trim()) return {};

	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;

		return { value: parsed };
	} catch {
		return { raw };
	}
}

function rejectUnsupported(body: OpenAIChatRequest): void {
	const extra = body as unknown as Record<string, unknown>;
	const n = extra.n;
	if (typeof n === 'number' && n > 1) throw new CursorRequestError('Cursor models support only n=1');

	const format = extra.response_format as { type?: unknown } | undefined;
	if (format && (format.type === 'json_schema' || format.type === 'json_object')) {
		throw new CursorRequestError('Cursor models do not support response_format');
	}

	if (Array.isArray(extra.modalities) && extra.modalities.includes('audio')) {
		throw new CursorRequestError('Cursor models do not support audio output');
	}

	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		throw new CursorRequestError('messages must be a non-empty array');
	}
}

/** Converts an OpenAI chat-completions request to Cursor's `InferenceStreamRequest` (Connect JSON). */
export function openaiToCursor(body: OpenAIChatRequest, options: OpenAiToCursorOptions): OpenAiToCursorResult {
	rejectUnsupported(body);

	const capability = resolveCursorToolCapability(options.upstreamModel, options.toolMode);
	const toolNamesById = new Map<string, string>();
	const messages: CursorInferenceMessage[] = [];

	for (const message of body.messages) {
		switch (message.role) {
			case 'system':
			case 'developer': {
				const text = contentText(message.content);
				if (text) messages.push({ role: 'INFERENCE_MESSAGE_ROLE_SYSTEM', text });
				break;
			}
			case 'user': {
				if (Array.isArray(message.content)) {
					const parts = toContentParts(message.content);
					if (parts.length === 0) break;
					const onlyText = parts.every((part) => 'text' in part);
					messages.push(
						onlyText
							? {
									role: 'INFERENCE_MESSAGE_ROLE_USER',
									text: parts.map((part) => ('text' in part ? part.text.text : '')).join('\n')
								}
							: { role: 'INFERENCE_MESSAGE_ROLE_USER', parts: { parts } }
					);
				} else if (typeof message.content === 'string' && message.content) {
					messages.push({ role: 'INFERENCE_MESSAGE_ROLE_USER', text: message.content });
				}
				break;
			}
			case 'assistant': {
				const text = contentText(message.content);
				const toolCalls: CursorInferenceToolCall[] = (message.tool_calls ?? [])
					.filter((call) => call?.function?.name)
					.map((call) => {
						toolNamesById.set(call.id, call.function.name);

						return { toolCallId: call.id, toolName: call.function.name, args: parseArguments(call.function.arguments) };
					});
				if (!text && toolCalls.length === 0) break;
				const entry: CursorInferenceMessage = { role: 'INFERENCE_MESSAGE_ROLE_ASSISTANT' };
				if (text) entry.text = text;
				if (toolCalls.length > 0) entry.toolCalls = toolCalls;
				messages.push(entry);
				break;
			}
			case 'tool': {
				const toolCallId = message.tool_call_id ?? '';
				const toolName = toolNamesById.get(toolCallId) ?? message.name ?? '';
				const part = { toolCallId, toolName, result: contentText(message.content), isError: false };
				const previous = messages.at(-1);
				// Parallel tool results answer one assistant turn; keep them in one tool message.
				if (previous?.role === 'INFERENCE_MESSAGE_ROLE_TOOL' && previous.toolContent) {
					previous.toolContent.parts.push(part);
				} else {
					messages.push({ role: 'INFERENCE_MESSAGE_ROLE_TOOL', toolContent: { parts: [part] } });
				}
				break;
			}
			default:
				throw new CursorRequestError(`Unsupported message role for Cursor models: ${String(message.role)}`);
		}
	}

	const request: CursorInferenceRequest = {
		modelId: options.upstreamModel,
		messages,
		tools: body.tool_choice === 'none' ? [] : buildCursorTools(body.tools, capability)
	};

	const maxTokens = body.max_completion_tokens ?? body.max_tokens;
	if (typeof maxTokens === 'number' && maxTokens > 0) request.modelConfig = { maxTokens };

	return { request, capability };
}

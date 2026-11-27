import type { OpenAIChatRequest, OpenAIContentPart, OpenAIMessage } from '../types/openai';
import type { ReasoningBudgetTier } from '@ungate/shared';

/**
 * OpenAI chat completion → Code Assist `CAGenerateContentRequest`
 * (`{ model, project, user_prompt_id, request }`, gemini-cli `code_assist/converter.ts`).
 */

export interface GeminiPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { id?: string; name: string; args: Record<string, unknown> };
	functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
	role: 'user' | 'model';
	parts: GeminiPart[];
}

export type GeminiThinkingLevel = 'low' | 'medium' | 'high';

export interface GeminiGenerateRequest {
	contents: GeminiContent[];
	systemInstruction?: { role: 'user'; parts: GeminiPart[] };
	tools?: { functionDeclarations: { name: string; description?: string; parametersJsonSchema?: unknown }[] }[];
	toolConfig?: { functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] } };
	generationConfig: {
		temperature?: number;
		topP?: number;
		maxOutputTokens?: number;
		stopSequences?: string[];
		thinkingConfig: { includeThoughts: true; thinkingLevel: GeminiThinkingLevel };
	};
}

/**
 * Sent on replayed model `functionCall` parts we have no real signature for. Code Assist rejects a
 * model turn whose first function call has no `thoughtSignature` with HTTP 400; gemini-cli uses
 * this sentinel for the same case (`geminiChat.ts` `SYNTHETIC_THOUGHT_SIGNATURE`).
 */
export const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/** `null` (no extended reasoning) keeps thinking at its lowest level; Gemini 3+ cannot disable it. */
export function geminiThinkingLevel(budget: ReasoningBudgetTier | null | undefined): GeminiThinkingLevel {
	if (budget === 'medium') return 'medium';
	if (budget === 'high' || budget === 'xhigh' || budget === 'max') return 'high';

	return 'low';
}

function textOf(content: OpenAIMessage['content']): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';

	return content
		.filter((part) => part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n');
}

const DATA_URL = /^data:([^;,]+);base64,(.+)$/s;

function userParts(content: OpenAIMessage['content']): GeminiPart[] {
	if (typeof content === 'string') return content ? [{ text: content }] : [];
	if (!Array.isArray(content)) return [];

	return content.flatMap((part: OpenAIContentPart): GeminiPart[] => {
		if (part.type === 'text') return part.text ? [{ text: part.text }] : [];
		const url = part.image_url?.url;
		if (!url) return [];
		const match = DATA_URL.exec(url);

		// Code Assist only takes inline bytes; a remote image is referenced by URL in text.
		return match ? [{ inlineData: { mimeType: match[1], data: match[2] } }] : [{ text: `[image: ${url}]` }];
	});
}

function parseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(raw || '{}');

		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: { value: parsed };
	} catch {
		return { raw };
	}
}

function toolResponse(content: OpenAIMessage['content']): Record<string, unknown> {
	const text = textOf(content);
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Plain-text tool output.
	}

	return { output: text };
}

/** Appends `parts` to the last content when it has the same role (Gemini wants alternating turns). */
function push(contents: GeminiContent[], role: GeminiContent['role'], parts: GeminiPart[]): void {
	if (!parts.length) return;
	const last = contents.at(-1);
	if (last?.role === role) last.parts.push(...parts);
	else contents.push({ role, parts });
}

export function openAiMessagesToGemini(messages: OpenAIMessage[]): Pick<GeminiGenerateRequest, 'contents' | 'systemInstruction'> {
	const system: string[] = [];
	const contents: GeminiContent[] = [];
	/** tool_call_id → function name, so `functionResponse.name` matches its call. */
	const callNames = new Map<string, string>();

	for (const message of messages ?? []) {
		switch (message.role) {
			case 'system':
			case 'developer': {
				const text = textOf(message.content);
				if (text) system.push(text);
				break;
			}
			case 'assistant': {
				const parts: GeminiPart[] = [];
				const text = textOf(message.content);
				if (text) parts.push({ text });
				for (const call of message.tool_calls ?? []) {
					callNames.set(call.id, call.function.name);
					const first = !parts.some((part) => part.functionCall);
					parts.push({
						functionCall: { id: call.id, name: call.function.name, args: parseArgs(call.function.arguments) },
						...(first ? { thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE } : {})
					});
				}
				push(contents, 'model', parts);
				break;
			}
			case 'tool':
			case 'function': {
				const name = (message.tool_call_id && callNames.get(message.tool_call_id)) ?? message.name ?? 'tool';
				push(contents, 'user', [
					{
						functionResponse: {
							...(message.tool_call_id ? { id: message.tool_call_id } : {}),
							name,
							response: toolResponse(message.content)
						}
					}
				]);
				break;
			}
			default:
				push(contents, 'user', userParts(message.content));
		}
	}

	// Gemini requires the conversation to start with a user turn.
	if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] });

	return system.length ? { contents, systemInstruction: { role: 'user', parts: [{ text: system.join('\n\n') }] } } : { contents };
}

function toolConfig(choice: OpenAIChatRequest['tool_choice']): GeminiGenerateRequest['toolConfig'] {
	if (!choice || choice === 'auto') return undefined;
	if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
	if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };

	return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] } };
}

export interface GeminiRequestOptions {
	reasoningBudget: ReasoningBudgetTier | null | undefined;
	extraInstruction?: string | null;
}

/** The inner `request` of the envelope; `model`, `project` and `user_prompt_id` are set per attempt. */
export function buildGeminiRequest(body: OpenAIChatRequest, options: GeminiRequestOptions): GeminiGenerateRequest {
	const { contents, systemInstruction } = openAiMessagesToGemini(body.messages);
	const extra = options.extraInstruction?.trim();
	const system = extra
		? { role: 'user' as const, parts: [...(systemInstruction?.parts ?? []), { text: extra }] }
		: systemInstruction;
	const declarations = (body.tools ?? [])
		.filter((tool) => tool.type === 'function' && tool.function?.name)
		.map((tool) => ({
			name: tool.function.name,
			...(tool.function.description ? { description: tool.function.description } : {}),
			// Full JSON Schema: `parameters` only accepts the OpenAPI subset and rejects Cursor's schemas.
			...(tool.function.parameters ? { parametersJsonSchema: tool.function.parameters } : {})
		}));
	const maxTokens = body.max_completion_tokens ?? body.max_tokens;
	const stop = typeof body.stop === 'string' ? [body.stop] : body.stop;
	const config = declarations.length ? toolConfig(body.tool_choice) : undefined;

	return {
		contents,
		...(system ? { systemInstruction: system } : {}),
		...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
		...(config ? { toolConfig: config } : {}),
		generationConfig: {
			...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
			...(typeof body.top_p === 'number' ? { topP: body.top_p } : {}),
			...(typeof maxTokens === 'number' && maxTokens > 0 ? { maxOutputTokens: maxTokens } : {}),
			...(stop?.length ? { stopSequences: stop } : {}),
			thinkingConfig: { includeThoughts: true, thinkingLevel: geminiThinkingLevel(options.reasoningBudget) }
		}
	};
}

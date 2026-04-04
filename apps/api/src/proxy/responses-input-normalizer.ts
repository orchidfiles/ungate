import {
	buildCodexInputFromOpenAIMessages,
	coerceOpenAIMessagesFromRequestBody,
	expandBodyInputToCodexItems,
	normalizeCodexInputAssistantTextBlocks
} from './codex-chat-input';

import type { OpenAIChatRequest, OpenAIMessage } from '../types/openai';

export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ResolvedChatGptModel {
	model: string;
	reasoningEffort?: CodexReasoningEffort;
}

export interface BuildResponsesBodyOptions {
	extraInstruction?: string;
	envInstructions?: string;
	instructionsFallback: string;
}

export interface BuildResponsesBodyResult {
	payload: Record<string, unknown>;
	debug: {
		chatMessages: number;
		inputField: number;
		codexItems: number;
		fromBodyInput: boolean;
	};
}

export function resolveChatGptModel(model: string): ResolvedChatGptModel {
	if (!model) {
		return { model: 'gpt-5.4' };
	}

	const effortLevels: CodexReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

	for (const effort of effortLevels) {
		if (model.endsWith(`-${effort}`)) {
			return {
				model: model.slice(0, -`-${effort}`.length),
				reasoningEffort: effort
			};
		}
	}

	if (model === 'gpt-5.4' || model === 'gpt-5.4-mini') {
		return { model };
	}

	if (model === 'gpt-5.3-codex') {
		return { model, reasoningEffort: 'medium' };
	}

	if (model === 'gpt-5.1-codex-mini') {
		return { model, reasoningEffort: 'medium' };
	}

	if (model.includes('codex')) {
		return { model };
	}

	if (model.startsWith('gpt-5.4')) {
		return { model: 'gpt-5.4' };
	}

	if (model.startsWith('gpt-5.3')) {
		return { model: 'gpt-5.3-codex', reasoningEffort: 'medium' };
	}

	if (model.startsWith('gpt-5.1')) {
		return { model: 'gpt-5.1-codex-mini', reasoningEffort: 'medium' };
	}

	return { model: 'gpt-5.4' };
}

function normalizeMessageRole(role: string | undefined): string {
	if (!role) {
		return '';
	}

	const r = role.trim().toLowerCase();

	if (r === 'human') {
		return 'user';
	}

	return r;
}

function flattenOpenAIUserContentToText(content: OpenAIMessage['content']): string | null {
	if (content === null || content === undefined) {
		return null;
	}

	if (typeof content === 'string') {
		const t = content.trim();

		if (t.length > 0) {
			return t;
		}

		return null;
	}

	if (Array.isArray(content)) {
		const parts: string[] = [];
		let sawImage = false;

		for (const block of content) {
			if (!block || typeof block !== 'object') {
				continue;
			}

			const b = block as unknown as Record<string, unknown>;
			const partType = typeof b.type === 'string' ? b.type : '';

			if (partType === 'image_url' || partType === 'input_image') {
				sawImage = true;

				continue;
			}

			if ((partType === 'text' || partType === 'input_text') && typeof b.text === 'string' && b.text.trim()) {
				parts.push(b.text.trim());

				continue;
			}

			if (typeof b.text === 'string' && b.text.trim()) {
				parts.push(b.text.trim());
			}
		}

		if (parts.length > 0) {
			return parts.join('\n');
		}

		if (sawImage) {
			return null;
		}

		if (content.length > 0) {
			return JSON.stringify(content);
		}

		return null;
	}

	const obj = content as unknown as Record<string, unknown>;

	if (typeof obj.text === 'string' && obj.text.trim()) {
		return obj.text.trim();
	}

	return null;
}

function codexPromptHasActionableUserContent(items: Record<string, unknown>[]): boolean {
	for (const item of items) {
		if (item.type === 'function_call' || item.type === 'function_call_output') {
			return true;
		}

		if (item.type !== 'message' || item.role !== 'user') {
			continue;
		}

		const parts = item.content as Record<string, unknown>[] | undefined;

		if (!Array.isArray(parts)) {
			continue;
		}

		for (const p of parts) {
			if (!p || typeof p !== 'object') {
				continue;
			}

			if (p.type === 'input_image') {
				return true;
			}

			if (p.type === 'input_text' && typeof p.text === 'string' && p.text.trim().length > 0) {
				return true;
			}
		}
	}

	return false;
}

function extractLastUserMessageText(messages: OpenAIMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];

		if (normalizeMessageRole(msg.role) !== 'user') {
			continue;
		}

		const text = flattenOpenAIUserContentToText(msg.content);

		if (text) {
			return text;
		}
	}

	return null;
}

function patchLastEmptyUserFromRaw(input: Record<string, unknown>[], messages: OpenAIMessage[]): Record<string, unknown>[] {
	const latestText = extractLastUserMessageText(messages);

	if (!latestText) {
		return input;
	}

	let lastUserIdx = -1;

	for (let i = input.length - 1; i >= 0; i--) {
		const it = input[i];

		if (it.type === 'message' && it.role === 'user') {
			lastUserIdx = i;

			break;
		}
	}

	if (lastUserIdx < 0) {
		return [
			...input,
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: latestText }]
			}
		];
	}

	const userItem = input[lastUserIdx];
	const parts = (userItem.content as Record<string, unknown>[] | undefined) ?? [];

	const hasUserPayload = parts.some((p) => {
		if (!p || typeof p !== 'object') {
			return false;
		}

		if (p.type === 'input_image') {
			return true;
		}

		if (p.type === 'input_text' && typeof p.text === 'string' && p.text.trim().length > 0) {
			return true;
		}

		return false;
	});

	if (hasUserPayload) {
		return input;
	}

	const out = [...input];

	out[lastUserIdx] = {
		...userItem,
		content: [{ type: 'input_text', text: latestText }]
	};

	return out;
}

function extractFallbackUserText(messages: OpenAIMessage[]): string {
	const chunks: string[] = [];

	for (const msg of messages) {
		const role = normalizeMessageRole(msg.role);

		if (role === 'system' || role === 'developer') {
			continue;
		}

		if (typeof msg.content === 'string' && msg.content.trim()) {
			chunks.push(msg.content.trim());

			continue;
		}

		if (Array.isArray(msg.content)) {
			const chunkCountBefore = chunks.length;

			for (const block of msg.content) {
				if (!block || typeof block !== 'object') {
					continue;
				}

				const b = block as unknown as Record<string, unknown>;
				const partType = typeof b.type === 'string' ? b.type : '';

				if ((partType === 'text' || partType === 'input_text') && typeof b.text === 'string' && b.text.trim()) {
					chunks.push(b.text.trim());

					continue;
				}

				if (typeof b.text === 'string' && b.text.trim()) {
					chunks.push(b.text.trim());
				}
			}

			if (chunks.length === chunkCountBefore && msg.content.length > 0) {
				chunks.push(JSON.stringify(msg.content));
			}
		}
	}

	if (chunks.length === 0) {
		return '.';
	}

	return chunks.join('\n\n');
}

function mapToolChoiceToCodex(
	toolChoice: OpenAIChatRequest['tool_choice'] | undefined,
	hasTools: boolean
): string | Record<string, unknown> | undefined {
	if (!hasTools) {
		return undefined;
	}

	if (toolChoice === undefined || toolChoice === null) {
		return 'auto';
	}

	if (typeof toolChoice === 'string') {
		return toolChoice;
	}

	const tc = toolChoice as {
		type?: string;
		function?: { name?: string };
		name?: string;
	};

	if (tc.type === 'function') {
		if (tc.function?.name) {
			return {
				type: 'function',
				name: tc.function.name
			};
		}

		if (tc.name) {
			return {
				type: 'function',
				name: tc.name
			};
		}
	}

	const passthrough: Record<string, unknown> = { ...tc };

	return passthrough;
}

function filterOrphanFunctionCallOutputs(input: Record<string, unknown>[]): Record<string, unknown>[] {
	const knownCallIds = new Set<string>();

	for (const item of input) {
		if (
			(item.type === 'function_call' || item.type === 'custom_tool_call') &&
			typeof item.call_id === 'string' &&
			item.call_id.length > 0
		) {
			knownCallIds.add(item.call_id);
		}
	}

	return input.filter((item) => {
		if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && typeof item.call_id === 'string') {
			return knownCallIds.has(item.call_id);
		}

		return true;
	});
}

export function buildChatGptResponsesBody(
	body: OpenAIChatRequest,
	requestedModel: string,
	options: BuildResponsesBodyOptions
): BuildResponsesBodyResult {
	const messages = coerceOpenAIMessagesFromRequestBody(body);
	const resolvedModel = resolveChatGptModel(requestedModel);
	const explicitReasoning = body.reasoning as { effort?: CodexReasoningEffort } | undefined;
	const reasoningEffort = explicitReasoning?.effort ?? body.reasoning_effort ?? resolvedModel.reasoningEffort;

	const expandedInput = expandBodyInputToCodexItems(body.input);

	let input: Record<string, unknown>[];

	if (expandedInput) {
		input = expandedInput;
	} else {
		input = buildCodexInputFromOpenAIMessages(messages);
	}

	const usedExpandedInput = expandedInput !== null;
	let finalInput = filterOrphanFunctionCallOutputs(input);

	if (!usedExpandedInput) {
		finalInput = patchLastEmptyUserFromRaw(finalInput, messages);
	}

	if (!codexPromptHasActionableUserContent(finalInput)) {
		const fallbackText = extractFallbackUserText(messages);

		if (finalInput.length === 0) {
			finalInput = [
				{
					type: 'message',
					role: 'user',
					content: [{ type: 'input_text', text: fallbackText }]
				}
			];
		} else {
			finalInput = [
				...finalInput,
				{
					type: 'message',
					role: 'user',
					content: [{ type: 'input_text', text: fallbackText }]
				}
			];
		}
	}

	if (finalInput.length === 0) {
		finalInput = [
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Hello.' }]
			}
		];
	}

	finalInput = normalizeCodexInputAssistantTextBlocks(finalInput);

	const rawTools = Array.isArray(body.tools) ? body.tools : [];
	const hasTools = rawTools.length > 0;

	const payload: Record<string, unknown> = {
		model: resolvedModel.model,
		input: finalInput,
		stream: true,
		store: false
	};

	if (options.extraInstruction?.trim()) {
		payload.instructions = options.extraInstruction.trim();
	} else if (options.envInstructions?.trim()) {
		payload.instructions = options.envInstructions.trim();
	} else {
		payload.instructions = options.instructionsFallback;
	}

	if (reasoningEffort) {
		payload.reasoning = { effort: reasoningEffort };
	}

	if (hasTools) {
		payload.tools = rawTools;
		payload.tool_choice = mapToolChoiceToCodex(body.tool_choice, true) ?? 'auto';
		payload.parallel_tool_calls = false;
	}

	const debug = {
		chatMessages: messages.length,
		inputField: Array.isArray(body.input) ? body.input.length : 0,
		codexItems: input.length,
		fromBodyInput: usedExpandedInput
	};

	return { payload, debug };
}

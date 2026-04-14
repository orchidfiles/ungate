import { CodexInputUtils } from 'src/proxy/codex-input-utils';

import { ResponsesInputShape } from './input-shape';
import { ResponsesInputText } from './input-text';
import { ResponsesModelResolver } from './resolve-model';

import type { BuildResponsesBodyOptions, BuildResponsesBodyResult, CodexReasoningEffort } from './types';
import type { OpenAIChatRequest } from 'src/types/openai';

export class ResponsesBodyBuilder {
	public static buildBody(
		body: OpenAIChatRequest,
		requestedModel: string,
		options: BuildResponsesBodyOptions
	): BuildResponsesBodyResult {
		const messages = CodexInputUtils.coerceMessages(body);
		const resolvedModel = ResponsesModelResolver.resolveModel(requestedModel);
		const explicitReasoning = body.reasoning as { effort?: CodexReasoningEffort } | undefined;
		const reasoningEffort = explicitReasoning?.effort ?? body.reasoning_effort ?? resolvedModel.reasoningEffort;
		const expandedInput = CodexInputUtils.expandInput(body.input);
		const usedExpandedInput = expandedInput !== null;

		let input: Record<string, unknown>[];

		if (expandedInput) {
			input = expandedInput;
		} else {
			input = CodexInputUtils.buildFromMessages(messages);
		}

		let finalInput = ResponsesInputShape.filterOrphans(input);

		if (!usedExpandedInput) {
			finalInput = ResponsesInputShape.patchLastUser(finalInput, messages);
		}

		if (!ResponsesInputText.hasActionableUserContent(finalInput)) {
			const fallbackText = ResponsesInputText.buildFallbackText(messages);

			if (finalInput.length === 0) {
				finalInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: fallbackText }] }];
			} else {
				finalInput = [...finalInput, { type: 'message', role: 'user', content: [{ type: 'input_text', text: fallbackText }] }];
			}
		}

		if (finalInput.length === 0) {
			finalInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello.' }] }];
		}

		finalInput = CodexInputUtils.normalizeAssistantText(finalInput);

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
			payload.tool_choice = this.mapChoice(body.tool_choice, true) ?? 'auto';
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

	private static mapChoice(
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

		const toolChoiceRecord = toolChoice as {
			type?: string;
			function?: { name?: string };
			name?: string;
		};

		if (toolChoiceRecord.type === 'function') {
			if (toolChoiceRecord.function?.name) {
				return { type: 'function', name: toolChoiceRecord.function.name };
			}

			if (toolChoiceRecord.name) {
				return { type: 'function', name: toolChoiceRecord.name };
			}
		}

		return { ...toolChoiceRecord };
	}
}

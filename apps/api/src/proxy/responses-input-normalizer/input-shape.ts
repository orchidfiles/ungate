import { ResponsesInputText } from './input-text';

import type { OpenAIMessage } from 'src/types/openai';

export class ResponsesInputShape {
	public static filterOrphans(input: Record<string, unknown>[]): Record<string, unknown>[] {
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

	public static patchLastUser(input: Record<string, unknown>[], messages: OpenAIMessage[]): Record<string, unknown>[] {
		const latestText = ResponsesInputText.lastUserText(messages);

		if (!latestText) {
			return input;
		}

		let lastUserIndex = -1;

		for (let index = input.length - 1; index >= 0; index--) {
			const item = input[index];

			if (item.type === 'message' && item.role === 'user') {
				lastUserIndex = index;
				break;
			}
		}

		if (lastUserIndex < 0) {
			return [...input, { type: 'message', role: 'user', content: [{ type: 'input_text', text: latestText }] }];
		}

		const userItem = input[lastUserIndex];
		const parts = (userItem.content as Record<string, unknown>[] | undefined) ?? [];
		const hasUserPayload = parts.some((part) => {
			if (!part || typeof part !== 'object') {
				return false;
			}

			if (part.type === 'input_image') {
				return true;
			}

			if (part.type === 'input_text' && typeof part.text === 'string' && part.text.trim().length > 0) {
				return true;
			}

			return false;
		});

		if (hasUserPayload) {
			return input;
		}

		const output = [...input];
		output[lastUserIndex] = {
			...userItem,
			content: [{ type: 'input_text', text: latestText }]
		};

		return output;
	}
}

import type { OpenAIContentPart, OpenAIMessage, OpenAIToolCall } from 'src/types/openai';

export class CodexInputUtils {
	public static buildFromMessages(messages: OpenAIMessage[]): Record<string, unknown>[] {
		const developerItems: Record<string, unknown>[] = [];
		const mainItems: Record<string, unknown>[] = [];

		for (const message of messages) {
			const convertedItems = this.convertMessage(message);

			for (const item of convertedItems) {
				if (item.type === 'message' && item.role === 'developer') {
					developerItems.push(item);
				} else {
					mainItems.push(item);
				}
			}
		}

		return [...developerItems, ...mainItems];
	}

	public static normalizeAssistantText(input: Record<string, unknown>[]): Record<string, unknown>[] {
		return input.map((item) => {
			if (item.type !== 'message' || item.role !== 'assistant') {
				return item;
			}

			const content = item.content;

			if (!Array.isArray(content)) {
				return item;
			}

			const normalizedContent = content.map((part) => {
				if (!part || typeof part !== 'object') {
					return part;
				}

				const contentPart = part as Record<string, unknown>;
				const contentType = contentPart.type;

				if (contentType === 'input_text' || contentType === 'text') {
					return { ...contentPart, type: 'output_text' };
				}

				return part;
			});

			return { ...item, content: normalizedContent };
		});
	}

	public static expandInput(input: unknown): Record<string, unknown>[] | null {
		if (!Array.isArray(input) || input.length === 0) {
			return null;
		}

		const developerItems: Record<string, unknown>[] = [];
		const mainItems: Record<string, unknown>[] = [];
		const pushItems = (convertedItems: Record<string, unknown>[]) => {
			for (const item of convertedItems) {
				if (item.type === 'message' && item.role === 'developer') {
					developerItems.push(item);
				} else {
					mainItems.push(item);
				}
			}
		};

		for (const item of input) {
			if (!item || typeof item !== 'object') {
				return null;
			}

			const itemRecord = item as Record<string, unknown>;
			const itemType = itemRecord.type;

			if (
				itemType === 'function_call' ||
				itemType === 'function_call_output' ||
				itemType === 'custom_tool_call' ||
				itemType === 'custom_tool_call_output'
			) {
				mainItems.push({ ...itemRecord });
				continue;
			}

			if (itemType === 'message') {
				pushItems([{ ...itemRecord }]);
				continue;
			}

			if (typeof itemRecord.role === 'string' && (itemType === undefined || itemType === null)) {
				const convertedItems = this.convertMessage(item as OpenAIMessage);
				pushItems(convertedItems);
				continue;
			}

			return null;
		}

		return [...developerItems, ...mainItems];
	}

	public static coerceMessages(body: { messages?: OpenAIMessage[]; input?: unknown }): OpenAIMessage[] {
		const bodyMessages = body.messages;

		if (Array.isArray(bodyMessages) && bodyMessages.length > 0) {
			return bodyMessages;
		}

		const rawInput = body.input;

		if (!Array.isArray(rawInput) || rawInput.length === 0) {
			return [];
		}

		const allItemsAreChatShape = rawInput.every((item) => {
			if (!item || typeof item !== 'object') {
				return false;
			}

			const inputRecord = item as Record<string, unknown>;

			if (typeof inputRecord.role !== 'string') {
				return false;
			}

			return inputRecord.type === undefined || inputRecord.type === null;
		});

		if (!allItemsAreChatShape) {
			return [];
		}

		return rawInput as OpenAIMessage[];
	}

	private static normalizeRole(role: string | undefined): string {
		if (!role) {
			return '';
		}

		const normalizedRole = role.trim().toLowerCase();

		if (normalizedRole === 'human') {
			return 'user';
		}

		return normalizedRole;
	}

	private static convertMessage(message: OpenAIMessage): Record<string, unknown>[] {
		const items: Record<string, unknown>[] = [];
		const normalizedRole = this.normalizeRole(message.role);

		if (normalizedRole === 'system' || normalizedRole === 'developer') {
			const contentParts = this.convertContent(message.content, 'user');

			if (contentParts.length > 0) {
				items.push({
					type: 'message',
					role: 'developer',
					content: contentParts
				});
			}

			return items;
		}

		if (normalizedRole === 'user') {
			const contentParts = this.convertContent(message.content, 'user');

			if (contentParts.length > 0) {
				items.push({
					type: 'message',
					role: 'user',
					content: contentParts
				});
			}

			return items;
		}

		if (normalizedRole === 'assistant') {
			const contentParts = this.convertContent(message.content, 'assistant');

			if (contentParts.length > 0) {
				items.push({
					type: 'message',
					role: 'assistant',
					content: contentParts
				});
			}

			if (message.tool_calls && message.tool_calls.length > 0) {
				const functionCalls = this.convertCalls(message.tool_calls);
				items.push(...functionCalls);
			}

			return items;
		}

		if (normalizedRole === 'tool') {
			const callId = message.tool_call_id;
			const output = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');

			if (callId) {
				items.push({
					type: 'function_call_output',
					call_id: callId,
					output
				});
			}

			return items;
		}

		if (normalizedRole === 'function') {
			const callReference = message.name ?? `func_${Date.now()}`;
			const output = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');

			items.push({
				type: 'function_call_output',
				call_id: callReference,
				output
			});

			return items;
		}

		const fallbackContent = this.convertContent(message.content, 'user');

		if (fallbackContent.length > 0) {
			items.push({
				type: 'message',
				role: 'user',
				content: fallbackContent
			});
		}

		return items;
	}

	private static convertContent(content: OpenAIMessage['content'], role: 'user' | 'assistant'): Record<string, unknown>[] {
		if (content === null || content === undefined) {
			return [];
		}

		if (typeof content === 'string') {
			if (!content.trim()) {
				return [];
			}

			return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
		}

		if (Array.isArray(content)) {
			const parts: Record<string, unknown>[] = [];

			for (const item of content) {
				const convertedPart = this.convertPart(item, role);

				if (convertedPart) {
					parts.push(convertedPart);
				}
			}

			return parts;
		}

		return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: JSON.stringify(content) }];
	}

	private static convertPart(
		part: OpenAIContentPart | string | Record<string, unknown>,
		role: 'user' | 'assistant'
	): Record<string, unknown> | null {
		if (typeof part === 'string') {
			return {
				type: role === 'assistant' ? 'output_text' : 'input_text',
				text: part
			};
		}

		if (!part || typeof part !== 'object') {
			return null;
		}

		const partRecord = part as Record<string, unknown>;
		const partType = typeof partRecord.type === 'string' ? partRecord.type : '';

		if (partType === 'text') {
			return {
				type: role === 'assistant' ? 'output_text' : 'input_text',
				text: this.toText(partRecord.text)
			};
		}

		if (partType === 'output_text' || partType === 'input_text') {
			const text = this.toText(partRecord.text);

			return { type: role === 'assistant' ? 'output_text' : 'input_text', text };
		}

		if (partType === 'image_url') {
			const rawImage = partRecord.image_url;
			const imageUrl = typeof rawImage === 'string' ? rawImage : (rawImage as { url?: string } | undefined)?.url;

			if (imageUrl) {
				const block: Record<string, unknown> = { type: 'input_image', image_url: imageUrl };

				if (typeof rawImage === 'object' && rawImage !== null && 'detail' in rawImage) {
					const detail = (rawImage as { detail?: string }).detail;

					if (detail !== undefined) {
						block.detail = detail;
					}
				}

				return block;
			}

			return null;
		}

		if (partType === 'input_audio' && partRecord.input_audio && typeof partRecord.input_audio === 'object') {
			const audio = partRecord.input_audio as { format?: string };

			return {
				type: role === 'assistant' ? 'output_text' : 'input_text',
				text: `[Audio input: format=${audio.format ?? 'unknown'}]`
			};
		}

		if (partType === 'file' && partRecord.file && typeof partRecord.file === 'object') {
			const file = partRecord.file as { file_id?: string; filename?: string };
			const fileBlock: Record<string, unknown> = { type: 'input_file' };

			if (file.file_id !== undefined) {
				fileBlock.file_id = file.file_id;
			}

			if (file.filename !== undefined) {
				fileBlock.filename = file.filename;
			}

			return fileBlock;
		}

		return {
			type: role === 'assistant' ? 'output_text' : 'input_text',
			text: `[Unknown content type: ${JSON.stringify(part)}]`
		};
	}

	private static convertCalls(toolCalls: OpenAIToolCall[]): Record<string, unknown>[] {
		const outputItems: Record<string, unknown>[] = [];

		for (const toolCall of toolCalls) {
			const callArguments = toolCall.function?.arguments ?? '{}';
			const callName = toolCall.function?.name ?? 'unknown';
			const callId = toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

			outputItems.push({
				type: 'function_call',
				name: callName,
				arguments: typeof callArguments === 'string' ? callArguments : JSON.stringify(callArguments),
				call_id: callId
			});
		}

		return outputItems;
	}

	private static toText(value: unknown): string {
		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}

		return '';
	}
}

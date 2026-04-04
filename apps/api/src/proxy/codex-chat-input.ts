import type { OpenAIMessage, OpenAIContentPart, OpenAIToolCall } from '../types/openai';

function textFromContentPartField(v: unknown): string {
	if (typeof v === 'string') {
		return v;
	}

	if (typeof v === 'number' || typeof v === 'boolean') {
		return String(v);
	}

	return '';
}

function convertContentPart(
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

	const p = part as Record<string, unknown>;
	const partType = typeof p.type === 'string' ? p.type : '';

	if (partType === 'text') {
		return {
			type: role === 'assistant' ? 'output_text' : 'input_text',
			text: textFromContentPartField(p.text)
		};
	}

	/** History from Cursor / Responses often uses native part types, not Chat `text`. */
	if (partType === 'output_text' || partType === 'input_text') {
		const text = textFromContentPartField(p.text);

		return {
			type: role === 'assistant' ? 'output_text' : 'input_text',
			text
		};
	}

	if (partType === 'image_url') {
		const raw = p.image_url;
		const url = typeof raw === 'string' ? raw : (raw as { url?: string } | undefined)?.url;

		if (url) {
			const block: Record<string, unknown> = { type: 'input_image', image_url: url };

			if (typeof raw === 'object' && raw !== null && 'detail' in raw) {
				const detail = (raw as { detail?: string }).detail;

				if (detail !== undefined) {
					block.detail = detail;
				}
			}

			return block;
		}

		return null;
	}

	if (partType === 'input_audio' && p.input_audio && typeof p.input_audio === 'object') {
		const audio = p.input_audio as { format?: string };

		return {
			type: role === 'assistant' ? 'output_text' : 'input_text',
			text: `[Audio input: format=${audio?.format ?? 'unknown'}]`
		};
	}

	if (partType === 'file' && p.file && typeof p.file === 'object') {
		const file = p.file as { file_id?: string; filename?: string };
		const block: Record<string, unknown> = { type: 'input_file' };

		if (file.file_id !== undefined) {
			block.file_id = file.file_id;
		}

		if (file.filename !== undefined) {
			block.filename = file.filename;
		}

		return block;
	}

	return {
		type: role === 'assistant' ? 'output_text' : 'input_text',
		text: `[Unknown content type: ${JSON.stringify(part)}]`
	};
}

function convertMessageContent(content: OpenAIMessage['content'], role: 'user' | 'assistant'): Record<string, unknown>[] {
	if (content === null || content === undefined) {
		return [];
	}

	if (typeof content === 'string') {
		if (!content.trim()) {
			return [];
		}

		return [
			{
				type: role === 'assistant' ? 'output_text' : 'input_text',
				text: content
			}
		];
	}

	if (Array.isArray(content)) {
		const parts: Record<string, unknown>[] = [];

		for (const item of content) {
			const converted = convertContentPart(item, role);

			if (converted) {
				parts.push(converted);
			}
		}

		return parts;
	}

	return [
		{
			type: role === 'assistant' ? 'output_text' : 'input_text',
			text: JSON.stringify(content)
		}
	];
}

function convertToolCallsToFunctionCalls(toolCalls: OpenAIToolCall[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];

	for (const toolCall of toolCalls) {
		const args = toolCall.function?.arguments ?? '{}';
		const name = toolCall.function?.name ?? 'unknown';

		out.push({
			type: 'function_call',
			name,
			arguments: typeof args === 'string' ? args : JSON.stringify(args),
			call_id: toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
		});
	}

	return out;
}

function normalizeRoleForCodex(role: string | undefined): string {
	if (!role) {
		return '';
	}

	const r = role.trim().toLowerCase();

	if (r === 'human') {
		return 'user';
	}

	return r;
}

function convertSingleMessage(msg: OpenAIMessage): Record<string, unknown>[] {
	const items: Record<string, unknown>[] = [];
	const role = normalizeRoleForCodex(msg.role);

	if (role === 'system') {
		const contentParts = convertMessageContent(msg.content, 'user');

		if (contentParts.length > 0) {
			items.push({
				type: 'message',
				role: 'developer',
				content: contentParts
			});
		}

		return items;
	}

	if (role === 'developer') {
		const contentParts = convertMessageContent(msg.content, 'user');

		if (contentParts.length > 0) {
			items.push({
				type: 'message',
				role: 'developer',
				content: contentParts
			});
		}

		return items;
	}

	if (role === 'user') {
		const contentParts = convertMessageContent(msg.content, 'user');

		if (contentParts.length > 0) {
			items.push({
				type: 'message',
				role: 'user',
				content: contentParts
			});
		}

		return items;
	}

	if (role === 'assistant') {
		const contentParts = convertMessageContent(msg.content, 'assistant');

		if (contentParts.length > 0) {
			items.push({
				type: 'message',
				role: 'assistant',
				content: contentParts
			});
		}

		if (msg.tool_calls && msg.tool_calls.length > 0) {
			items.push(...convertToolCallsToFunctionCalls(msg.tool_calls));
		}

		return items;
	}

	if (role === 'tool') {
		const callId = msg.tool_call_id;
		const output = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');

		if (callId) {
			items.push({
				type: 'function_call_output',
				call_id: callId,
				output
			});
		}

		return items;
	}

	if (role === 'function') {
		const callRef = msg.name ?? `func_${Date.now()}`;
		const output = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');

		items.push({
			type: 'function_call_output',
			call_id: callRef,
			output
		});

		return items;
	}

	const fallbackContent = convertMessageContent(msg.content, 'user');

	if (fallbackContent.length > 0) {
		items.push({
			type: 'message',
			role: 'user',
			content: fallbackContent
		});
	}

	return items;
}

export function buildCodexInputFromOpenAIMessages(messages: OpenAIMessage[]): Record<string, unknown>[] {
	const developerItems: Record<string, unknown>[] = [];
	const mainItems: Record<string, unknown>[] = [];

	for (const msg of messages) {
		const converted = convertSingleMessage(msg);

		for (const item of converted) {
			if (item.type === 'message' && item.role === 'developer') {
				developerItems.push(item);

				continue;
			}

			mainItems.push(item);
		}
	}

	return [...developerItems, ...mainItems];
}

/**
 * Codex Responses input: assistant message content may only use output_text / refusal,
 * not input_text (OpenAI chat-style parts often use input_text or text).
 */
export function normalizeCodexInputAssistantTextBlocks(input: Record<string, unknown>[]): Record<string, unknown>[] {
	return input.map((item) => {
		if (item.type !== 'message' || item.role !== 'assistant') {
			return item;
		}

		const content = item.content;

		if (!Array.isArray(content)) {
			return item;
		}

		const newContent = content.map((part) => {
			if (!part || typeof part !== 'object') {
				return part;
			}

			const p = part as Record<string, unknown>;
			const t = p.type;

			if (t === 'input_text' || t === 'text') {
				return { ...p, type: 'output_text' };
			}

			return part;
		});

		return { ...item, content: newContent };
	});
}

/**
 * Build Codex `input` from `body.input` when it mixes Responses items (`type: message` | …)
 * and plain chat objects (`role` + `content` without `type`). A single array of only one style
 * still works; previously a mix caused both parsers to return empty and history was dropped.
 */
export function expandBodyInputToCodexItems(input: unknown): Record<string, unknown>[] | null {
	if (!Array.isArray(input) || input.length === 0) {
		return null;
	}

	const developerItems: Record<string, unknown>[] = [];
	const mainItems: Record<string, unknown>[] = [];

	const pushItems = (converted: Record<string, unknown>[]) => {
		for (const item of converted) {
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

		const o = item as Record<string, unknown>;
		const t = o.type;

		if (t === 'function_call' || t === 'function_call_output' || t === 'custom_tool_call' || t === 'custom_tool_call_output') {
			mainItems.push({ ...o });

			continue;
		}

		if (t === 'message') {
			pushItems([{ ...o }]);

			continue;
		}

		if (typeof o.role === 'string' && (t === undefined || t === null)) {
			pushItems(convertSingleMessage(item as OpenAIMessage));

			continue;
		}

		return null;
	}

	return [...developerItems, ...mainItems];
}

export function coerceOpenAIMessagesFromRequestBody(body: { messages?: OpenAIMessage[]; input?: unknown }): OpenAIMessage[] {
	const msgs = body.messages;

	if (Array.isArray(msgs) && msgs.length > 0) {
		return msgs;
	}

	const raw = body.input;

	if (!Array.isArray(raw) || raw.length === 0) {
		return [];
	}

	const allChatShape = raw.every((item) => {
		if (!item || typeof item !== 'object') {
			return false;
		}

		const o = item as Record<string, unknown>;

		if (typeof o.role !== 'string') {
			return false;
		}

		return o.type === undefined || o.type === null;
	});

	if (!allChatShape) {
		return [];
	}

	return raw as OpenAIMessage[];
}

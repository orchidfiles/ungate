import type { OpenAIMessage } from 'src/types/openai';

export class ResponsesInputText {
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

	private static flattenUserText(content: OpenAIMessage['content']): string | null {
		if (content === null || content === undefined) {
			return null;
		}

		if (typeof content === 'string') {
			const trimmedContent = content.trim();

			if (trimmedContent.length > 0) {
				return trimmedContent;
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

				const part = block as Record<string, unknown>;
				const partType = typeof part.type === 'string' ? part.type : '';

				if (partType === 'image_url' || partType === 'input_image') {
					sawImage = true;
					continue;
				}

				if ((partType === 'text' || partType === 'input_text') && typeof part.text === 'string' && part.text.trim()) {
					parts.push(part.text.trim());
					continue;
				}

				if (typeof part.text === 'string' && part.text.trim()) {
					parts.push(part.text.trim());
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

		const contentRecord = content as Record<string, unknown>;

		if (typeof contentRecord.text === 'string' && contentRecord.text.trim()) {
			return contentRecord.text.trim();
		}

		return null;
	}

	public static hasActionableUserContent(items: Record<string, unknown>[]): boolean {
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

			for (const part of parts) {
				if (!part || typeof part !== 'object') {
					continue;
				}

				if (part.type === 'input_image') {
					return true;
				}

				if (part.type === 'input_text' && typeof part.text === 'string' && part.text.trim().length > 0) {
					return true;
				}
			}
		}

		return false;
	}

	public static buildFallbackText(messages: OpenAIMessage[]): string {
		const chunks: string[] = [];

		for (const message of messages) {
			const role = this.normalizeRole(message.role);

			if (role === 'system' || role === 'developer') {
				continue;
			}

			if (typeof message.content === 'string' && message.content.trim()) {
				chunks.push(message.content.trim());
				continue;
			}

			if (Array.isArray(message.content)) {
				const chunksCountBefore = chunks.length;

				for (const block of message.content) {
					if (!block || typeof block !== 'object') {
						continue;
					}

					const part = block as Record<string, unknown>;
					const partType = typeof part.type === 'string' ? part.type : '';

					if ((partType === 'text' || partType === 'input_text') && typeof part.text === 'string' && part.text.trim()) {
						chunks.push(part.text.trim());
						continue;
					}

					if (typeof part.text === 'string' && part.text.trim()) {
						chunks.push(part.text.trim());
					}
				}

				if (chunks.length === chunksCountBefore && message.content.length > 0) {
					chunks.push(JSON.stringify(message.content));
				}
			}
		}

		if (chunks.length === 0) {
			return '.';
		}

		return chunks.join('\n\n');
	}

	public static lastUserText(messages: OpenAIMessage[]): string | null {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];

			if (this.normalizeRole(message.role) !== 'user') {
				continue;
			}

			const text = this.flattenUserText(message.content);

			if (text) {
				return text;
			}
		}

		return null;
	}
}

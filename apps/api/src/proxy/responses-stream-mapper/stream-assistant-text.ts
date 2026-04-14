export class AssistantTextExtractor {
	static fromDelta(payload: Record<string, unknown>): string | null {
		const d = payload.delta;

		if (typeof d === 'string' && d.length > 0) {
			return d;
		}

		if (d && typeof d === 'object') {
			const text = (d as Record<string, unknown>).text;

			if (typeof text === 'string' && text.length > 0) {
				return text;
			}
		}

		return null;
	}

	static fromResponseOutput(resp: Record<string, unknown> | undefined): string | null {
		if (!resp) {
			return null;
		}

		const output = resp.output;

		if (!Array.isArray(output)) {
			return null;
		}

		const parts: string[] = [];

		for (const item of output) {
			if (!item || typeof item !== 'object') {
				continue;
			}

			const rec = item as Record<string, unknown>;

			if (rec.type !== 'message' || rec.role !== 'assistant') {
				continue;
			}

			const content = rec.content;

			if (!Array.isArray(content)) {
				continue;
			}

			for (const block of content) {
				if (!block || typeof block !== 'object') {
					continue;
				}

				const b = block as Record<string, unknown>;

				if (b.type === 'output_text' && typeof b.text === 'string') {
					parts.push(b.text);
				}
			}
		}

		const joined = parts.join('');

		if (joined.length === 0) {
			return null;
		}

		return joined;
	}

	static fromOutputItem(item: Record<string, unknown>): string | null {
		if (item.type !== 'message' || item.role !== 'assistant') {
			return null;
		}

		const blocks = Array.isArray(item.content) ? item.content : [];
		const textParts: string[] = [];

		for (const b of blocks) {
			if (!b || typeof b !== 'object') {
				continue;
			}

			const block = b as Record<string, unknown>;

			if (block.type === 'output_text' && typeof block.text === 'string') {
				textParts.push(block.text);
			}
		}

		const text = textParts.join('');

		if (text.length > 0) {
			return text;
		}

		return null;
	}
}

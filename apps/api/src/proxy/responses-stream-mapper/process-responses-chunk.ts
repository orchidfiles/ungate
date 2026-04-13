import { ResponsesEventRouter } from './responses-event-router';

import type { StreamProcessResult, StreamState } from './stream-state';

export class ResponsesSseProcessor {
	static parsePart(part: string): Record<string, unknown>[] {
		const payloads: Record<string, unknown>[] = [];

		for (const line of part.split('\n')) {
			if (!line.startsWith('data:')) {
				continue;
			}

			const data = line.slice(5).trim();

			if (!data || data === '[DONE]') {
				continue;
			}

			try {
				payloads.push(JSON.parse(data) as Record<string, unknown>);
			} catch {
				// malformed JSON line — skip
			}
		}

		return payloads;
	}

	static process(state: StreamState, chunk: string): StreamProcessResult[] {
		state.buffer += chunk;
		const results: StreamProcessResult[] = [];
		const parts = state.buffer.split('\n\n');
		const tail = parts.pop();
		state.buffer = '';

		if (tail != null) {
			state.buffer = tail;
		}

		for (const part of parts) {
			const payloads = this.parsePart(part);

			for (const payload of payloads) {
				ResponsesEventRouter.route(state, payload, results);
			}
		}

		return results;
	}
}

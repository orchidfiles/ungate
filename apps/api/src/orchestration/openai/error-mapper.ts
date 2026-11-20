import { openaiChatErrorMessages } from './error-messages';

interface MiniMaxErrorContext {
	bodyJson?: unknown;
}

/** Upstream retry hints that are safe to forward on a chat-completions error (never length/encoding). */
const SAFE_RETRY_HEADERS = ['retry-after', 'retry-after-ms', 'x-should-retry'];

export class CompletionErrorMapper {
	static applySafeRetryHeaders(reply: { header(name: string, value: string): unknown }, response: Response): void {
		for (const name of SAFE_RETRY_HEADERS) {
			const value = response.headers.get(name);
			if (value !== null && /^[\w .,:+-]{1,64}$/.test(value)) reply.header(name, value);
		}
	}

	/** OpenAI-style error payload: message plus upstream type/code when the proxy client preserved them. */
	static async openAiUpstreamErrorPayload(response: Response): Promise<{ message: string; type: string; code?: string }> {
		const parsed: unknown = await response.json().catch(() => undefined);
		const errBody = parsed as { error?: { message?: unknown; type?: unknown; code?: unknown } } | undefined;
		const error = errBody?.error;
		const message =
			typeof error?.message === 'string' && error.message
				? error.message
				: errBody
					? openaiChatErrorMessages.unknownUpstream
					: `HTTP ${response.status}`;
		const type = typeof error?.type === 'string' && error.type ? error.type : 'api_error';

		return typeof error?.code === 'string' && error.code ? { message, type, code: error.code } : { message, type };
	}

	static miniMaxErrorMessage(response: Response, context: MiniMaxErrorContext): string {
		if (context.bodyJson && typeof context.bodyJson === 'object') {
			const err = (context.bodyJson as { error?: { message?: string } }).error;

			if (err?.message) {
				return err.message;
			}

			return openaiChatErrorMessages.unknownUpstream;
		}

		return `HTTP ${response.status}`;
	}

	static async openAiUpstreamErrorMessage(response: Response): Promise<string> {
		const errBody = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
		const err = errBody as { error?: { message?: string } };
		const message = err?.error?.message;

		if (message) {
			return message;
		}

		return openaiChatErrorMessages.unknownUpstream;
	}

	static claudeApiErrorPayload(errorJson: unknown): { message: string; type?: string } {
		const error = errorJson as { error?: { message?: string; type?: string } };
		let errorMessage = error?.error?.message ?? openaiChatErrorMessages.unknownUpstream;

		if (errorMessage.includes('model:')) {
			errorMessage = errorMessage.replace(/model:\s*x-([^\s,]+)/g, (_match, modelName) => `model: ${modelName}`);
		}

		const payload: { message: string; type?: string } = {
			message: errorMessage
		};

		const errType = error?.error?.type;

		if (errType) {
			payload.type = errType;
		}

		return payload;
	}
}

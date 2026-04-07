import { openaiChatErrorMessages } from './error-messages';

interface MiniMaxErrorContext {
	bodyJson?: unknown;
}

export class CompletionErrorMapper {
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

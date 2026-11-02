/**
 * `chunk` → forward as `data: <json>`; `done` → successful terminal `[DONE]`;
 * `error` → upstream failure (`response.failed` / `error`): `data` is an OpenAI-style
 * `{ error: { message, type, code } }` payload, `upstreamError` the raw (token-free) error object.
 */
export interface StreamProcessResult {
	type: 'chunk' | 'done' | 'error';
	data?: Record<string, unknown>;
	upstreamError?: Record<string, unknown>;
}

/** Terminal outcome of a Codex `/responses` stream; null until a terminal event arrives. */
export type StreamTerminal = 'completed' | 'incomplete' | 'failed';

export interface PendingFunctionCallState {
	callId: string;
	openAiIndex: number;
	argsBuffer: string;
	deferred: boolean;
}

export interface StreamState {
	buffer: string;
	id: string;
	model: string;
	created: number;
	roleSent: boolean;
	sawTextDelta: boolean;
	toolCallsSeen: boolean;
	toolCallIndex: number;
	processedItemIds: Set<string>;
	pendingFunctionCalls: Map<number, PendingFunctionCallState>;
	sseKindCounts: Map<string, number>;
	outputItemTypeAdded: Map<string, number>;
	outputItemTypeDone: Map<string, number>;
	terminal: StreamTerminal | null;
	/** Usage from the terminal event, mapped to OpenAI field names. */
	usage?: Record<string, number>;
	/** Set when `terminal === 'failed'`. */
	failure?: { message: string; type: string; code?: string; upstream?: Record<string, unknown> };
}

export class StreamStateFactory {
	static create(model: string): StreamState {
		const state: StreamState = {
			buffer: '',
			id: `chatcmpl-${Date.now().toString(36)}`,
			model,
			created: Math.floor(Date.now() / 1000),
			roleSent: false,
			sawTextDelta: false,
			toolCallsSeen: false,
			toolCallIndex: 0,
			processedItemIds: new Set(),
			pendingFunctionCalls: new Map(),
			sseKindCounts: new Map(),
			outputItemTypeAdded: new Map(),
			outputItemTypeDone: new Map(),
			terminal: null
		};

		return state;
	}
}

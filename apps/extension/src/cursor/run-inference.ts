import { randomUUID } from 'node:crypto';

import { CONNECT_FLAG_END_STREAM, openBidiStream, type Http2Connect } from './connect-transport';

import type { CursorRequestCredentials } from './cursor-session';
import type {
	CursorBridgeError,
	CursorBridgeErrorKind,
	CursorBridgeEventBody,
	CursorInferenceRequest,
	CursorUsage
} from '@ungate/shared';

export const RUN_INFERENCE_PATH = '/aiserver.v1.InferenceService/RunInference';

/** gRPC / Connect numeric codes used by `RunInferenceInvocationError.code`. */
const GRPC_CODE_KIND: Record<number, CursorBridgeErrorKind> = {
	1: 'cancelled',
	4: 'timeout',
	5: 'bad_model',
	7: 'permission',
	8: 'rate_limit',
	14: 'overloaded',
	16: 'auth'
};

const CONNECT_CODE_KIND: Record<string, CursorBridgeErrorKind> = {
	canceled: 'cancelled',
	deadline_exceeded: 'timeout',
	not_found: 'bad_model',
	permission_denied: 'permission',
	resource_exhausted: 'rate_limit',
	unavailable: 'overloaded',
	unauthenticated: 'auth'
};

const STREAM_ERROR_TYPE_KIND: Record<string, CursorBridgeErrorKind> = {
	INFERENCE_STREAM_ERROR_TYPE_INPUT_TOKEN_LIMIT: 'input_too_long',
	INFERENCE_STREAM_ERROR_TYPE_OUTPUT_TOKEN_LIMIT: 'upstream',
	INFERENCE_STREAM_ERROR_TYPE_RATE_LIMIT: 'rate_limit',
	INFERENCE_STREAM_ERROR_TYPE_AUTHENTICATION: 'auth',
	INFERENCE_STREAM_ERROR_TYPE_PERMISSION: 'permission',
	INFERENCE_STREAM_ERROR_TYPE_OVERLOADED: 'overloaded',
	INFERENCE_STREAM_ERROR_TYPE_CONTENT_FILTER: 'content_filter'
};

const MAX_ERROR_MESSAGE = 500;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);

	return 0;
}

/** Strips anything that looks like a credential before an upstream message leaves the host. */
export function redactMessage(text: string): string {
	return text
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
		.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]')
		.replace(/[^\x20-\x7e]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_ERROR_MESSAGE);
}

function decodeDetails(details: unknown): string {
	if (!Array.isArray(details)) return '';

	return details
		.map((detail) => {
			const record = asRecord(detail);
			const value = str(record?.value);

			try {
				return Buffer.from(value, 'base64').toString('latin1');
			} catch {
				return '';
			}
		})
		.join(' ');
}

/** Maps `invocationEnd.error` (numeric code + opaque protobuf details) to a bridge error. */
export function classifyInvocationError(raw: unknown): CursorBridgeError {
	const record = asRecord(raw) ?? {};
	const code = num(record.code);
	const message = str(record.message);
	const details = decodeDetails(record.details);
	const haystack = `${message} ${details}`;

	let kind: CursorBridgeErrorKind = GRPC_CODE_KIND[code] ?? 'upstream';

	if (/ERROR_NOT_LOGGED_IN|not logged in|unauthenticated/i.test(haystack)) kind = 'auth';
	else if (/ERROR_BAD_MODEL_NAME|model.*not (found|available|supported)/i.test(haystack)) kind = 'bad_model';
	else if (/\b422\b|schema|invalid tool|tool.*parameters/i.test(haystack)) kind = 'tool_schema';
	else if (/rate.?limit|resource.?exhausted|usage limit|too many requests/i.test(haystack)) kind = 'rate_limit';

	return { kind, code, message: redactMessage(message || details || 'Cursor inference failed') };
}

/** Maps a Connect end-of-stream error (`{"error":{"code":"unauthenticated",...}}`). */
export function classifyEndStreamError(raw: unknown): CursorBridgeError | null {
	const error = asRecord(asRecord(raw)?.error);
	if (!error) return null;
	const code = str(error.code);
	const message = str(error.message);
	let kind: CursorBridgeErrorKind = CONNECT_CODE_KIND[code] ?? 'upstream';

	if (/ERROR_NOT_LOGGED_IN/i.test(message)) kind = 'auth';
	if (/ERROR_BAD_MODEL_NAME/i.test(message)) kind = 'bad_model';

	return { kind, code, message: redactMessage(message || code || 'Cursor stream ended with an error') };
}

function classifyHttpStatus(status: number): CursorBridgeError | null {
	if (status === 200 || status === 0) return null;
	let kind: CursorBridgeErrorKind = 'upstream';
	if (status === 401) kind = 'auth';
	else if (status === 403) kind = 'permission';
	else if (status === 404) kind = 'bad_model';
	else if (status === 429) kind = 'rate_limit';
	else if (status === 503) kind = 'overloaded';

	return { kind, code: status, message: `Cursor responded with HTTP ${status}` };
}

export function usageFromExtended(raw: unknown): CursorUsage {
	const record = asRecord(raw) ?? {};
	const reasoning = record.reasoningTokens;

	return {
		inputTokens: num(record.inputTokens),
		outputTokens: num(record.outputTokens),
		cacheReadTokens: num(record.cacheReadTokens),
		cacheWriteTokens: num(record.cacheWriteTokens),
		reasoningTokens: reasoning === undefined ? null : num(reasoning)
	};
}

function usageFromBasic(raw: unknown): CursorUsage {
	const record = asRecord(raw) ?? {};

	return {
		inputTokens: num(record.promptTokens),
		outputTokens: num(record.completionTokens),
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: null
	};
}

const TOOL_ARGS_FIELDS = ['args', 'arguments', 'argsDelta', 'argumentsDelta', 'input'] as const;

/**
 * Tool arguments as a JSON string. Cursor sends `args` as a string, but an object (or an
 * alternate field name) must not silently collapse to `''` and reach the client as `{}`.
 */
export function toolCallArgs(part: JsonRecord): string {
	for (const field of TOOL_ARGS_FIELDS) {
		const value = part[field];
		if (typeof value === 'string' && value) return value;
		if (value && typeof value === 'object') {
			try {
				return JSON.stringify(value);
			} catch {
				return '';
			}
		}
	}

	return '';
}

/** Field names and value types of a tool call part, never the values (they may hold user data). */
export function describeToolCallShape(part: JsonRecord): string {
	return Object.entries(part)
		.map(([key, value]) => {
			const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
			const size = typeof value === 'string' ? `(${value.length})` : '';

			return `${key}:${type}${size}`;
		})
		.join(', ');
}

function isEmptyArgs(args: string): boolean {
	const trimmed = args.trim();

	return trimmed === '' || trimmed === '{}' || trimmed === 'null';
}

/** Maps one `InferenceStreamResponse` oneof to bridge events. */
export function mapStreamResponse(
	raw: unknown,
	state: { sawExtendedUsage: boolean }
): CursorBridgeEventBody | { kind: 'error'; error: CursorBridgeError } | null {
	const response = asRecord(raw);
	if (!response) return null;

	const textPart = asRecord(response.textPart);
	if (textPart) {
		const text = str(textPart.text);

		return text ? { kind: 'text', text } : null;
	}

	const thinkingPart = asRecord(response.thinkingPart);
	if (thinkingPart) {
		const text = str(thinkingPart.text);

		return text ? { kind: 'thinking', text } : null;
	}

	const toolCallPart = asRecord(response.toolCallPart);
	if (toolCallPart) {
		const toolIndex = toolCallPart.toolIndex;

		return {
			kind: 'toolCall',
			toolCallId: str(toolCallPart.toolCallId),
			toolName: str(toolCallPart.toolName),
			args: toolCallArgs(toolCallPart),
			isComplete: toolCallPart.isComplete === true,
			toolIndex: toolIndex === undefined ? null : num(toolIndex)
		};
	}

	if (response.extendedUsage !== undefined) {
		state.sawExtendedUsage = true;

		return { kind: 'usage', usage: usageFromExtended(response.extendedUsage) };
	}

	if (response.usage !== undefined && !state.sawExtendedUsage) {
		return { kind: 'usage', usage: usageFromBasic(response.usage) };
	}

	const streamError = asRecord(response.error);
	if (streamError) {
		const type = str(streamError.errorType);
		let kind: CursorBridgeErrorKind = STREAM_ERROR_TYPE_KIND[type] ?? 'upstream';
		if (streamError.isInputTokenLimitError === true) kind = 'input_too_long';

		return {
			kind: 'error',
			error: {
				kind,
				code: str(streamError.code) || type,
				message: redactMessage(str(streamError.message) || 'Cursor model error')
			}
		};
	}

	return null;
}

export interface RunInferenceOptions {
	request: CursorInferenceRequest;
	/** Reads credentials fresh; returns null when signed out. */
	credentials: () => CursorRequestCredentials | null;
	/** Refreshes the Cursor session; called at most once, only before any output. */
	refresh: () => Promise<void>;
	signal?: AbortSignal;
	deadlineMs?: number;
	connect?: Http2Connect;
	/** Diagnostics; never receives credentials or tool argument values. */
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;

function buildRunRequest(modelId: string): JsonRecord {
	return {
		runRequest: {
			conversationId: randomUUID(),
			requestedModel: { modelId, maxMode: false, parameters: [], builtInModel: true },
			supportsLongReasoningReminder: false,
			supportsAgentLoopError: true,
			supportsDeltaInvocations: false,
			speculativeInvocations: false,
			sendsClientFirstCallTimings: false,
			prewarm: false
		}
	};
}

/** Run-scoped fields belong on `runRequest`; Cursor rejects them inside `invokeModel.request`. */
function buildStreamRequest(request: CursorInferenceRequest): JsonRecord {
	const body: JsonRecord = { messages: request.messages, tools: request.tools };
	if (request.modelConfig && Object.keys(request.modelConfig).length > 0) body.modelConfig = request.modelConfig;

	return body;
}

interface AttemptOutcome {
	retryAuth: boolean;
}

/**
 * Runs one model invocation over Cursor's bidirectional `RunInference` stream:
 * `runRequest` -> `runReady` -> `invokeModel` -> `invocationResponse`* -> `invocationEnd` -> `finishRun`.
 * Always finishes with exactly one `end` event. Retries only an auth failure that happens
 * before any output, after one session refresh.
 */
export async function* runInference(options: RunInferenceOptions): AsyncGenerator<CursorBridgeEventBody> {
	let refreshed = false;

	for (;;) {
		const outcome: AttemptOutcome = { retryAuth: false };
		const creds = options.credentials();

		if (!creds) {
			if (!refreshed) {
				refreshed = true;
				await options.refresh();
				continue;
			}

			yield { kind: 'end', error: { kind: 'auth', message: 'Sign in to Cursor to use Cursor models' } };

			return;
		}

		for await (const event of attempt(options, creds, !refreshed, outcome)) {
			yield event;
		}

		if (outcome.retryAuth && !refreshed) {
			refreshed = true;
			await options.refresh();
			continue;
		}

		return;
	}
}

async function* attempt(
	options: RunInferenceOptions,
	creds: CursorRequestCredentials,
	mayRetryAuth: boolean,
	outcome: AttemptOutcome
): AsyncGenerator<CursorBridgeEventBody> {
	const invocationId = randomUUID();
	const stream = openBidiStream({
		url: creds.agentUrl,
		path: RUN_INFERENCE_PATH,
		headers: creds.headers,
		signal: options.signal,
		deadlineMs: options.deadlineMs ?? DEFAULT_DEADLINE_MS,
		connect: options.connect
	});
	const usageState = { sawExtendedUsage: false };
	let invoked = false;
	let outputStarted = false;
	let ended = false;

	const finish = (aborted: boolean) => {
		if (aborted && invoked) stream.write({ cancelInvocation: { invocationId } });
		stream.write({ finishRun: { aborted, turnCompleted: !aborted } });
		stream.end();
	};

	const endWith = (error: CursorBridgeError | null): CursorBridgeEventBody | null => {
		if (ended) return null;
		ended = true;

		if (error?.kind === 'auth' && mayRetryAuth && !outputStarted) {
			outcome.retryAuth = true;

			return null;
		}

		return { kind: 'end', error };
	};

	stream.write(buildRunRequest(options.request.modelId));

	try {
		for await (const item of stream.items()) {
			if (options.signal?.aborted && !ended) {
				finish(true);
				const end = endWith({ kind: 'cancelled', message: 'Request cancelled' });
				if (end) yield end;
				break;
			}

			if (item.type === 'status') {
				const error = classifyHttpStatus(item.status);
				if (error) {
					const end = endWith(error);
					if (end) yield end;
					break;
				}
				continue;
			}

			if (item.type === 'error') {
				const aborted = item.error.message === 'aborted';
				if (aborted && !ended) finish(true);
				const kind: CursorBridgeErrorKind = aborted
					? 'cancelled'
					: item.error.message === 'deadline_exceeded'
						? 'timeout'
						: 'upstream';
				const end = endWith({ kind, message: aborted ? 'Request cancelled' : redactMessage(item.error.message) });
				if (end) yield end;
				break;
			}

			if (item.type === 'closed') {
				const end = endWith(ended ? null : { kind: 'upstream', message: 'Cursor closed the stream before the invocation ended' });
				if (end) yield end;
				break;
			}

			const { frame } = item;

			if (frame.flags & CONNECT_FLAG_END_STREAM) {
				const error = classifyEndStreamError(frame.message);
				const end = endWith(error ?? (ended ? null : { kind: 'upstream', message: 'Cursor ended the stream early' }));
				if (end) yield end;
				break;
			}

			const message = asRecord(frame.message) ?? {};

			if (message.runReady !== undefined) {
				const ready = asRecord(message.runReady) ?? {};
				const resolved = str(asRecord(ready.resolvedModel)?.modelId) || null;

				if (!invoked) {
					invoked = true;
					const invoke: JsonRecord = { invocationId, request: buildStreamRequest(options.request) };
					if (typeof ready.configFingerprint === 'string' && ready.configFingerprint) {
						invoke.configFingerprint = ready.configFingerprint;
					}
					stream.write({ invokeModel: invoke });
					yield { kind: 'ready', resolvedModel: resolved };
				}

				continue;
			}

			if (message.invocationResponse !== undefined) {
				const response = asRecord(message.invocationResponse)?.response;
				const mapped = mapStreamResponse(response, usageState);
				if (!mapped) continue;

				if (mapped.kind === 'toolCall' && mapped.isComplete && isEmptyArgs(mapped.args)) {
					const part = asRecord(asRecord(response)?.toolCallPart) ?? {};
					options.onLog?.(
						'warn',
						`[cursor] ${options.request.modelId} sent ${mapped.toolName || 'a tool call'} with empty arguments; fields: ${describeToolCallShape(part)}`
					);
				}

				if (mapped.kind === 'error') {
					finish(false);
					const end = endWith(mapped.error);
					if (end) yield end;
					break;
				}

				if (mapped.kind === 'text' || mapped.kind === 'thinking' || mapped.kind === 'toolCall') outputStarted = true;
				yield mapped;
				continue;
			}

			if (message.invocationEnd !== undefined) {
				const endRecord = asRecord(message.invocationEnd) ?? {};
				const error = endRecord.error === undefined ? null : classifyInvocationError(endRecord.error);
				finish(false);
				const end = endWith(error);
				if (end) yield end;
				break;
			}

			// heartbeat, subagentModelsResolved and unknown messages are ignored.
		}
	} finally {
		if (!ended) {
			// The consumer stopped early (client disconnect): tell Cursor the run was aborted.
			finish(true);
		}

		stream.close();
	}

	if (!ended) {
		yield { kind: 'end', error: { kind: 'upstream', message: 'Cursor stream ended unexpectedly' } };
	}
}

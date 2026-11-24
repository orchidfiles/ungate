import { createHash, randomUUID } from 'node:crypto';

import { CursorRequestError, openaiToCursor } from 'src/adapter/openai-to-cursor';
import { CompletionRequestTelemetry } from 'src/metrics';
import { CompletionErrorMapper } from 'src/orchestration/openai/error-mapper';
import { cursorBridgeClient, type CursorBridgeClient } from 'src/proxy/cursor-bridge-client';
import { CursorStreamHandler, type CursorStreamOptions, type RepairRound } from 'src/streaming/cursor-stream-handler';
import { logger } from 'src/utils/logger';
import { clientAbortSignal } from 'src/utils/request-abort';

import type {
	CursorBridgeError,
	CursorBridgeEventBody,
	CursorInferenceMessage,
	CursorInferenceRequest,
	CursorInferenceToolResultPart,
	ModelMappingConfig,
	RequestTelemetry
} from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

/**
 * Ungate-owned identity derived from the telemetry session heuristic, not a native Cursor chat id.
 * UUIDv8 reserves space for application-defined hashes; the domain keeps this separate from other ids.
 */
function conversationId(sessionKey: RequestTelemetry['sessionKey']): string {
	if (!sessionKey) return randomUUID();
	const bytes = createHash('sha256').update('ungate:cursor-inference:conversation:v1\0').update(sessionKey).digest();
	bytes[6] = (bytes[6] & 0x0f) | 0x80;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.subarray(0, 16).toString('hex');

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Replays already-read events, then continues with the rest of the invocation. */
async function* prepend(
	head: CursorBridgeEventBody[],
	rest: AsyncIterator<CursorBridgeEventBody>
): AsyncGenerator<CursorBridgeEventBody> {
	try {
		yield* head;
		for (;;) {
			const next = await rest.next();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		await rest.return?.(undefined);
	}
}

function parseArgs(raw: string): Record<string, unknown> {
	try {
		const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};

		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * The original request plus the model's invalid tool-call turn, answered with one error result
 * per call, so the model re-issues the whole batch with complete arguments.
 */
export function buildRepairRequest(request: CursorInferenceRequest, round: RepairRound): CursorInferenceRequest {
	const invalidById = new Map(round.invalid.map((call) => [call.id, call]));
	const assistant: CursorInferenceMessage = {
		role: 'INFERENCE_MESSAGE_ROLE_ASSISTANT',
		toolCalls: round.calls.map((call) => ({ toolCallId: call.id, toolName: call.name, args: parseArgs(call.args) }))
	};
	if (round.text) assistant.text = round.text;

	const parts: CursorInferenceToolResultPart[] = round.calls.map((call) => {
		const invalid = invalidById.get(call.id);

		return {
			toolCallId: call.id,
			toolName: call.name,
			isError: true,
			result: invalid
				? `Invalid arguments: ${invalid.problems.slice(0, 5).join('; ')}. The call was not executed. Re-issue this call with a complete JSON arguments object that satisfies the tool's schema.`
				: 'Not executed because other calls in this batch had invalid arguments. Re-issue it together with the corrected calls.'
		};
	});

	return {
		...request,
		messages: [...request.messages, assistant, { role: 'INFERENCE_MESSAGE_ROLE_TOOL', toolContent: { parts } }]
	};
}

export class CursorChatHandler {
	static async handle(
		openaiBody: OpenAIChatRequest,
		resolvedModel: ModelMappingConfig,
		reply: FastifyReply,
		requestTelemetry: RequestTelemetry = {},
		client: CursorBridgeClient = cursorBridgeClient
	): Promise<FastifyReply> {
		const startTime = Date.now();
		const modelName = resolvedModel.id;
		const stream = openaiBody.stream === true;

		const fail = (status: number, body: unknown, error: string, aborted = false) => {
			const latencyMs = Date.now() - startTime;
			CompletionRequestTelemetry.recordAndApplyProxyHeaders(reply, latencyMs, {
				...requestTelemetry,
				model: modelName,
				source: aborted ? 'cursor' : 'error',
				inputTokens: 0,
				outputTokens: 0,
				stream,
				latencyMs,
				error: aborted ? null : error,
				stopReason: aborted ? 'aborted' : 'error'
			});

			return reply.code(status).send(body);
		};

		let built: ReturnType<typeof openaiToCursor>;

		try {
			built = openaiToCursor(openaiBody, { upstreamModel: resolvedModel.upstreamModel, toolMode: resolvedModel.toolMode });
		} catch (error) {
			if (error instanceof CursorRequestError) {
				return fail(400, { error: { message: error.message, type: 'invalid_request_error' } }, error.message);
			}

			throw error;
		}

		built.request.conversationId = conversationId(requestTelemetry.sessionKey);

		const signal = clientAbortSignal(reply);
		const iterator = client.invoke(built.request, signal)[Symbol.asyncIterator]();

		// Read up to the first output event so pre-output failures (auth, tool schema, bad model)
		// become real HTTP errors instead of an in-band SSE error.
		const head: CursorBridgeEventBody[] = [];
		let startError: CursorBridgeError | null = null;

		for (;;) {
			const next = await iterator.next();
			if (next.done) {
				startError = { kind: 'upstream', message: 'Cursor ended the invocation without a response' };
				break;
			}

			if (next.value.kind === 'end') {
				if (next.value.error) {
					startError = next.value.error;
				} else {
					head.push(next.value);
				}
				break;
			}

			head.push(next.value);
			if (next.value.kind !== 'ready') break;
		}

		if (startError) {
			await iterator.return?.(undefined);
			const mapped = CompletionErrorMapper.cursorError(startError);
			if (startError.kind === 'token_encrypted') reply.header('x-should-retry', 'false');
			const aborted = startError.kind === 'cancelled';
			if (!aborted)
				logger.warn(`[cursor] ${resolvedModel.upstreamModel} failed before output: ${startError.kind} ${startError.message}`);

			return fail(mapped.status, mapped.body, startError.message, aborted);
		}

		const embedded = built.capability === 'embedded' && built.request.tools.length > 0;
		const options: CursorStreamOptions = {
			events: prepend(head, iterator),
			streamId: randomUUID().replace(/-/g, '').slice(0, 24),
			modelName,
			upstreamModel: resolvedModel.upstreamModel,
			tools: openaiBody.tools,
			startTime,
			telemetry: requestTelemetry,
			signal,
			holdToolCalls: embedded,
			repair: embedded ? (round) => client.invoke(buildRepairRequest(built.request, round), signal) : undefined
		};

		if (stream) {
			const { stream: body, headers } = CursorStreamHandler.createStreamResponse(options);
			for (const [key, value] of Object.entries(headers)) reply.header(key, value);
			reply.header('openai-processing-ms', String(Date.now() - startTime));

			return reply.code(200).send(body);
		}

		const { response, error } = await CursorStreamHandler.collect(options);
		CompletionRequestTelemetry.applyProxyHeaders(reply, Date.now() - startTime);

		if (!response) {
			const mapped = CompletionErrorMapper.cursorError(error ?? { kind: 'upstream', message: 'Cursor returned no response' });

			return reply.code(mapped.status).send(mapped.body);
		}

		return reply.send(response);
	}
}

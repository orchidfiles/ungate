import { randomUUID } from 'node:crypto';

import { CursorRequestError, openaiToCursor } from 'src/adapter/openai-to-cursor';
import { CompletionRequestTelemetry } from 'src/metrics';
import { CompletionErrorMapper } from 'src/orchestration/openai/error-mapper';
import { cursorBridgeClient, type CursorBridgeClient } from 'src/proxy/cursor-bridge-client';
import { CursorStreamHandler } from 'src/streaming/cursor-stream-handler';
import { logger } from 'src/utils/logger';
import { clientAbortSignal } from 'src/utils/request-abort';

import type { CursorBridgeError, CursorBridgeEventBody, ModelMappingConfig, RequestTelemetry } from '@ungate/shared';
import type { FastifyReply } from 'fastify';
import type { OpenAIChatRequest } from 'src/types/openai';

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
			const aborted = startError.kind === 'cancelled';
			if (!aborted)
				logger.warn(`[cursor] ${resolvedModel.upstreamModel} failed before output: ${startError.kind} ${startError.message}`);

			return fail(mapped.status, mapped.body, startError.message, aborted);
		}

		const options = {
			events: prepend(head, iterator),
			streamId: randomUUID().replace(/-/g, '').slice(0, 24),
			modelName,
			upstreamModel: resolvedModel.upstreamModel,
			tools: openaiBody.tools,
			startTime,
			telemetry: requestTelemetry,
			signal
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

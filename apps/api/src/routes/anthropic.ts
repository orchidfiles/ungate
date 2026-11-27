import { logger } from 'src/utils/logger';

import { Requests } from '../database/requests';
import { HeadersExtractor } from '../handlers/headers-extractor';
import { RequestHeuristics } from '../metrics/request-heuristics';
import { clientKeyAuth } from '../plugins/auth';
import { anthropicCaller, type AnthropicCaller } from '../proxy/anthropic-caller';
import { proxyRequest } from '../proxy/anthropic-client';
import { AnthropicSseTap, type AnthropicStreamSummary } from '../streaming/anthropic-sse-tap';
import { clientAbortSignal } from '../utils/request-abort';

import type { AnthropicRequest, AnthropicError } from '../types';
import type { RequestContext } from '../types/proxy';
import type { RequestTelemetry } from '@ungate/shared';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';

/** Request-side telemetry: who called, and which CLI session and turn this is. */
function requestTelemetry(body: AnthropicRequest, caller: AnthropicCaller, clientId: string | null): RequestTelemetry {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const sessionKey = caller.kind === 'claude-code' && caller.sessionId ? RequestHeuristics.sessionKey(caller.sessionId) : null;

	return {
		clientId,
		sessionKey,
		turnIndex: messages.filter((message) => message.role === 'assistant').length,
		messageCount: messages.length
	};
}

function recordStream(context: RequestContext, summary: AnthropicStreamSummary): void {
	Requests.record({
		...context.telemetry,
		model: context.model,
		source: summary.error && summary.stopReason === 'error' ? 'error' : context.source,
		inputTokens: summary.inputTokens,
		outputTokens: summary.outputTokens,
		cacheReadTokens: summary.cacheReadTokens,
		cacheCreationTokens: summary.cacheCreationTokens,
		reasoningChars: summary.reasoningChars,
		stopReason: summary.stopReason,
		toolCallCount: summary.toolNames.length,
		toolNames: summary.toolNames,
		stream: true,
		latencyMs: Date.now() - context.startTime,
		firstTokenMs: summary.firstTokenAt ? summary.firstTokenAt - context.startTime : null,
		error: summary.error?.slice(0, 500) ?? null
	});
}

/** One row for a buffered response or a failure answered before any stream started. */
function recordBuffered(context: RequestContext, error: string | null): void {
	Requests.record({
		...context.telemetry,
		stopReason: error ? 'error' : context.telemetry?.stopReason,
		model: context.model,
		source: error ? 'error' : context.source,
		inputTokens: context.inputTokens ?? 0,
		outputTokens: context.outputTokens ?? 0,
		stream: false,
		latencyMs: Date.now() - context.startTime,
		error
	});
}

async function errorMessage(response: Response): Promise<string> {
	const text = await response
		.clone()
		.text()
		.catch(() => '');
	try {
		const json = JSON.parse(text) as { error?: { message?: unknown } };
		if (typeof json.error?.message === 'string') return json.error.message.slice(0, 500);
	} catch {
		// Not JSON: fall back to the status below.
	}

	return `HTTP ${response.status}`;
}

function copyHeaders(response: Response, reply: FastifyReply): void {
	for (const [key, value] of response.headers.entries()) {
		if (key.toLowerCase() !== 'content-encoding') reply.header(key, value);
	}
}

function badRequest(reply: FastifyReply, error: unknown): FastifyReply {
	logger.error(`Request handling error: ${String(error)}`);

	const errorBody: AnthropicError = { type: 'error', error: { type: 'invalid_request_error', message: String(error) } };

	return reply.code(400).send(errorBody);
}

const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/messages', { onRequest: clientKeyAuth(config) }, async (request, reply) => {
		try {
			HeadersExtractor.logRequestDetails(request.headers, request.url, request.method, 'Anthropic /v1/messages');

			const body = request.body as AnthropicRequest;
			const caller = anthropicCaller(request.headers);

			logger.log(`→ Model: "${body.model}" | ${body.stream ? 'stream' : 'sync'} | caller=${caller.kind}`);

			const { response, context } = await proxyRequest('/v1/messages', body, caller, clientAbortSignal(reply));
			context.telemetry = { ...requestTelemetry(body, caller, request.clientId), ...context.telemetry };

			copyHeaders(response, reply);
			reply.code(response.status);

			const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
			if (response.ok && isStream && response.body) {
				return reply.send(
					AnthropicSseTap.observe(response.body, {
						onError: context.onStreamError,
						onEnd: (summary) => recordStream(context, summary)
					})
				);
			}

			recordBuffered(context, response.ok ? null : await errorMessage(response));

			return reply.send(response.body ?? '');
		} catch (error) {
			return badRequest(reply, error);
		}
	});

	/** Token counting for Claude Code's context view. Counted on a pool account; not recorded as usage. */
	app.post('/v1/messages/count_tokens', { onRequest: clientKeyAuth(config) }, async (request, reply) => {
		try {
			const body = request.body as AnthropicRequest;
			const caller = anthropicCaller(request.headers);
			const { response } = await proxyRequest('/v1/messages/count_tokens', body, caller, clientAbortSignal(reply));

			copyHeaders(response, reply);

			return reply.code(response.status).send(response.body ?? '');
		} catch (error) {
			return badRequest(reply, error);
		}
	});
};

export default plugin;

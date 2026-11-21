import { Requests } from 'src/database/requests';
import { clientKeyAuth } from 'src/plugins/auth';
import { OpenAiClient } from 'src/proxy/openai-client';
import {
	ResponsesSseProcessor,
	StreamDiagnostics,
	StreamStateFactory,
	type StreamState
} from 'src/proxy/responses-stream-mapper';
import { tapSse, UPSTREAM_IDLE_TIMEOUT_MS, type SseTapEnd, type SseTapReader, type UpstreamIdle } from 'src/streaming/sse-tap';
import { logger } from 'src/utils/logger';
import { clientAbortSignal } from 'src/utils/request-abort';

import { RequestHeuristics } from '../metrics/request-heuristics';

import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import type { RequestContext } from 'src/types/proxy';

/** Codex session and client headers kept on the way to the ChatGPT backend; auth is the pool's. */
const FORWARDED =
	/^(session[-_]id|thread-id|originator|version|user-agent|openai-beta|x-client-request-id|x-codex-.+|x-openai-.+)$/;

function callerHeaders(headers: IncomingHttpHeaders): Record<string, string> {
	const forwarded: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const text = Array.isArray(value) ? value.join(', ') : value;
		if (text !== undefined && FORWARDED.test(name.toLowerCase())) forwarded[name.toLowerCase()] = text;
	}

	return forwarded;
}

interface ResponsesStreamSummary {
	state: StreamState;
	end: SseTapEnd;
}

/** Reads Responses events with the same router the chat path uses, so usage is counted one way. */
class ResponsesStreamReader implements SseTapReader<ResponsesStreamSummary> {
	readonly state: StreamState;

	constructor(
		model: string,
		private readonly onStreamError: (error: Record<string, unknown> | undefined) => void
	) {
		this.state = StreamStateFactory.create(model);
	}

	read(text: string): void {
		if (this.state.terminal) return;
		for (const result of ResponsesSseProcessor.process(this.state, text)) {
			if (result.type === 'error') this.onStreamError(result.upstreamError);
		}
	}

	finish(end: SseTapEnd): ResponsesStreamSummary {
		return { state: this.state, end };
	}
}

/** Codex's own failure frame for a stream the upstream stopped feeding; Codex retries the turn. */
function idleFailedEvent(idle: UpstreamIdle): string {
	const data = {
		type: 'response.failed',
		response: { status: 'failed', error: { code: 'server_error', message: `Upstream stream stalled: ${idle.message}` } }
	};

	return `event: response.failed\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamError({ state, end }: ResponsesStreamSummary): string | null {
	if (state.terminal === 'failed') return state.failure?.message ?? 'ChatGPT stream failed';
	if (state.terminal) return null;
	if (end.kind === 'aborted') return 'Client cancelled stream';
	if (end.kind === 'failed') return `Upstream stream failed: ${String(end.error)}`;

	return 'ChatGPT stream ended before completion';
}

function recordStream(context: RequestContext, summary: ResponsesStreamSummary): void {
	const { state, end } = summary;
	const error = streamError(summary);
	const aborted = end.kind === 'aborted' && !state.terminal;

	Requests.record({
		...context.telemetry,
		...StreamDiagnostics.telemetry(state, aborted ? 'aborted' : error ? 'failed' : undefined),
		model: context.model,
		source: error ? 'error' : context.source,
		inputTokens: state.usage?.prompt_tokens ?? 0,
		outputTokens: state.usage?.completion_tokens ?? 0,
		stream: true,
		latencyMs: Date.now() - context.startTime,
		firstTokenMs: state.firstTokenAt ? state.firstTokenAt - context.startTime : null,
		error: error?.slice(0, 500) ?? null
	});
}

function recordAnswered(context: RequestContext, response: Response, error: string): void {
	Requests.record({
		...context.telemetry,
		stopReason: 'error',
		model: context.model,
		source: 'error',
		inputTokens: 0,
		outputTokens: 0,
		stream: false,
		latencyMs: Date.now() - context.startTime,
		error: `${response.status}: ${error}`.slice(0, 500)
	});
}

async function errorMessage(response: Response): Promise<string> {
	const text = await response
		.clone()
		.text()
		.catch(() => '');
	try {
		const json = JSON.parse(text) as { error?: { message?: unknown } };
		if (typeof json.error?.message === 'string') return json.error.message;
	} catch {
		// Not JSON: fall back to the status below.
	}

	return `HTTP ${response.status}`;
}

function copyHeaders(response: Response, reply: FastifyReply): void {
	for (const [key, value] of response.headers.entries()) {
		if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') reply.header(key, value);
	}
}

/**
 * `/v1/responses` for Codex: the request goes to the ChatGPT pool as Codex sent it, and the
 * stream comes back byte for byte while one `requests` row records its usage.
 */
const plugin: FastifyPluginCallback = (app) => {
	const { config } = app;

	app.post('/v1/responses', { onRequest: clientKeyAuth(config) }, async (request, reply) => {
		const body = request.body as { model?: unknown; input?: unknown };
		const headers = callerHeaders(request.headers);
		const sessionId = headers['session-id'] ?? headers.session_id;

		const { response, context, onStreamError } = await OpenAiClient.proxyResponses(body, headers, clientAbortSignal(reply));
		context.telemetry = {
			...context.telemetry,
			clientId: request.clientId,
			sessionKey: sessionId ? RequestHeuristics.sessionKey(sessionId) : null,
			messageCount: Array.isArray(body.input) ? body.input.length : null
		};

		copyHeaders(response, reply);
		reply.code(response.status);

		if (!response.ok || !response.body) {
			const message = await errorMessage(response);
			logger.log(`[Codex] responses answered ${response.status}: ${message}`);
			recordAnswered(context, response, message);

			return reply.send(response.body ?? '');
		}

		const reader = new ResponsesStreamReader(context.model, onStreamError);

		return reply.send(
			tapSse(response.body, reader, (summary) => recordStream(context, summary), {
				idleTimeoutMs: UPSTREAM_IDLE_TIMEOUT_MS,
				terminalEvent: idleFailedEvent
			})
		);
	});
};

export default plugin;

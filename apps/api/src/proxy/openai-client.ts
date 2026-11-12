import { logger } from 'src/utils/logger';

import { OpenAIOAuthService } from '../auth/openai/openai-oauth-service';
import { config } from '../config';
import { Settings } from '../database/app-settings';
import { Requests } from '../database/requests';

import { AccountFallback } from './account-fallback';
import { ResponsesBodyBuilder } from './responses-input-normalizer/build-body';
import { ResponsesModelResolver } from './responses-input-normalizer/resolve-model';
import { ResponsesSseProcessor, StreamDiagnostics, StreamStateFactory, type StreamState } from './responses-stream-mapper';
import { StreamChunkMapper } from './responses-stream-mapper/stream-openai-chunks';
import { SsePrecommitGate } from './sse-precommit-gate';
import { UsageLimitClassifier } from './usage-limit-classifier';

import type { OAuthCredentials } from '../auth/base-provider';
import type { OpenAIChatRequest } from '../types/openai';
import type { RequestContext } from '../types/proxy';
import type { RequestTelemetry } from '@ungate/shared';

/** Codex `/responses` requires non-empty `instructions` (api_error otherwise). */
const CODEX_INSTRUCTIONS_FALLBACK =
	'You are a coding assistant integrated with the user editor. Follow the conversation and use tools when appropriate.';

const ENV_CHATGPT_INSTRUCTIONS = process.env.CHATGPT_INSTRUCTIONS?.trim();

interface ProxyOpenAiResult {
	response: Response;
	context: RequestContext;
}

export interface ProxyResponsesResult extends ProxyOpenAiResult {
	/** Post-commit hook for an upstream error inside the forwarded stream (cools the account down). */
	onStreamError: (error: Record<string, unknown> | undefined) => void;
}

type PoolOutcome =
	| {
			kind: 'served';
			response: Response;
			telemetry: RequestTelemetry;
			onStreamError: (error: Record<string, unknown> | undefined) => void;
	  }
	| { kind: 'answered'; result: ProxyOpenAiResult };

export class OpenAiClient {
	/**
	 * `requestTelemetry` (the caller's client and request shape) goes on the context before a
	 * stream starts reading, since a short stream can finish and record its row at once.
	 */
	static async proxy(
		body: OpenAIChatRequest,
		signal?: AbortSignal,
		requestTelemetry: RequestTelemetry = {}
	): Promise<ProxyOpenAiResult> {
		const startTime = Date.now();
		const model = body.model;
		const normalizedModel = ResponsesModelResolver.resolveModel(model).model;
		const requestBody = JSON.stringify(this.buildCodexBody(body, model, normalizedModel));

		const served = await this.runPool(requestBody, {}, model, startTime, signal);
		if (served.kind === 'answered') {
			served.result.context.telemetry = { ...requestTelemetry, ...served.result.context.telemetry };

			return served.result;
		}

		return this.successResult(
			body,
			served.response,
			model,
			normalizedModel,
			startTime,
			{ ...requestTelemetry, ...served.telemetry },
			served.onStreamError
		);
	}

	/**
	 * A Responses request from a Codex client, sent to the ChatGPT pool as it came. The body is
	 * already what the Codex backend takes; `callerHeaders` carry the client's session headers. The
	 * committed stream is returned untouched for the route to forward and record.
	 */
	static async proxyResponses(
		body: { model?: unknown },
		callerHeaders: Record<string, string>,
		signal?: AbortSignal
	): Promise<ProxyResponsesResult> {
		const startTime = Date.now();
		const model = typeof body.model === 'string' ? body.model : 'unknown';
		logger.log(`OpenAI Codex responses pass-through: ${model}`);

		const served = await this.runPool(JSON.stringify(body), callerHeaders, model, startTime, signal);
		if (served.kind === 'answered') return { ...served.result, onStreamError: () => undefined };

		return {
			response: served.response,
			context: { ...this.openAiContext(model, startTime), telemetryDeferred: true, telemetry: served.telemetry },
			onStreamError: served.onStreamError
		};
	}

	/**
	 * Sends one Codex request through the ChatGPT pool, rotating accounts on usage limits. Returns
	 * the committed upstream response, or the answer to give when no account served it.
	 */
	private static async runPool(
		requestBody: string,
		callerHeaders: Record<string, string>,
		model: string,
		startTime: number,
		signal?: AbortSignal
	): Promise<PoolOutcome> {
		let missingWorkspace = false;
		let outcome: Awaited<ReturnType<typeof AccountFallback.run<OAuthCredentials>>>;

		try {
			// Each attempt is pinned to one local account; usage limits rotate via the shared coordinator.
			outcome = await AccountFallback.run<OAuthCredentials>({
				provider: 'openai',
				// Account-scoped refresh service (dedupes concurrent refreshes, respects needs-login state).
				getCredentials: async (localAccountId) => {
					const creds = await OpenAIOAuthService.getValidToken(localAccountId);
					if (creds?.accessToken && !creds.accountId) missingWorkspace = true;

					return creds?.accessToken && creds.accountId ? creds : null;
				},
				send: (creds) => this.sendPinned(requestBody, creds, callerHeaders, signal),
				// Codex always streams SSE: explicit early usage-limit events rotate before commit.
				inspect: SsePrecommitGate.inspector('openai', { signal }),
				signal
			});
		} catch (error) {
			if (signal?.aborted) {
				logger.log('ChatGPT Codex request aborted by client; fallback stopped');

				return this.answered(
					this.errorResult(model, startTime, 499, { message: 'Client closed request', type: 'client_closed_request' })
				);
			}
			logger.error(`ChatGPT Codex request failed: ${String(error)}`);

			return this.answered(
				this.errorResult(model, startTime, 502, { message: `ChatGPT request failed: ${String(error)}`, type: 'api_error' })
			);
		}

		if (outcome.kind === 'no_credentials') {
			return this.answered(
				this.authErrorResult(
					model,
					startTime,
					missingWorkspace
						? 'ChatGPT account id missing. Re-login to refresh your ChatGPT token.'
						: 'Not authenticated with OpenAI'
				)
			);
		}

		if (outcome.kind === 'limited') {
			logger.log(`ChatGPT Codex usage limit: no eligible account (${outcome.reason})`);

			const limited = this.errorResult(
				model,
				startTime,
				429,
				{ message: outcome.message, type: 'usage_limit_reached' },
				outcome.headers
			);
			limited.context.telemetry = {
				accountId: outcome.accountId,
				attempts: outcome.attempts,
				rotationReason: outcome.reason,
				stopReason: 'error'
			};

			return this.answered(limited);
		}

		const telemetry: RequestTelemetry = {
			accountId: outcome.accountId,
			attempts: outcome.attempts,
			rotationReason: outcome.rotationReason
		};

		if (!outcome.response.ok) {
			const failed = await this.upstreamErrorResult(outcome.response, model, startTime);
			failed.context.telemetry = { ...telemetry, stopReason: 'error' };

			return this.answered(failed);
		}

		return {
			kind: 'served',
			response: outcome.response,
			telemetry,
			onStreamError: SsePrecommitGate.cooldownOnStreamLimit(
				'openai',
				outcome.accountId,
				outcome.credentials.credentialVersion,
				outcome.response.headers
			)
		};
	}

	private static answered(result: ProxyOpenAiResult): PoolOutcome {
		return { kind: 'answered', result };
	}

	/** One Codex attempt pinned to `creds`' account, with one same-account refresh retry on 401. */
	private static async sendPinned(
		requestBody: string,
		creds: OAuthCredentials,
		callerHeaders: Record<string, string>,
		signal?: AbortSignal
	): Promise<{ response: Response; credentials: OAuthCredentials }> {
		const response = await this.fetchCodexResponses(requestBody, creds.accessToken, creds.accountId!, callerHeaders, signal);

		if (response.status !== 401 || !creds.localAccountId) return { response, credentials: creds };

		await response.body?.cancel().catch(() => undefined);
		logger.log(`ChatGPT Codex 401: refreshing token for account ${creds.localAccountId}`);
		const refreshed = await OpenAIOAuthService.refreshAccountToken(creds.localAccountId, creds.credentialVersion);

		if (!refreshed?.accessToken || !refreshed.accountId) {
			return {
				response: new Response(
					JSON.stringify({ error: { message: 'ChatGPT OAuth token invalid', type: 'authentication_error' } }),
					{
						status: 401,
						headers: { 'content-type': 'application/json' }
					}
				),
				credentials: creds
			};
		}

		return {
			response: await this.fetchCodexResponses(requestBody, refreshed.accessToken, refreshed.accountId, callerHeaders, signal),
			credentials: refreshed
		};
	}

	private static authErrorResult(model: string, startTime: number, message: string): ProxyOpenAiResult {
		return this.errorResult(model, startTime, 401, { message, type: 'authentication_error' });
	}

	private static buildCodexBody(body: OpenAIChatRequest, model: string, normalizedModel: string): unknown {
		const rawExtraInstruction = Settings.get().extraInstruction;
		const extraInstruction = rawExtraInstruction ?? undefined;
		const buildResult = ResponsesBodyBuilder.buildBody(body, model, {
			extraInstruction,
			envInstructions: ENV_CHATGPT_INSTRUCTIONS,
			instructionsFallback: CODEX_INSTRUCTIONS_FALLBACK
		});
		const requestBody = buildResult.payload;
		const incomingToolCount = Array.isArray(body.tools) ? body.tools.length : 0;

		logger.log(
			`[Codex] upstreamModel=${model} chatMessages=${buildResult.debug.chatMessages} inputField=${buildResult.debug.inputField} codexItems=${buildResult.debug.codexItems} fromBodyInput=${buildResult.debug.fromBodyInput}`
		);

		logger.log(`OpenAI Codex proxy: ${model} → ${normalizedModel} tools=${incomingToolCount} stream=${body.stream ?? false}`);

		return requestBody;
	}

	private static fetchCodexResponses(
		requestBody: string,
		accessToken: string,
		accountId: string,
		callerHeaders: Record<string, string>,
		signal?: AbortSignal
	): Promise<Response> {
		return fetch(`${config.openai.codexUrl}/responses`, {
			signal,
			method: 'POST',
			headers: {
				originator: 'codex_cli_rs',
				...callerHeaders,
				'content-type': 'application/json',
				authorization: `Bearer ${accessToken}`,
				'chatgpt-account-id': accountId,
				accept: 'text/event-stream'
			},
			body: requestBody
		});
	}

	private static errorResult(
		model: string,
		startTime: number,
		status: number,
		error: { message: string; type: string; code?: string },
		headers: Record<string, string> = {}
	): ProxyOpenAiResult {
		return {
			response: new Response(JSON.stringify({ error }), {
				status,
				headers: { ...headers, 'Content-Type': 'application/json' }
			}),
			context: this.errorContext(model, startTime)
		};
	}

	/** Keeps upstream status, message, error type/code and safe retry hints; drops stale length/encoding. */
	private static async upstreamErrorResult(response: Response, model: string, startTime: number): Promise<ProxyOpenAiResult> {
		const errorText = await response.text().catch(() => '');
		logger.error('ChatGPT Codex upstream error:', response.status, errorText.slice(0, 2000));
		const error = this.parseUpstreamError(response.status, errorText);

		return this.errorResult(model, startTime, response.status, error, AccountFallback.safeRetryHeaders(response.headers));
	}

	private static parseUpstreamError(status: number, errorText: string): { message: string; type: string; code?: string } {
		let message = `ChatGPT API error (${status})`;
		let type = 'api_error';
		let code: string | undefined;

		try {
			const errBody = JSON.parse(errorText) as {
				error?: { message?: unknown; type?: unknown; code?: unknown };
				message?: unknown;
				detail?: unknown;
			};
			const candidate = [errBody.error?.message, errBody.message, errBody.detail].find(
				(value): value is string => typeof value === 'string' && value.trim() !== ''
			);

			if (candidate) message = candidate;
			if (typeof errBody.error?.type === 'string' && errBody.error.type) type = errBody.error.type;
			if (typeof errBody.error?.code === 'string' && errBody.error.code) code = errBody.error.code;
		} catch {
			if (errorText.trim()) {
				message = `${message}: ${errorText.slice(0, 500)}`;
			}
		}

		return code ? { message, type, code } : { message, type };
	}

	private static async successResult(
		body: OpenAIChatRequest,
		response: Response,
		model: string,
		normalizedModel: string,
		startTime: number,
		telemetry: RequestTelemetry,
		onStreamError: (error: Record<string, unknown> | undefined) => void
	): Promise<ProxyOpenAiResult> {
		const stream = body.stream ?? false;
		// Fresh conversion/tool state for the committed attempt only.
		const state = StreamStateFactory.create(normalizedModel);

		if (stream) {
			const context: RequestContext = { ...this.openAiContext(model, startTime), telemetryDeferred: true, telemetry };

			return { response: this.streamResponse(response, state, context, onStreamError), context };
		}

		const buffered = await this.bufferedResponse(response, state, normalizedModel, onStreamError);
		const context = buffered.failed ? this.errorContext(model, startTime) : this.openAiContext(model, startTime);
		context.inputTokens = state.usage?.prompt_tokens ?? 0;
		context.outputTokens = state.usage?.completion_tokens ?? 0;
		context.telemetry = { ...telemetry, ...StreamDiagnostics.telemetry(state, buffered.failed ? 'failed' : undefined) };

		return { response: buffered.response, context };
	}

	/**
	 * Converts the committed Codex SSE body to OpenAI chunks. Post-commit failures are never
	 * replayed: `response.failed` / `error` reach the client as an error event without `[DONE]`,
	 * and a stream ending without any terminal event is reported as an error, not success.
	 * Records exactly one analytics row with the terminal outcome when the stream ends.
	 */
	private static streamResponse(
		response: Response,
		state: StreamState,
		context: RequestContext,
		onStreamError: (error: Record<string, unknown> | undefined) => void
	): Response {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let cancelled = false;
		let recorded = false;

		const recordOutcome = (error?: string, aborted = false) => {
			if (recorded) return;
			recorded = true;
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
		};

		const streamBody = new ReadableStream<string>({
			async start(controller) {
				const emit = (text: string) => {
					if (!cancelled) controller.enqueue(text);
				};

				try {
					while (!cancelled && !state.terminal) {
						const { done, value } = await reader.read();
						if (done || cancelled) break;

						for (const result of ResponsesSseProcessor.process(state, decoder.decode(value, { stream: true }))) {
							if (result.type === 'chunk') {
								emit(`data: ${JSON.stringify(result.data)}\n\n`);
							} else if (result.type === 'done') {
								emit('data: [DONE]\n\n');
							} else {
								onStreamError(result.upstreamError);
								emit(`data: ${JSON.stringify(result.data)}\n\n`);
							}
						}
					}

					if (cancelled) return;
					if (state.terminal === 'failed') {
						recordOutcome(state.failure?.message ?? 'ChatGPT stream failed');
					} else if (!state.terminal) {
						const message = 'ChatGPT stream ended before completion';
						logger.error(`[Codex] ${message}`);
						emit(`data: ${JSON.stringify({ error: { message, type: 'api_error', code: 'stream_incomplete' } })}\n\n`);
						recordOutcome(message);
					} else {
						recordOutcome();
					}
					StreamDiagnostics.logFinished(state, 'stream');
					controller.close();
				} catch (error) {
					if (cancelled) return;
					logger.error(`[Codex] stream processing failed: ${String(error)}`);
					recordOutcome(`Stream processing failed: ${String(error)}`);
					controller.error(error);
				} finally {
					// Stops the upstream body after a terminal event or failure (no-op when already done).
					await reader.cancel().catch(() => undefined);
				}
			},
			cancel(reason) {
				cancelled = true;
				logger.log(`[Codex] downstream cancelled stream: ${String(reason)}`);
				recordOutcome('Client cancelled stream', true);

				return reader.cancel(reason).catch(() => undefined);
			}
		});

		return new Response(streamBody, {
			status: 200,
			headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
		});
	}

	/**
	 * Buffered (non-streaming) completion from the always-SSE Codex upstream. `response.failed` /
	 * `error` / a missing terminal event become an OpenAI error response (429 for a recognized
	 * usage limit, which also cools the account down; 502 otherwise) instead of an empty success.
	 * `response.incomplete` keeps the partial text with `finish_reason: "length"`.
	 */
	private static async bufferedResponse(
		response: Response,
		state: StreamState,
		normalizedModel: string,
		onStreamError: (error: Record<string, unknown> | undefined) => void
	): Promise<{ response: Response; failed: boolean }> {
		let fullContent = '';
		let finishReason = 'stop';
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();

		try {
			while (!state.terminal) {
				const { done, value } = await reader.read();

				if (done) {
					break;
				}

				for (const result of ResponsesSseProcessor.process(state, decoder.decode(value, { stream: true }))) {
					if (result.type === 'error') {
						onStreamError(result.upstreamError);
						continue;
					}
					if (result.type !== 'chunk') continue;
					const choice = (result.data as { choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[] })
						?.choices?.[0];
					if (typeof choice?.delta?.content === 'string') fullContent += choice.delta.content;
					if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
				}
			}
		} finally {
			await reader.cancel().catch(() => undefined);
		}

		StreamDiagnostics.logFinished(state, 'buffer');

		if (state.terminal === 'failed' || !state.terminal) {
			const failure = state.failure ?? {
				message: 'ChatGPT stream ended before completion',
				type: 'api_error',
				code: 'stream_incomplete'
			};
			const limited =
				UsageLimitClassifier.classifyStreamError('openai', response.headers, failure.upstream).kind === 'usage_limit';
			const error = failure.code
				? { message: failure.message, type: failure.type, code: failure.code }
				: { message: failure.message, type: failure.type };

			return {
				response: new Response(JSON.stringify({ error }), {
					status: limited ? 429 : 502,
					headers: { 'Content-Type': 'application/json' }
				}),
				failed: true
			};
		}

		return {
			response: new Response(
				JSON.stringify({
					id: state.id,
					object: 'chat.completion',
					created: state.created,
					model: normalizedModel,
					choices: [{ index: 0, message: { role: 'assistant', content: fullContent || null }, finish_reason: finishReason }],
					usage: StreamChunkMapper.openAiUsage(state.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				}
			),
			failed: false
		};
	}

	private static errorContext(model: string, startTime: number): RequestContext {
		return { model, source: 'error', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 };
	}

	private static openAiContext(model: string, startTime: number): RequestContext {
		return { model, source: 'openai', startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 };
	}
}

import { createHash, randomUUID } from 'node:crypto';

import { logger } from 'src/utils/logger';

import { buildGeminiRequest, type GeminiGenerateRequest } from '../adapter/openai-to-gemini';
import { GeminiOAuthService } from '../auth/gemini/gemini-oauth-service';
import { config } from '../config';
import { Settings } from '../database/app-settings';
import { GeminiStreamConverter, GeminiStreamHandler } from '../streaming/gemini-stream-handler';

import { AccountFallback } from './account-fallback';
import { SsePrecommitGate } from './sse-precommit-gate';
import { UsageLimitClassifier } from './usage-limit-classifier';

import type { OAuthCredentials } from '../auth/base-provider';
import type { OpenAIChatRequest } from '../types/openai';
import type { RequestContext } from '../types/proxy';
import type { ModelMappingConfig, RequestTelemetry } from '@ungate/shared';

interface GeminiProxyResult {
	response: Response;
	context: RequestContext;
}

interface GeminiError {
	message: string;
	type: string;
	code?: string;
}

/**
 * Gemini through Antigravity (`daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`).
 * Always streams upstream; non-streaming requests are buffered here. Each attempt is pinned to one
 * Google account and its managed Code Assist project (`providerAccountId`).
 */
export class GeminiClient {
	static async proxy(body: OpenAIChatRequest, mapping: ModelMappingConfig, signal?: AbortSignal): Promise<GeminiProxyResult> {
		const startTime = Date.now();
		const model = body.model;
		const request = buildGeminiRequest(body, {
			reasoningBudget: mapping.reasoningBudget,
			extraInstruction: Settings.get().extraInstruction
		});
		const userPromptId = randomUUID();
		logger.log(
			`Gemini proxy: ${model} → ${mapping.upstreamModel} contents=${request.contents.length} tools=${request.tools?.[0]?.functionDeclarations.length ?? 0} thinking=${request.generationConfig.thinkingConfig.thinkingLevel} stream=${body.stream ?? false}`
		);
		let missingProject = false;
		let outcome: Awaited<ReturnType<typeof AccountFallback.run<OAuthCredentials>>>;

		try {
			outcome = await AccountFallback.run<OAuthCredentials>({
				provider: 'gemini',
				getCredentials: async (localAccountId) => {
					const creds = await GeminiOAuthService.getValidToken(localAccountId);
					if (creds?.accessToken && !creds.accountId) missingProject = true;

					return creds?.accessToken && creds.accountId ? creds : null;
				},
				send: (creds) => this.sendPinned(mapping.upstreamModel, userPromptId, request, creds, signal),
				inspect: SsePrecommitGate.inspector('gemini', { signal }),
				signal
			});
		} catch (error) {
			if (signal?.aborted) {
				logger.log('Gemini request aborted by client; fallback stopped');

				return this.errorResult(model, startTime, 499, { message: 'Client closed request', type: 'client_closed_request' });
			}
			logger.error(`Gemini request failed: ${String(error)}`);

			return this.errorResult(model, startTime, 502, { message: `Gemini request failed: ${String(error)}`, type: 'api_error' });
		}

		if (outcome.kind === 'no_credentials') {
			return this.errorResult(model, startTime, 401, {
				message: missingProject
					? 'Gemini account has no Code Assist project. Reconnect the account in Ungate.'
					: 'Not authenticated with Gemini. Sign in with a Google account in Ungate.',
				type: 'authentication_error'
			});
		}

		if (outcome.kind === 'limited') {
			logger.log(`Gemini usage limit: no eligible account (${outcome.reason})`);
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

			return limited;
		}

		const telemetry: RequestTelemetry = {
			accountId: outcome.accountId,
			attempts: outcome.attempts,
			rotationReason: outcome.rotationReason
		};

		if (!outcome.response.ok) {
			const failed = await this.upstreamErrorResult(outcome.response, model, startTime);
			failed.context.telemetry = { ...telemetry, stopReason: 'error' };

			return failed;
		}

		const onStreamError = SsePrecommitGate.cooldownOnStreamLimit(
			'gemini',
			outcome.accountId,
			outcome.credentials.credentialVersion,
			outcome.response.headers
		);
		const converter = new GeminiStreamConverter(model);

		if (body.stream) {
			const context: RequestContext = { ...this.context(model, startTime, 'gemini'), telemetryDeferred: true, telemetry };

			return { response: GeminiStreamHandler.createStreamResponse(outcome.response, converter, context, onStreamError), context };
		}

		const ok = await GeminiStreamHandler.drain(outcome.response, converter, onStreamError);
		const context = this.context(model, startTime, ok ? 'gemini' : 'error');
		context.inputTokens = converter.usage?.promptTokens ?? 0;
		context.outputTokens = converter.usage?.completionTokens ?? 0;
		context.telemetry = { ...telemetry, ...converter.telemetry(ok ? undefined : 'failed') };
		if (ok) {
			return {
				response: new Response(JSON.stringify(converter.completion()), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				}),
				context
			};
		}

		const failure = converter.failure ?? {
			message: 'Gemini stream ended before completion',
			type: 'api_error',
			code: 'stream_incomplete'
		};
		const limited =
			UsageLimitClassifier.classifyStreamError('gemini', outcome.response.headers, failure.upstream).kind === 'usage_limit';
		const error: GeminiError = failure.code
			? { message: failure.message, type: failure.type, code: failure.code }
			: { message: failure.message, type: failure.type };

		return {
			response: new Response(JSON.stringify({ error }), {
				status: limited ? 429 : 502,
				headers: { 'Content-Type': 'application/json' }
			}),
			context
		};
	}

	/** One attempt pinned to `creds`' account and project, with one same-account refresh retry on 401. */
	private static async sendPinned(
		upstreamModel: string,
		userPromptId: string,
		request: GeminiGenerateRequest,
		creds: OAuthCredentials,
		signal?: AbortSignal
	): Promise<{ response: Response; credentials: OAuthCredentials }> {
		const response = await this.fetchStream(upstreamModel, userPromptId, request, creds, signal);
		if (response.status !== 401 || !creds.localAccountId) return { response, credentials: creds };

		await response.body?.cancel().catch(() => undefined);
		logger.log(`Gemini 401: refreshing token for account ${creds.localAccountId}`);
		const refreshed = await GeminiOAuthService.refreshAccountToken(creds.localAccountId, creds.credentialVersion);
		if (!refreshed?.accessToken || !refreshed.accountId) {
			return {
				response: new Response(
					JSON.stringify({ error: { message: 'Gemini OAuth token invalid', type: 'authentication_error' } }),
					{ status: 401, headers: { 'content-type': 'application/json' } }
				),
				credentials: creds
			};
		}

		return { response: await this.fetchStream(upstreamModel, userPromptId, request, refreshed, signal), credentials: refreshed };
	}

	private static fetchStream(
		upstreamModel: string,
		userPromptId: string,
		request: GeminiGenerateRequest,
		creds: OAuthCredentials,
		signal?: AbortSignal
	): Promise<Response> {
		return fetch(`${config.gemini.codeAssistUrl}:streamGenerateContent?alt=sse`, {
			signal,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
				Authorization: `Bearer ${creds.accessToken}`,
				'User-Agent': config.gemini.userAgent
			},
			body: JSON.stringify({
				model: upstreamModel,
				project: creds.accountId,
				userAgent: 'antigravity',
				requestType: 'agent',
				requestId: `agent-${userPromptId}`,
				request: { ...request, sessionId: this.sessionId(request, userPromptId) }
			})
		});
	}

	private static sessionId(request: GeminiGenerateRequest, fallback: string): string {
		const firstUserText = request.contents.find((content) => content.role === 'user')?.parts.find((part) => part.text)?.text;
		const digest = createHash('sha256')
			.update(firstUserText ?? fallback)
			.digest();

		return `-${digest.readBigUInt64BE(0) & 0x7fffffffffffffffn}`;
	}

	/** Keeps the upstream status, the google.rpc message/status and safe retry hints. */
	private static async upstreamErrorResult(response: Response, model: string, startTime: number): Promise<GeminiProxyResult> {
		const text = await response.text().catch(() => '');
		logger.error('Gemini upstream error:', response.status, text.slice(0, 2000));

		return this.errorResult(
			model,
			startTime,
			response.status,
			this.parseUpstreamError(response.status, text),
			AccountFallback.safeRetryHeaders(response.headers)
		);
	}

	static parseUpstreamError(status: number, text: string): GeminiError {
		let message = `Gemini API error (${status})`;
		let code: string | undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			const root = (Array.isArray(parsed) ? parsed[0] : parsed) as
				| { error?: { message?: unknown; status?: unknown } }
				| undefined;
			if (typeof root?.error?.message === 'string' && root.error.message.trim()) message = root.error.message;
			if (typeof root?.error?.status === 'string' && root.error.status) code = root.error.status.toLowerCase();
		} catch {
			if (text.trim()) message = `${message}: ${text.slice(0, 500)}`;
		}
		const type =
			status === 401
				? 'authentication_error'
				: status === 403
					? 'permission_error'
					: status === 429
						? 'rate_limit_error'
						: status >= 400 && status < 500
							? 'invalid_request_error'
							: 'api_error';

		return code ? { message, type, code } : { message, type };
	}

	private static errorResult(
		model: string,
		startTime: number,
		status: number,
		error: GeminiError,
		headers: Record<string, string> = {}
	): GeminiProxyResult {
		return {
			response: new Response(JSON.stringify({ error }), { status, headers: { ...headers, 'Content-Type': 'application/json' } }),
			context: this.context(model, startTime, 'error')
		};
	}

	private static context(model: string, startTime: number, source: 'gemini' | 'error'): RequestContext {
		return { model, source, startTime, reverseToolMapping: {}, inputTokens: 0, outputTokens: 0 };
	}
}

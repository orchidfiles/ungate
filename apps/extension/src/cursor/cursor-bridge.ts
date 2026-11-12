import {
	CURSOR_BRIDGE_CHANNEL,
	CURSOR_BRIDGE_MAX_REQUEST_BYTES,
	isCursorBridgeMessage,
	type CursorBridgeError,
	type CursorBridgeEventBody,
	type CursorBridgeRequest,
	type CursorInferenceRequest,
	type CursorSessionStatus
} from '@ungate/shared';

import { CursorModelsError, fetchUsableModels } from './models';
import { PacerTimeoutError, RequestPacer } from './request-pacer';
import { redactMessage, runInference } from './run-inference';

import type { Http2Connect } from './connect-transport';
import type { CursorSession } from './cursor-session';

/** The subset of `ChildProcess` the bridge needs; lets tests use a fake child. */
export interface BridgeChild {
	send?: (message: never) => boolean;
	connected?: boolean;
	on(event: 'message', listener: (message: unknown) => void): unknown;
	on(event: 'exit' | 'disconnect', listener: () => void): unknown;
	off(event: 'message', listener: (message: unknown) => void): unknown;
	off(event: 'exit' | 'disconnect', listener: () => void): unknown;
}

export interface CursorBridgeOptions {
	session: CursorSession;
	/** Reads the opt-in flag fresh (runtime state file). */
	isEnabled: () => boolean;
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
	connect?: Http2Connect;
	pacer?: RequestPacer;
	/** Overrides `CURSOR_PACING.retryDelaysMs` (tests). */
	retryDelaysMs?: readonly number[];
}

const MAX_ACTIVE_REQUESTS = 32;

/**
 * Cursor (and xAI behind it for Grok) rejects bursts per model with `resource_exhausted`.
 * Cursor's agent fires tool-loop steps back to back, so starts are paced per model.
 */
export const CURSOR_PACING = {
	maxConcurrentPerModel: 2,
	minIntervalMs: 1_000,
	/** Below the API's 120 s idle timeout so a queued request still fails cleanly. */
	maxWaitMs: 90_000,
	/** Backoff before retry n (1-based) of a run rate-limited before any output. */
	retryDelaysMs: [2_000, 6_000] as readonly number[],
	/** Lane cooldown after a rate limit that cannot be retried (output already sent). */
	cooldownMs: 5_000
};

const RETRYABLE_BEFORE_OUTPUT = new Set(['rate_limit', 'overloaded']);
const OUTPUT_KINDS = new Set(['text', 'thinking', 'toolCall']);

/**
 * Serves Cursor inference to the API child this window spawned, over the child's private IPC
 * channel. Credentials are read here per request and never leave the extension host: only
 * decoded model output, sanitized errors and the safe status DTO are sent back.
 */
export class CursorBridge {
	private child: BridgeChild | null = null;
	private readonly active = new Map<string, AbortController>();
	private readonly onMessage = (message: unknown) => this.handle(message);
	private readonly onChildGone = () => this.detach();
	private readonly pacer: RequestPacer;

	constructor(private readonly options: CursorBridgeOptions) {
		this.pacer =
			options.pacer ??
			new RequestPacer({
				maxConcurrent: CURSOR_PACING.maxConcurrentPerModel,
				minIntervalMs: CURSOR_PACING.minIntervalMs,
				maxWaitMs: CURSOR_PACING.maxWaitMs
			});
	}

	attach(child: BridgeChild): void {
		this.detach();
		this.child = child;
		child.on('message', this.onMessage);
		child.on('exit', this.onChildGone);
		child.on('disconnect', this.onChildGone);
	}

	detach(): void {
		const child = this.child;
		this.child = null;
		if (child) {
			child.off('message', this.onMessage);
			child.off('exit', this.onChildGone);
			child.off('disconnect', this.onChildGone);
		}
		this.cancelAll();
	}

	isAttached(): boolean {
		return this.child !== null;
	}

	/** Cancels every in-flight invocation, e.g. when the user disconnects. */
	cancelAll(): void {
		for (const controller of this.active.values()) controller.abort();
		this.active.clear();
	}

	status(): CursorSessionStatus {
		const { session } = this.options;

		if (!this.child) return { available: false, connected: false, reason: 'no_bridge', membershipType: null };
		if (!session.hasApi()) return { available: false, connected: false, reason: 'no_cursor_api', membershipType: null };
		if (!this.options.isEnabled()) return { available: true, connected: false, reason: 'disabled', membershipType: null };
		if (!session.isSignedIn()) return { available: true, connected: false, reason: 'not_signed_in', membershipType: null };

		return { available: true, connected: true, reason: 'ok', membershipType: session.membershipType() };
	}

	/** Exposed for tests; the IPC listener calls this for every message. */
	handle(message: unknown): void {
		if (!isCursorBridgeMessage(message)) return;
		const request = message as CursorBridgeRequest;

		switch (request.kind) {
			case 'status':
				void this.recoverToken().then(() => this.emit(request.id, { kind: 'status', status: this.status() }));

				return;
			case 'cancel':
				this.active.get(request.id)?.abort();
				this.active.delete(request.id);

				return;
			case 'listModels':
				void this.listModels(request.id);

				return;
			case 'invoke':
				void this.invoke(request.id, request.request);

				return;
			default:
				return;
		}
	}

	/** Re-reads a missing session token from Cursor when the provider is opted in. */
	private async recoverToken(): Promise<void> {
		const { session } = this.options;
		if (!this.child || !session.hasApi() || !this.options.isEnabled()) return;
		await session.ensureSignedIn();
	}

	private async gate(): Promise<CursorBridgeError | null> {
		await this.recoverToken();
		const status = this.status();
		if (status.connected) return null;
		if (status.reason === 'disabled')
			return { kind: 'disabled', message: 'Cursor provider is disabled. Connect it in the Ungate dashboard.' };
		if (status.reason === 'not_signed_in') return { kind: 'auth', message: 'Sign in to Cursor to use Cursor models' };

		return { kind: 'unavailable', message: 'Cursor provider is unavailable in this window' };
	}

	private async listModels(id: string): Promise<void> {
		const blocked = await this.gate();
		if (blocked) {
			this.emit(id, { kind: 'models', models: [], error: blocked });

			return;
		}

		const { session } = this.options;

		const attempt = async () => {
			const creds = session.credentials();
			if (!creds) throw new CursorModelsError('auth', 'Sign in to Cursor to list models');

			return fetchUsableModels(creds, { connect: this.options.connect });
		};

		try {
			let models;
			try {
				models = await attempt();
			} catch (error) {
				if (!(error instanceof CursorModelsError) || error.kind !== 'auth') throw error;
				await session.refresh();
				models = await attempt();
			}
			this.emit(id, { kind: 'models', models, error: null });
		} catch (error) {
			const kind = error instanceof CursorModelsError && error.kind === 'auth' ? 'auth' : 'upstream';
			const message = redactMessage(error instanceof Error ? error.message : 'Failed to list Cursor models');
			this.emit(id, { kind: 'models', models: [], error: { kind, message } });
		}
	}

	private async invoke(id: string, request: CursorInferenceRequest): Promise<void> {
		const gated = await this.gate();
		const blocked = gated ?? this.validate(id, request);
		if (blocked) {
			this.emit(id, { kind: 'end', error: blocked });

			return;
		}

		const controller = new AbortController();
		this.active.set(id, controller);

		try {
			await this.invokePaced(id, request, controller.signal);
		} catch (error) {
			const message = redactMessage(error instanceof Error ? error.message : 'Cursor inference failed');
			this.emit(id, { kind: 'end', error: { kind: 'upstream', message } });
		} finally {
			this.active.delete(id);
		}
	}

	/**
	 * Runs one invocation inside the model's pacing lane. A rate limit or overload that arrives
	 * before any output is retried after a backoff (the API is still waiting for its first
	 * event, so nothing is duplicated); after output it only cools the lane down.
	 */
	private async invokePaced(id: string, request: CursorInferenceRequest, signal: AbortSignal): Promise<void> {
		const { session } = this.options;
		const lane = request.modelId;
		const retries = this.options.retryDelaysMs ?? CURSOR_PACING.retryDelaysMs;

		let readySent = false;

		for (let attempt = 0; ; attempt++) {
			let release;
			try {
				release = await this.pacer.acquire(lane, signal);
			} catch (error) {
				const timedOut = error instanceof PacerTimeoutError;
				this.emit(id, {
					kind: 'end',
					error: timedOut
						? { kind: 'rate_limit', message: 'Too many queued Cursor requests for this model; try again shortly' }
						: { kind: 'cancelled', message: 'Request cancelled' }
				});

				return;
			}

			let outputStarted = false;
			let retryAfter: number | null = null;

			try {
				for await (const event of runInference({
					request,
					credentials: () => session.credentials(),
					refresh: () => session.refresh(),
					signal,
					connect: this.options.connect,
					onLog: this.options.onLog
				})) {
					if (event.kind === 'end' && event.error && !outputStarted && !signal.aborted) {
						if (RETRYABLE_BEFORE_OUTPUT.has(event.error.kind) && attempt < retries.length) {
							retryAfter = retries[attempt];
							this.pacer.penalize(lane, retryAfter);
							this.options.onLog?.(
								'info',
								`[cursor] ${lane} ${event.error.kind} before output, retrying in ${retryAfter} ms (${attempt + 1}/${retries.length})`
							);
							break;
						}
					}

					if (event.kind === 'end' && event.error?.kind === 'rate_limit') {
						this.pacer.penalize(lane, CURSOR_PACING.cooldownMs);
					}

					// A retried run produces a second `ready`; the API only expects one.
					if (event.kind === 'ready') {
						if (readySent) continue;
						readySent = true;
					}
					if (OUTPUT_KINDS.has(event.kind)) outputStarted = true;

					if (!this.emit(id, event)) {
						this.active.get(id)?.abort();
					}
					if (event.kind === 'end' && event.error && event.error.kind !== 'cancelled') {
						this.options.onLog?.('warn', `[cursor] inference failed (${event.error.kind}): ${event.error.message}`);
					}
				}
			} finally {
				release();
			}

			// The penalty above holds the lane, so the next `acquire` waits out the backoff.
			if (retryAfter === null) return;
		}
	}

	private validate(id: string, request: CursorInferenceRequest): CursorBridgeError | null {
		if (this.active.has(id)) return { kind: 'upstream', message: 'Duplicate bridge request id' };
		if (this.active.size >= MAX_ACTIVE_REQUESTS) return { kind: 'rate_limit', message: 'Too many concurrent Cursor requests' };
		if (
			!request ||
			typeof request.modelId !== 'string' ||
			!request.modelId ||
			!Array.isArray(request.messages) ||
			!Array.isArray(request.tools)
		) {
			return { kind: 'upstream', message: 'Malformed Cursor inference request' };
		}

		let size = 0;
		try {
			size = Buffer.byteLength(JSON.stringify(request));
		} catch {
			return { kind: 'upstream', message: 'Cursor inference request is not serializable' };
		}

		if (size > CURSOR_BRIDGE_MAX_REQUEST_BYTES)
			return { kind: 'input_too_long', message: 'Request is too large for the Cursor bridge' };

		return null;
	}

	private emit(id: string, body: CursorBridgeEventBody): boolean {
		const child = this.child;
		if (!child?.send || child.connected === false) return false;

		try {
			// `send` returning false only signals backpressure; the message is still queued.
			(child.send as (message: unknown) => boolean)({ channel: CURSOR_BRIDGE_CHANNEL, id, ...body });

			return true;
		} catch {
			return false;
		}
	}
}

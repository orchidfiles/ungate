import { randomUUID } from 'node:crypto';

import {
	CURSOR_BRIDGE_CHANNEL,
	isCursorBridgeMessage,
	type CursorBridgeError,
	type CursorBridgeEvent,
	type CursorBridgeEventBody,
	type CursorInferenceRequest,
	type CursorModelInfo,
	type CursorSessionStatus
} from '@ungate/shared';

/** The parts of `process` the client uses; injectable for tests. */
export interface BridgeTransport {
	send?: (message: unknown) => boolean;
	on(event: 'message', listener: (message: unknown) => void): unknown;
	off(event: 'message', listener: (message: unknown) => void): unknown;
}

const STATUS_TIMEOUT_MS = 3_000;
const MODELS_TIMEOUT_MS = 20_000;
/** No event at all (not even `ready`) for this long ends the invocation. */
const IDLE_TIMEOUT_MS = 120_000;

const UNAVAILABLE_STATUS: CursorSessionStatus = { available: false, connected: false, reason: 'no_bridge', membershipType: null };

type Listener = (event: CursorBridgeEvent) => void;

/**
 * API-side end of the private IPC bridge to the extension host. Only exists when the API was
 * spawned by an Ungate window with an `ipc` stdio slot; a standalone API reports unavailable.
 */
export class CursorBridgeClient {
	private readonly listeners = new Map<string, Listener>();
	private attached = false;

	constructor(private readonly transport: BridgeTransport = process as unknown as BridgeTransport) {}

	isAvailable(): boolean {
		return typeof this.transport.send === 'function';
	}

	async status(): Promise<CursorSessionStatus> {
		if (!this.isAvailable()) return UNAVAILABLE_STATUS;
		const event = await this.single('status', STATUS_TIMEOUT_MS).catch(() => null);

		return event?.kind === 'status' ? event.status : UNAVAILABLE_STATUS;
	}

	async listModels(): Promise<{ models: CursorModelInfo[]; error: CursorBridgeError | null }> {
		if (!this.isAvailable()) return { models: [], error: { kind: 'unavailable', message: 'Cursor bridge is not attached' } };

		try {
			const event = await this.single('listModels', MODELS_TIMEOUT_MS);
			if (event.kind === 'models') return { models: event.models, error: event.error };
		} catch {
			return { models: [], error: { kind: 'timeout', message: 'Timed out listing Cursor models' } };
		}

		return { models: [], error: { kind: 'upstream', message: 'Unexpected bridge response' } };
	}

	/**
	 * Streams one invocation. Always yields exactly one terminal `end`. Aborting the signal (or
	 * breaking out of the loop) sends `cancel` so the extension aborts the upstream run.
	 */
	async *invoke(request: CursorInferenceRequest, signal?: AbortSignal): AsyncGenerator<CursorBridgeEventBody> {
		if (!this.isAvailable()) {
			yield {
				kind: 'end',
				error: {
					kind: 'unavailable',
					message: 'Cursor provider is only available when the API is started by the Ungate extension'
				}
			};

			return;
		}

		const id = randomUUID();
		const queue: CursorBridgeEventBody[] = [];
		let wake: (() => void) | null = null;
		let finished = false;

		const push = (event: CursorBridgeEventBody) => {
			queue.push(event);
			wake?.();
		};

		this.subscribe(id, (event) => {
			const body: Record<string, unknown> = { ...event };
			delete body.channel;
			delete body.id;
			push(body as CursorBridgeEventBody);
		});

		const onAbort = () => push({ kind: 'end', error: { kind: 'cancelled', message: 'Request cancelled' } });
		signal?.addEventListener('abort', onAbort, { once: true });

		try {
			if (signal?.aborted) {
				yield { kind: 'end', error: { kind: 'cancelled', message: 'Request cancelled' } };

				return;
			}

			if (!this.post({ channel: CURSOR_BRIDGE_CHANNEL, kind: 'invoke', id, request })) {
				yield { kind: 'end', error: { kind: 'unavailable', message: 'Cursor bridge is disconnected' } };

				return;
			}

			while (!finished) {
				if (queue.length === 0) {
					const timedOut = await new Promise<boolean>((resolve) => {
						const timer = setTimeout(() => resolve(true), IDLE_TIMEOUT_MS);
						wake = () => {
							clearTimeout(timer);
							resolve(false);
						};
					});
					wake = null;
					if (timedOut && queue.length === 0) {
						push({ kind: 'end', error: { kind: 'timeout', message: 'Cursor stopped responding' } });
					}
					continue;
				}

				const event = queue.shift()!;
				if (event.kind === 'end') finished = true;
				yield event;
			}
		} finally {
			this.listeners.delete(id);
			signal?.removeEventListener('abort', onAbort);
			if (!finished || signal?.aborted) {
				this.post({ channel: CURSOR_BRIDGE_CHANNEL, kind: 'cancel', id });
			}
		}
	}

	private single(kind: 'status' | 'listModels', timeoutMs: number): Promise<CursorBridgeEvent> {
		const id = randomUUID();

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(id);
				reject(new Error('timeout'));
			}, timeoutMs);

			this.subscribe(id, (event) => {
				clearTimeout(timer);
				this.listeners.delete(id);
				resolve(event);
			});

			if (!this.post({ channel: CURSOR_BRIDGE_CHANNEL, kind, id })) {
				clearTimeout(timer);
				this.listeners.delete(id);
				reject(new Error('disconnected'));
			}
		});
	}

	private subscribe(id: string, listener: Listener): void {
		this.ensureAttached();
		this.listeners.set(id, listener);
	}

	private ensureAttached(): void {
		if (this.attached) return;
		this.attached = true;
		this.transport.on('message', (message) => {
			if (!isCursorBridgeMessage(message)) return;
			this.listeners.get(message.id)?.(message as CursorBridgeEvent);
		});
	}

	private post(message: unknown): boolean {
		try {
			this.transport.send?.(message);

			return true;
		} catch {
			return false;
		}
	}
}

export const cursorBridgeClient = new CursorBridgeClient();

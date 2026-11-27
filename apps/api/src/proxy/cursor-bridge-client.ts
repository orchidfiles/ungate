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

import { ProcessBridgeTransport, SocketBridgeTransport, type BridgeTransport } from './cursor-bridge-transport';

// Session recovery can include three bounded, two-second desktop keyring calls.
const STATUS_TIMEOUT_MS = 10_000;
const MODELS_TIMEOUT_MS = 20_000;
/** No event at all (not even `ready`) for this long ends the invocation. */
const IDLE_TIMEOUT_MS = 120_000;

const UNAVAILABLE_STATUS: CursorSessionStatus = { available: false, connected: false, reason: 'no_bridge', membershipType: null };
const NOT_ATTACHED: CursorBridgeError = {
	kind: 'unavailable',
	message: 'Cursor provider needs an open Cursor window running the Ungate extension'
};
const DISCONNECTED: CursorBridgeError = { kind: 'unavailable', message: 'Cursor bridge is disconnected' };

type Listener = (event: CursorBridgeEvent) => void;

/**
 * API-side end of the bridge to the extension host that owns the Cursor session. The extension is
 * on the other end of `transport` only while a Cursor window serves it; without one every call
 * reports unavailable.
 */
export class CursorBridgeClient {
	private readonly listeners = new Map<string, Listener>();

	constructor(private readonly transport: BridgeTransport) {
		transport.on('message', (message) => {
			if (!isCursorBridgeMessage(message)) return;
			this.listeners.get(message.id)?.(message as CursorBridgeEvent);
		});
		transport.on('disconnect', () => {
			for (const [id, listener] of [...this.listeners]) {
				listener({ channel: CURSOR_BRIDGE_CHANNEL, id, kind: 'end', error: DISCONNECTED });
			}
		});
	}

	isAvailable(): boolean {
		return this.transport.isConnected();
	}

	async status(): Promise<CursorSessionStatus> {
		if (!this.isAvailable()) return UNAVAILABLE_STATUS;
		const event = await this.single('status', STATUS_TIMEOUT_MS).catch(() => null);

		return event?.kind === 'status' ? event.status : UNAVAILABLE_STATUS;
	}

	async listModels(): Promise<{ models: CursorModelInfo[]; error: CursorBridgeError | null }> {
		if (!this.isAvailable()) return { models: [], error: NOT_ATTACHED };

		try {
			const event = await this.single('listModels', MODELS_TIMEOUT_MS);
			if (event.kind === 'models') return { models: event.models, error: event.error };
			if (event.kind === 'end' && event.error) return { models: [], error: event.error };
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
			yield { kind: 'end', error: NOT_ATTACHED };

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

		this.listeners.set(id, (event) => {
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
				yield { kind: 'end', error: DISCONNECTED };

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

			this.listeners.set(id, (event) => {
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

	private post(message: unknown): boolean {
		if (!this.transport.isConnected()) return false;
		try {
			this.transport.send(message);

			return true;
		} catch {
			return false;
		}
	}
}

/**
 * An API the extension spawned talks over its IPC channel; any other run (a systemd service, a
 * terminal) serves a socket the leader window connects to when it adopts the API.
 */
export const bridgeTransport: BridgeTransport =
	typeof process.send === 'function' ? new ProcessBridgeTransport() : new SocketBridgeTransport();

export const cursorBridgeClient = new CursorBridgeClient(bridgeTransport);

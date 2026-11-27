import { randomUUID } from 'node:crypto';

import { assertCursorOrigin } from './connect-transport';

import type { CursorDiskSession } from './cursor-disk-session';

const DEFAULT_BACKEND_URL = 'https://api2.cursor.sh';
const DEFAULT_AGENT_URL = 'https://agentn.api5.cursor.sh';
const TOKEN_RECOVERY_INTERVAL_MS = 10_000;

/** Everything needed for one upstream call. Lives only in the extension host, never serialized. */
export interface CursorRequestCredentials {
	headers: Record<string, string>;
	backendUrl: string;
	agentUrl: string;
	inferenceUrl: string;
}

interface CursorApi {
	getCursorCreds?: () => unknown;
	getCursorAuthToken?: () => unknown;
	getAllRequestHeadersExceptAccessToken?: (input: { req: { header: Headers }; backupRequestId: string }) => void;
	triggerRefreshCursorAuthToken?: () => Promise<void> | void;
	membershipType?: () => unknown;
	getPrivacyMode?: () => unknown;
}

function asApi(candidate: unknown): CursorApi | null {
	if (typeof candidate !== 'object' || candidate === null) return null;

	return candidate as CursorApi;
}

function readString(record: unknown, key: string): string | null {
	if (typeof record !== 'object' || record === null) return null;
	const value = (record as Record<string, unknown>)[key];

	return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeOrigin(raw: string | null, fallback: string): string {
	if (!raw) return fallback;

	try {
		return assertCursorOrigin(raw);
	} catch {
		return fallback;
	}
}

/**
 * Reads the signed-in Cursor session, fresh for every request so token rotation is picked up.
 * Prefers the internal `vscode.cursor` API; Cursor ≥ 3.29 makes every call on it throw for
 * non-builtin extensions, and then the session falls back to Cursor's persisted state on disk.
 * Nothing read here is logged or returned to the API child.
 */
export class CursorSession {
	private readonly api: CursorApi | null;
	private lastRecoveryAt = 0;
	/** Flips to false the first time Cursor rejects an API call; it never recovers in-process. */
	private apiUsable = true;

	constructor(
		candidate: unknown,
		private readonly disk: CursorDiskSession | null = null
	) {
		this.api = asApi(candidate);
	}

	hasApi(): boolean {
		return this.hasCursorApi() || this.disk !== null;
	}

	isSignedIn(): boolean {
		return this.readToken() !== null;
	}

	/**
	 * Cursor's extension host caches the token at startup and stops polling after 30 s, so a
	 * window whose auth loaded late keeps reporting `undefined` until the next login change.
	 * When the cached value is missing, ask Cursor to re-read it (throttled) before giving up.
	 * The disk snapshot is refreshed here too (it self-throttles).
	 */
	async ensureSignedIn(): Promise<boolean> {
		await this.disk?.refresh();
		if (this.isSignedIn()) return true;
		const now = Date.now();
		if (now - this.lastRecoveryAt < TOKEN_RECOVERY_INTERVAL_MS) return false;
		this.lastRecoveryAt = now;
		await this.refresh();

		return this.isSignedIn();
	}

	/** No usable token because Cursor encrypted the persisted one and the API is blocked. */
	tokenEncrypted(): boolean {
		return this.readToken() === null && (this.disk?.tokenEncrypted() ?? false);
	}

	membershipType(): string | null {
		const value = this.callApi(() => this.api?.membershipType?.());
		if (typeof value === 'string' && value.length > 0) return value;

		return this.disk?.current()?.membershipType ?? null;
	}

	/** Builds request headers (auth + Cursor client headers), or null when signed out. */
	credentials(requestId: string = randomUUID()): CursorRequestCredentials | null {
		const apiToken = this.apiToken();
		if (apiToken) {
			const header = new Headers();
			const ok = this.callApi(() => {
				this.api?.getAllRequestHeadersExceptAccessToken?.({ req: { header }, backupRequestId: requestId });

				return true;
			});
			if (ok) return this.finish(Object.fromEntries(header.entries()), apiToken, requestId, this.apiCreds());
		}

		const snap = this.disk?.current();
		if (!snap || !this.disk) return null;

		return this.finish(this.disk.headers(snap, requestId), snap.token, requestId, {
			backendUrl: snap.backendUrl,
			privacyMode: snap.privacyMode === true
		});
	}

	/** Asks Cursor to refresh its session token. Callers invoke this at most once per request. */
	async refresh(): Promise<void> {
		if (this.hasCursorApi()) {
			try {
				await this.api?.triggerRefreshCursorAuthToken?.();
			} catch {
				this.apiUsable = false;
			}
		}
		await this.disk?.refresh(true);
	}

	private hasCursorApi(): boolean {
		return (
			this.apiUsable &&
			this.api !== null &&
			typeof this.api.getCursorAuthToken === 'function' &&
			typeof this.api.getAllRequestHeadersExceptAccessToken === 'function'
		);
	}

	private callApi<T>(run: () => T): T | undefined {
		if (!this.hasCursorApi()) return undefined;

		try {
			return run();
		} catch {
			this.apiUsable = false;

			return undefined;
		}
	}

	private apiToken(): string | null {
		const token = this.callApi(() => this.api?.getCursorAuthToken?.());

		return typeof token === 'string' && token.length > 0 ? token : null;
	}

	private readToken(): string | null {
		return this.apiToken() ?? this.disk?.current()?.token ?? null;
	}

	private apiCreds(): { creds: unknown; privacyMode: boolean } {
		return {
			creds: this.callApi(() => this.api?.getCursorCreds?.()) ?? null,
			privacyMode: this.callApi(() => this.api?.getPrivacyMode?.()) === true
		};
	}

	private finish(
		raw: Record<string, string>,
		token: string,
		requestId: string,
		source: { creds?: unknown; backendUrl?: string | null; privacyMode: boolean }
	): CursorRequestCredentials {
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw)) headers[key.toLowerCase()] = value;
		headers.authorization = `Bearer ${token}`;
		headers['x-request-id'] ??= requestId;
		headers['x-cursor-streaming'] = 'true';

		return { headers, ...this.urls(source) };
	}

	private urls(source: { creds?: unknown; backendUrl?: string | null; privacyMode: boolean }): {
		backendUrl: string;
		agentUrl: string;
		inferenceUrl: string;
	} {
		const creds = source.creds ?? null;
		const backendUrl = safeOrigin(source.backendUrl ?? readString(creds, 'backendUrl'), DEFAULT_BACKEND_URL);
		const record = typeof creds === 'object' && creds !== null ? (creds as Record<string, unknown>) : {};
		const privacyUrl = readString(record.agentBackendUrlPrivacy, 'default');
		const nonPrivacyUrl = readString(record.agentBackendUrlNonPrivacy, 'default');
		const agentRaw = source.privacyMode ? (privacyUrl ?? nonPrivacyUrl) : nonPrivacyUrl;

		// Cursor 3.29.9 cursor-agent-host/dist/main.js assigns RunInference to
		// localLoopInferenceTransport only when HTTP/2 is enabled and the URL has
		// not previously fallen back; otherwise runInferenceBackendTransport ??
		// agenticComposerTransport (backendUrl). Agent Run uses a separate transport.
		// We cannot prove the server/client HTTP/2 or fallback state here, so a
		// localLoopInferenceUrl alone is NOT eligibility. Keep the trusted backend,
		// including in privacy mode; never borrow the non-privacy agent endpoint.
		return { backendUrl, agentUrl: safeOrigin(agentRaw, DEFAULT_AGENT_URL), inferenceUrl: backendUrl };
	}
}

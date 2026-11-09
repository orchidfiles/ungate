import { randomUUID } from 'node:crypto';

import { assertCursorOrigin } from './connect-transport';

const DEFAULT_BACKEND_URL = 'https://api2.cursor.sh';
const DEFAULT_AGENT_URL = 'https://agentn.api5.cursor.sh';
const TOKEN_RECOVERY_INTERVAL_MS = 10_000;

/** Everything needed for one upstream call. Lives only in the extension host, never serialized. */
export interface CursorRequestCredentials {
	headers: Record<string, string>;
	backendUrl: string;
	agentUrl: string;
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
 * Reads the signed-in Cursor session from the internal `vscode.cursor` API, fresh for every
 * request so token rotation is picked up. Nothing read here is cached, logged or returned to
 * the API child.
 */
export class CursorSession {
	private readonly api: CursorApi | null;
	private lastRecoveryAt = 0;

	constructor(candidate: unknown) {
		this.api = asApi(candidate);
	}

	hasApi(): boolean {
		return (
			this.api !== null &&
			typeof this.api.getCursorAuthToken === 'function' &&
			typeof this.api.getAllRequestHeadersExceptAccessToken === 'function'
		);
	}

	isSignedIn(): boolean {
		return this.readToken() !== null;
	}

	/**
	 * Cursor's extension host caches the token at startup and stops polling after 30 s, so a
	 * window whose auth loaded late keeps reporting `undefined` until the next login change.
	 * When the cached value is missing, ask Cursor to re-read it (throttled) before giving up.
	 */
	async ensureSignedIn(): Promise<boolean> {
		if (this.isSignedIn()) return true;
		const now = Date.now();
		if (now - this.lastRecoveryAt < TOKEN_RECOVERY_INTERVAL_MS) return false;
		this.lastRecoveryAt = now;
		await this.refresh();

		return this.isSignedIn();
	}

	membershipType(): string | null {
		try {
			const value = this.api?.membershipType?.();

			return typeof value === 'string' && value.length > 0 ? value : null;
		} catch {
			return null;
		}
	}

	/** Builds request headers (auth + Cursor client headers), or null when signed out. */
	credentials(requestId: string = randomUUID()): CursorRequestCredentials | null {
		if (!this.hasApi()) return null;
		const token = this.readToken();
		if (!token) return null;

		const header = new Headers();

		try {
			this.api?.getAllRequestHeadersExceptAccessToken?.({ req: { header }, backupRequestId: requestId });
		} catch {
			return null;
		}

		const headers: Record<string, string> = {};
		header.forEach((value, key) => {
			headers[key.toLowerCase()] = value;
		});
		headers.authorization = `Bearer ${token}`;
		headers['x-request-id'] ??= requestId;
		headers['x-cursor-streaming'] = 'true';

		return { headers, ...this.urls() };
	}

	/** Asks Cursor to refresh its session token. Callers invoke this at most once per request. */
	async refresh(): Promise<void> {
		try {
			await this.api?.triggerRefreshCursorAuthToken?.();
		} catch {
			// The next credentials() read reports whether a token is available.
		}
	}

	private readToken(): string | null {
		try {
			const token = this.api?.getCursorAuthToken?.();

			return typeof token === 'string' && token.length > 0 ? token : null;
		} catch {
			return null;
		}
	}

	private urls(): { backendUrl: string; agentUrl: string } {
		let creds: unknown = null;

		try {
			creds = this.api?.getCursorCreds?.() ?? null;
		} catch {
			creds = null;
		}

		const backendUrl = safeOrigin(readString(creds, 'backendUrl'), DEFAULT_BACKEND_URL);
		const record = typeof creds === 'object' && creds !== null ? (creds as Record<string, unknown>) : {};
		const privacy = this.privacyModeOn();
		const privacyUrl = readString(record.agentBackendUrlPrivacy, 'default');
		const nonPrivacyUrl = readString(record.agentBackendUrlNonPrivacy, 'default');
		const agentRaw = privacy ? (privacyUrl ?? nonPrivacyUrl) : nonPrivacyUrl;

		return { backendUrl, agentUrl: safeOrigin(agentRaw, DEFAULT_AGENT_URL) };
	}

	private privacyModeOn(): boolean {
		try {
			return this.api?.getPrivacyMode?.() === true;
		} catch {
			return false;
		}
	}
}

import { randomBytes } from 'node:crypto';

import { OAuthAccounts, type LoginAccountSnapshot } from '../database/oauth-accounts';

import type { AccountLoginSession, SubscriptionProvider } from '@ungate/shared';

export interface LoginSessionRecord {
	result: AccountLoginSession;
	verifier: string;
	snapshot: LoginAccountSnapshot;
	reconnectId?: string;
	exchanging: boolean;
}

/** Claude's manual CODE#STATE copy needs more time than OpenAI's automatic callback (10 min listener). */
const SESSION_TTL_MS: Record<SubscriptionProvider, number> = { claude: 15 * 60_000, openai: 10 * 60_000 };

export class AccountNotFoundError extends Error {}

/** Thrown when another login for the same provider is still pending (OpenAI owns one callback listener). */
export class LoginConflictError extends Error {
	constructor(readonly pendingSessionId: string) {
		super('Another login is already pending; cancel it first');
	}
}

/** In-memory, time-bounded OAuth capability store. Status DTOs contain no PKCE material. */
export class AccountLoginSessions {
	private static sessions = new Map<string, LoginSessionRecord>();

	static {
		setInterval(() => this.prune(), 60_000).unref();
	}

	static create(provider: SubscriptionProvider, verifier: string, reconnectId?: string): LoginSessionRecord {
		this.prune();
		const snapshot = OAuthAccounts.list(provider);
		if (reconnectId && !snapshot.some((row) => row.id === reconnectId)) throw new AccountNotFoundError('Account not found');
		const sessionId = randomBytes(32).toString('base64url');
		const record: LoginSessionRecord = {
			result: {
				sessionId,
				provider,
				status: 'pending',
				expiresAt: Date.now() + SESSION_TTL_MS[provider],
				...(reconnectId && { reconnectAccountId: reconnectId })
			},
			verifier,
			snapshot,
			reconnectId,
			exchanging: false
		};
		this.sessions.set(sessionId, record);

		return record;
	}

	static get(id: string, provider: SubscriptionProvider): LoginSessionRecord | undefined {
		this.prune();
		const session = this.sessions.get(id);

		return session?.result.provider === provider ? session : undefined;
	}

	static status(id: string, provider: SubscriptionProvider): AccountLoginSession | undefined {
		const session = this.get(id, provider);

		return session ? { ...session.result } : undefined;
	}

	static hasPending(provider: SubscriptionProvider): boolean {
		return this.findPending(provider) !== undefined;
	}

	static findPending(provider: SubscriptionProvider): string | undefined {
		this.prune();

		return [...this.sessions.values()].find(
			(session) => session.result.provider === provider && session.result.status === 'pending'
		)?.result.sessionId;
	}

	/** Test helper: drops all sessions. */
	static reset(): void {
		this.sessions.clear();
	}

	static claim(id: string, provider: SubscriptionProvider): LoginSessionRecord | undefined {
		const session = this.get(id, provider);
		if (session?.result.status !== 'pending' || session.exchanging) return undefined;
		session.exchanging = true;

		return session;
	}

	static pending(record: LoginSessionRecord): boolean {
		this.prune();

		return record.result.status === 'pending';
	}

	static finish(record: LoginSessionRecord, accountId?: string, error?: string): void {
		if (!this.pending(record)) return;
		record.result = { ...record.result, status: error ? 'failed' : 'succeeded', accountId, error };
		record.verifier = '';
		record.snapshot = [];
	}

	static cancel(id: string, provider: SubscriptionProvider): boolean {
		const record = this.get(id, provider);
		if (!record) return false;
		if (record.result.status === 'pending') {
			record.result.status = 'cancelled';
			record.verifier = '';
			record.snapshot = [];
		}

		return true;
	}

	private static prune(): void {
		const now = Date.now();
		for (const [id, record] of this.sessions) {
			if (now >= record.result.expiresAt && record.result.status === 'pending') {
				record.result.status = 'failed';
				record.result.error = 'Login session expired';
				record.verifier = '';
				record.snapshot = [];
			}
			if (now >= record.result.expiresAt + 30 * 60_000) this.sessions.delete(id);
		}
	}
}

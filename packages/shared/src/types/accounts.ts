export type SubscriptionProvider = 'claude' | 'openai';
export type AccountAvailability = 'available' | 'cooling_down' | 'needs_login';

/** Provider names in `GET /v1/pool`; the `openai` subscription pool is reported as `chatgpt`. */
export type PoolProviderName = 'claude' | 'chatgpt';

/** One provider's account pool, counts only: no account identities. */
export interface PoolProviderHealth {
	provider: PoolProviderName;
	/** Accounts a request could use now. */
	eligible: number;
	cooling_down: number;
	needs_login: number;
	/** RFC 3339 time the earliest cooling-down account lifts, or null when none is cooling down. */
	earliest_reset: string | null;
}

/** `GET /v1/pool`; providers with no saved accounts are omitted. */
export interface PoolHealthResponse {
	providers: PoolProviderHealth[];
}

/** Safe for dashboards: never includes OAuth tokens. Times are Unix milliseconds. */
export interface SubscriptionAccount {
	id: string;
	provider: SubscriptionProvider;
	label: string;
	email: string | null;
	providerUserId: string | null;
	providerAccountId: string | null;
	createdAt: number;
	updatedAt: number;
	active: boolean;
	availability: AccountAvailability;
	cooldownUntil: number | null;
	cooldownReason: string | null;
	cooldownEstimated: boolean;
	/** Last known subscription usage; null until a usage fetch or proxied response reported it. */
	usage: AccountUsage | null;
}

/** One subscription rate-limit window (e.g. Claude's 5-hour window, ChatGPT's weekly window). */
export interface UsageWindow {
	/** '5h' | '7d' | '7d_opus' | '7d_sonnet' | … for Claude; 'primary' | 'secondary' for ChatGPT. */
	id: string;
	/** Human-readable name, e.g. "5-hour", "Weekly", "Weekly (Opus)". */
	label: string;
	/** 0–100. */
	usedPercent: number;
	/** Unix ms when the window resets, when known. */
	resetsAt: number | null;
	windowMinutes: number | null;
}

export interface AccountUsage {
	windows: UsageWindow[];
	planType: string | null;
	/** Where the most recent update came from. */
	source: 'endpoint' | 'headers';
	/** Unix ms of the most recent update. */
	updatedAt: number;
	/** Last live-fetch error; previously known windows are kept. */
	error: string | null;
}

export interface AccountUsageRefreshRequest {
	accountId?: string;
}

export interface AccountPolicy {
	provider: SubscriptionProvider;
	activeAccountId: string | null;
	autoSwitch: boolean;
	revision: number;
	lastSwitchReason: string | null;
}

export interface AccountListResponse {
	accounts: SubscriptionAccount[];
	policy: AccountPolicy;
}

export interface AccountRenameRequest {
	label: string;
}
export interface AccountSelectRequest {
	revision?: number;
}
export interface AccountPolicyRequest {
	autoSwitch: boolean;
	revision?: number;
}
export interface AccountLoginStartRequest {
	accountId?: string;
}
export interface AccountLoginStartResponse {
	authUrl: string;
	sessionId: string;
}
export interface AccountLoginCompleteRequest {
	code: string;
	sessionId: string;
}
export interface AccountLoginCompleteResponse {
	ok: boolean;
	email?: string;
	accountId?: string;
	error?: string;
}
export type AccountLoginState = 'pending' | 'succeeded' | 'failed' | 'cancelled';
export interface AccountLoginSession {
	sessionId: string;
	provider: SubscriptionProvider;
	status: AccountLoginState;
	/** Local account ID saved or updated by a succeeded login. */
	accountId?: string;
	/** Present when the login was started as a reconnect of this local account. */
	reconnectAccountId?: string;
	error?: string;
	expiresAt: number;
}
export type AccountErrorCode =
	| 'invalid_request'
	| 'account_not_found'
	| 'session_not_found'
	| 'account_unavailable'
	| 'revision_conflict'
	| 'login_pending'
	| 'login_start_failed';
/** Error body of every account/session endpoint. `pendingSessionId` accompanies `login_pending` (409). */
export interface AccountErrorResponse {
	error: string;
	code: AccountErrorCode;
	pendingSessionId?: string;
}

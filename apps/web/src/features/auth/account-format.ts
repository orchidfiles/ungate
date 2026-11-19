import type { SubscriptionAccount } from '@ungate/shared/frontend';

/** Usage-limit reasons produced by the API's usage-limit classifier (also stored as cooldown reasons). */
const knownLimitReasons: Record<string, string> = {
	anthropic_usage_limit: 'Claude usage limit reached',
	codex_usage_limit_reached: 'ChatGPT usage limit reached',
	codex_rate_limit_window_exhausted: 'ChatGPT rate-limit window used up',
	usage_limit: 'Usage limit reached'
};

/** Selection changes recorded by account management and the fallback coordinator. */
const knownSwitchReasons: Record<string, string> = {
	...knownLimitReasons,
	manual: 'selected manually',
	first_account: 'first saved account selected automatically',
	removed: 'previous active account was removed',
	auto_recover: 'an available account was selected automatically',
	cooling_down: 'previous account is cooling down after a usage limit',
	needs_login: 'previous account needs to sign in again',
	no_credentials: 'previous account had no usable login'
};

/** `anthropic_usage_limit_<window>[_<window>…]` names the rejected Claude windows, e.g. `5h`, `7d`. */
const ANTHROPIC_WINDOW_REASON = /^anthropic_usage_limit_(.+)$/;

function humanize(value: string): string {
	return value.replace(/[_-]+/g, ' ').trim();
}

function formatLimitReason(reason: string): string | undefined {
	const known = knownLimitReasons[reason];

	if (known) {
		return known;
	}

	const windows = ANTHROPIC_WINDOW_REASON.exec(reason)?.[1];

	if (!windows) {
		return undefined;
	}

	const list = windows.split('_').filter(Boolean).join(', ');

	return `Claude usage limit reached (${list} window${windows.includes('_') ? 's' : ''})`;
}

/** Reasons are free-form server strings; known ones get friendly wording, others are shown humanized. */
export function formatSwitchReason(reason: string): string {
	const limit = formatLimitReason(reason);

	return limit ? `${limit} on the previous account` : (knownSwitchReasons[reason] ?? humanize(reason));
}

export function formatCooldownReason(reason: string): string {
	return formatLimitReason(reason) ?? knownSwitchReasons[reason] ?? humanize(reason);
}

function formatClock(timestamp: number, now: number): string {
	const date = new Date(timestamp);
	const sameDay = new Date(now).toDateString() === date.toDateString();

	return sameDay
		? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
		: date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatRemaining(ms: number): string {
	const minutes = Math.ceil(ms / 60_000);

	if (minutes < 1) {
		return 'less than a minute';
	}

	if (minutes < 60) {
		return `${minutes} min`;
	}

	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;

	if (hours < 24) {
		return rest ? `${hours} h ${rest} min` : `${hours} h`;
	}

	const days = Math.floor(hours / 24);

	return `${days} d ${hours % 24} h`;
}

/** e.g. "Retry after 14:05 (in 12 min)" — estimated resets are labelled as such, never as a known quota reset. */
export function formatCooldown(account: SubscriptionAccount, now: number): string | null {
	if (account.cooldownUntil === null || account.cooldownUntil <= now) {
		return null;
	}

	const when = `${formatClock(account.cooldownUntil, now)} (in ${formatRemaining(account.cooldownUntil - now)})`;

	return account.cooldownEstimated ? `Estimated retry after ${when}` : `Limit resets ${when}`;
}

export function accountSubtitle(account: SubscriptionAccount): string | null {
	return account.email && account.email !== account.label ? account.email : null;
}

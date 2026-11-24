import { TUNNEL_HOSTNAME_BLOCKED_WORDS } from './tunnel-hostname-words';

/**
 * Tunnel hostnames are random words picked by the provider, not by Ungate. This screen decides
 * whether one may be shown to the user and hides rejected ones in provider output.
 */
export class TunnelHostnameScreen {
	public static readonly redactedLabel = 'hidden-hostname';

	private static readonly blockedWords: ReadonlySet<string> = new Set(TUNNEL_HOSTNAME_BLOCKED_WORDS);
	private static readonly providerHostnamePattern = /([a-z0-9-]+)(\.trycloudflare\.com|\.ngrok[a-z0-9-]*(?:\.[a-z0-9-]+)+)/gi;

	/** Accepts a URL or a bare hostname. Only whole hyphen-separated tokens of the first label count. */
	public static isAcceptable(url: string): boolean {
		const label = this.firstLabel(url);

		if (label === null) {
			return true;
		}

		return this.isAcceptableLabel(label);
	}

	/** Replaces the random label of every rejected provider hostname found in `text`. */
	public static redact(text: string): string {
		return text.replace(this.providerHostnamePattern, (match: string, label: string, suffix: string) => {
			return this.isAcceptableLabel(label) ? match : `${this.redactedLabel}${suffix}`;
		});
	}

	private static isAcceptableLabel(label: string): boolean {
		return !label
			.toLowerCase()
			.split('-')
			.some((token) => this.blockedWords.has(token));
	}

	private static firstLabel(url: string): string | null {
		const trimmed = url.trim();

		if (!trimmed) {
			return null;
		}

		try {
			const hostname = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;

			return hostname.split('.')[0] || null;
		} catch {
			return null;
		}
	}
}
